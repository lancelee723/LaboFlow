#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_NAME = "LaboFlow";
const DEV_BUNDLE_ID = "com.laboflow.app.dev";
const BRANDING_SCHEMA = "v2";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP_ROOT = join(ROOT, "apps", "desktop");

function resolvePackagePath(packageName) {
  const require = createRequire(join(DESKTOP_ROOT, "package.json"));
  return require.resolve(`${packageName}/package.json`);
}

function resolveElectronInstallation() {
  const packagePath = resolvePackagePath("electron");
  const version = JSON.parse(readFileSync(packagePath, "utf8")).version;
  const require = createRequire(join(DESKTOP_ROOT, "package.json"));
  const executable = require("electron");
  return {
    executablePath: executable,
    version,
  };
}

function setPlistString(plistPath, key, value) {
  execFileSync("plutil", ["-replace", key, "-string", value, plistPath]);
}

export function prepareMacDevelopmentBundle({
  electronExecutable,
  electronVersion,
  appVersion,
  iconPath,
  cacheRoot,
  sign = true,
}) {
  const sourceBundle = dirname(dirname(dirname(electronExecutable)));
  const iconHash = createHash("sha256")
    .update(readFileSync(iconPath))
    .digest("hex")
    .slice(0, 12);
  // The app version rides the cache key: a version bump must rebuild the
  // dev bundle or app.getVersion() keeps reporting the baked old version.
  const cacheKey = `${electronVersion}-${appVersion}-${iconHash}-${BRANDING_SCHEMA}`;
  const targetRoot = join(cacheRoot, cacheKey);
  const targetBundle = join(targetRoot, `${APP_NAME}.app`);
  const targetExecutable = join(
    targetBundle,
    "Contents",
    "MacOS",
    APP_NAME,
  );
  const markerPath = join(targetRoot, "ready.json");

  if (existsSync(markerPath) && existsSync(targetExecutable)) {
    return targetExecutable;
  }

  mkdirSync(cacheRoot, { recursive: true });
  const stagingRoot = join(cacheRoot, `${cacheKey}.staging-${process.pid}`);
  const stagingBundle = join(stagingRoot, `${APP_NAME}.app`);
  rmSync(stagingRoot, { recursive: true, force: true });

  try {
    cpSync(sourceBundle, stagingBundle, {
      recursive: true,
      verbatimSymlinks: true,
    });

    const contents = join(stagingBundle, "Contents");
    const macos = join(contents, "MacOS");
    const resources = join(contents, "Resources");
    const sourceExecutable = join(macos, "Electron");
    const brandedExecutable = join(macos, APP_NAME);
    renameSync(sourceExecutable, brandedExecutable);
    copyFileSync(iconPath, join(resources, "icon.icns"));

    const plistPath = join(contents, "Info.plist");
    setPlistString(plistPath, "CFBundleDisplayName", APP_NAME);
    setPlistString(plistPath, "CFBundleName", APP_NAME);
    setPlistString(plistPath, "CFBundleExecutable", APP_NAME);
    setPlistString(plistPath, "CFBundleIdentifier", DEV_BUNDLE_ID);
    setPlistString(plistPath, "CFBundleIconFile", "icon.icns");
    setPlistString(plistPath, "CFBundleShortVersionString", appVersion);
    setPlistString(plistPath, "CFBundleVersion", appVersion);

    if (sign) {
      // macOS no longer supports `codesign --deep` reliably on Electron
      // app bundles (returns "bundle format is ambiguous" on frameworks).
      // The bundled frameworks are already signed by Electron; we only
      // need to re-sign the top-level app since we changed Info.plist.
      execFileSync("codesign", [
        "--force",
        "--sign",
        "-",
        "--identifier",
        DEV_BUNDLE_ID,
        stagingBundle,
      ]);
    }

    writeFileSync(
      join(stagingRoot, "ready.json"),
      `${JSON.stringify({ electronVersion, iconHash })}\n`,
    );
    renameSync(stagingRoot, targetRoot);
    return targetExecutable;
  } catch (error) {
    const cacheWonRace =
      (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") &&
      existsSync(markerPath) &&
      existsSync(targetExecutable);
    rmSync(stagingRoot, { recursive: true, force: true });
    if (cacheWonRace) return targetExecutable;
    throw error;
  }
}

function run() {
  const env = { ...process.env, PI_DESKTOP_DEV: "1" };
  // Electron 43+ downloads its platform binary when its package is resolved.
  // electron-vite requires the resulting path.txt marker on every platform.
  const electron = resolveElectronInstallation();
  const appVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  if (process.platform === "darwin") {
    env.ELECTRON_EXEC_PATH = prepareMacDevelopmentBundle({
      electronExecutable: electron.executablePath,
      electronVersion: electron.version,
      appVersion,
      iconPath: join(DESKTOP_ROOT, "build", "icon.icns"),
      cacheRoot: join(ROOT, ".cache", "electron-dev"),
    });
  }

  const electronVitePackage = resolvePackagePath("electron-vite");
  const electronViteCli = join(
    dirname(electronVitePackage),
    "bin",
    "electron-vite.js",
  );
  const child = spawn(
    process.execPath,
    [electronViteCli, "dev", ...process.argv.slice(2)],
    {
      cwd: DESKTOP_ROOT,
      env,
      stdio: "inherit",
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run();
