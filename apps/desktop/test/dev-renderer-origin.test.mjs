import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveDevRendererOrigin,
  resolveRendererLoadTarget,
} from "../electron/main/bootstrap/dev-renderer.ts";
import { readMainModuleSync } from "./helpers/source-contracts.mjs";

const DEV_URL = "http://localhost:5173/";
const RENDERER_FILE = "/Applications/LaboFlow.app/Contents/Resources/app/out/renderer/index.html";

test("a packaged build ignores ELECTRON_RENDERER_URL", () => {
  assert.equal(
    resolveDevRendererOrigin({ isPackaged: true, env: { ELECTRON_RENDERER_URL: DEV_URL } }),
    undefined,
  );
});

test("a development build trusts the dev server origin when the variable is set", () => {
  assert.equal(
    resolveDevRendererOrigin({ isPackaged: false, env: { ELECTRON_RENDERER_URL: DEV_URL } }),
    DEV_URL,
  );
});

test("a development build without the variable has no trusted dev origin", () => {
  assert.equal(resolveDevRendererOrigin({ isPackaged: false, env: {} }), undefined);
});

test("an empty variable keeps the bundled page in development", () => {
  // The capture rig sets `ELECTRON_RENDERER_URL=` to force the bundled page.
  assert.equal(
    resolveDevRendererOrigin({ isPackaged: false, env: { ELECTRON_RENDERER_URL: "" } }),
    undefined,
  );
});

test("a packaged boot with the variable set still loads the bundled page", () => {
  // The white-screen regression: a leftover launchd variable sent the
  // shipping app to a dev-server URL. The load decision — not just the
  // origin helper — must pick the built-in file.
  const target = resolveRendererLoadTarget({
    isPackaged: true,
    env: { ELECTRON_RENDERER_URL: DEV_URL },
    rendererFile: RENDERER_FILE,
  });
  assert.deepEqual(target, { kind: "file", file: RENDERER_FILE, ignoredDevUrl: DEV_URL });
});

test("a development boot still loads the dev server when the variable is set", () => {
  const target = resolveRendererLoadTarget({
    isPackaged: false,
    env: { ELECTRON_RENDERER_URL: DEV_URL },
    rendererFile: RENDERER_FILE,
  });
  assert.deepEqual(target, { kind: "url", url: DEV_URL });
});

test("a development boot without the variable loads the bundled page", () => {
  const target = resolveRendererLoadTarget({
    isPackaged: false,
    env: {},
    rendererFile: RENDERER_FILE,
  });
  assert.deepEqual(target, { kind: "file", file: RENDERER_FILE });
});

test("the dev renderer URL is read only inside the helper module", () => {
  const helper = readMainModuleSync("bootstrap/dev-renderer.ts");
  assert.match(helper, /ELECTRON_RENDERER_URL/);
  for (const modulePath of [
    "bootstrap/window.ts",
    "bootstrap/launcher.ts",
    "live-voice/owner.ts",
  ]) {
    const source = readMainModuleSync(modulePath);
    assert.doesNotMatch(
      source,
      /process\.env\.ELECTRON_RENDERER_URL/,
      `${modulePath} reads ELECTRON_RENDERER_URL directly instead of the helper`,
    );
  }
});

test("both load branches and the renderer trust check consume the helper", () => {
  const windowSource = readMainModuleSync("bootstrap/window.ts");
  assert.match(windowSource, /resolveRendererLoadTarget\(/);
  assert.match(windowSource, /resolveDevRendererOrigin\(/);
  const launcherSource = readMainModuleSync("bootstrap/launcher.ts");
  assert.match(launcherSource, /resolveRendererLoadTarget\(/);
  assert.match(launcherSource, /resolveDevRendererOrigin\(/);
  const ownerSource = readMainModuleSync("live-voice/owner.ts");
  assert.match(ownerSource, /resolveDevRendererOrigin\(/);
});

test("a packaged build that ignores the variable says so in the runtime log", () => {
  const windowSource = readMainModuleSync("bootstrap/window.ts");
  assert.match(windowSource, /dev\.renderer\.url\.ignored/);
  assert.match(windowSource, /logger\.app\("runtime", "warn"/);
  assert.match(windowSource, /renderer\.load\.failed/);
});
