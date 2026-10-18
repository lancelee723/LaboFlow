/**
 * Which page Electron windows load, and which renderer origins stay trusted.
 *
 * `ELECTRON_RENDERER_URL` is how electron-vite points a development host at
 * its renderer dev server. Every read used to be unconditional, so a packaged
 * build followed the variable too: a leftover value in the login session's
 * launchd environment (an old toolchain's `launchctl setenv` survives there)
 * sent the shipping app to `loadURL` that address, and with nothing listening
 * the main window died on `ERR_CONNECTION_REFUSED` — the 0.21.0-beta.3
 * white-screen boot. Letting the environment choose the page of a window that
 * carries the preload bridge is also a privilege leak, not only a boot bug:
 * whoever controls the variable controls a page that talks to the app's IPC
 * surface.
 *
 * A packaged installation therefore never consults the variable and always
 * loads the bundled `out/renderer/index.html`. Development keeps today's
 * behavior — `electron-vite dev`, the E2E harnesses that run `out/` through
 * the `electron` CLI, and the capture rig that sets the variable (or sets it
 * empty to force the bundled page) all keep working, because `app.isPackaged`
 * is false for every one of them.
 */

/** The environment variables this module reads; structural so tests pass plain objects. */
export type DevRendererEnv = {
  ELECTRON_RENDERER_URL?: string;
};

export type DevRendererOriginInput = {
  /** True for a packaged installation (`app.isPackaged`). */
  isPackaged: boolean;
  /** The process environment; read, never written. */
  env: DevRendererEnv;
};

/**
 * The dev-server origin a window may load and navigate to, or undefined when
 * none is trusted. A packaged build returns undefined unconditionally: the
 * dev server is not part of a shipping installation, and neither its page nor
 * navigation toward it may be honored. An empty or unset variable also
 * returns undefined, which is how the capture rig forces the bundled page in
 * a development host.
 */
export function resolveDevRendererOrigin({
  isPackaged,
  env,
}: DevRendererOriginInput): string | undefined {
  if (isPackaged) return undefined;
  return env.ELECTRON_RENDERER_URL || undefined;
}

/** What a window loads at creation: the dev server page or the bundled one. */
export type RendererLoadTarget =
  | { kind: "url"; url: string }
  | {
      kind: "file";
      /** Absolute path of the bundled renderer page. */
      file: string;
      /**
       * The variable a packaged build refused, present only when one was set.
       * The caller logs it once — the one line that turns a white screen into
       * a diagnosis.
       */
      ignoredDevUrl?: string;
    };

export type RendererLoadTargetInput = DevRendererOriginInput & {
  /** Absolute path of the bundled renderer page (`out/renderer/index.html`). */
  rendererFile: string;
};

/**
 * The page a window loads, derived from the same decision as
 * `resolveDevRendererOrigin` so the load branches and the navigation and
 * trust checks can never disagree about whether a dev server exists.
 */
export function resolveRendererLoadTarget({
  isPackaged,
  env,
  rendererFile,
}: RendererLoadTargetInput): RendererLoadTarget {
  const devUrl = env.ELECTRON_RENDERER_URL;
  if (isPackaged) {
    return devUrl
      ? { kind: "file", file: rendererFile, ignoredDevUrl: devUrl }
      : { kind: "file", file: rendererFile };
  }
  return devUrl
    ? { kind: "url", url: devUrl }
    : { kind: "file", file: rendererFile };
}
