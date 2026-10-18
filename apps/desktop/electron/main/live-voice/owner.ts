import type { BrowserWindow, IpcMainInvokeEvent, WebFrameMain } from "electron";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { WebContents } from "electron";
import type { LiveOwner } from "./call-service";
import { resolveDevRendererOrigin } from "../bootstrap/dev-renderer";

/**
 * Whether this process is a packaged installation. Callers pass `app.isPackaged`
 * because the value lives on Electron's `app`, and this module must stay
 * loadable without Electron: its tests run it under plain Node. A packaged
 * build trusts no dev-server origin, only the bundled renderer page
 * (`../bootstrap/dev-renderer`).
 */
export type RendererBuild = { isPackaged: boolean };

export function liveOwnerFromInvoke(
  event: IpcMainInvokeEvent,
  mainWindow: BrowserWindow | null,
  build: RendererBuild,
): LiveOwner {
  const frame = event.senderFrame;
  if (
    !mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed() ||
    event.sender !== mainWindow.webContents || !frame || frame !== event.sender.mainFrame ||
    frame !== mainWindow.webContents.mainFrame || frame.url !== event.sender.getURL() ||
    !isTrustedRendererUrl(frame.url, build)
  ) {
    throw Object.assign(new Error("Live Voice is available only in the trusted main window"), { errorCode: "LIVE_INVALID_OWNER" });
  }
  return {
    webContentsId: event.sender.id,
    frameProcessId: frame.processId,
    frameRoutingId: frame.routingId,
    url: frame.url,
  };
}

export function liveOwnerFrame(
  mainWindow: BrowserWindow | null,
  owner: LiveOwner,
  build: RendererBuild,
): WebFrameMain | null {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return null;
  const frame = mainWindow.webContents.mainFrame;
  if (
    mainWindow.webContents.id !== owner.webContentsId ||
    frame.processId !== owner.frameProcessId ||
    frame.routingId !== owner.frameRoutingId ||
    frame.url !== mainWindow.webContents.getURL() ||
    !isTrustedRendererUrl(frame.url, build)
  ) return null;
  return frame;
}

export function liveOwnerFromWebContents(
  mainWindow: BrowserWindow | null,
  contents: WebContents,
  build: RendererBuild,
): LiveOwner | null {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed() || contents !== mainWindow.webContents || contents.isDestroyed()) return null;
  const frame = contents.mainFrame;
  if (frame.url !== contents.getURL() || !isTrustedRendererUrl(frame.url, build)) return null;
  return {
    webContentsId: contents.id,
    frameProcessId: frame.processId,
    frameRoutingId: frame.routingId,
    url: frame.url,
  };
}

export function isTrustedRendererUrl(value: string, build: RendererBuild): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "file:") {
      if (url.search || url.hash) return false;
      return resolve(fileURLToPath(url)) === resolve(__dirname, "../../renderer/index.html");
    }
    if (url.protocol !== "http:") return false;
    const configured = resolveDevRendererOrigin({
      isPackaged: build.isPackaged,
      env: process.env,
    });
    if (!configured) return false;
    const expected = new URL(configured);
    return expected.protocol === "http:" && !expected.username && !expected.password &&
      url.origin === expected.origin && url.pathname === expected.pathname && !url.username && !url.password;
  } catch {
    return false;
  }
}
