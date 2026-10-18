import type { BrowserWindow, Session, WebContents } from "electron";
import { liveOwnerFromWebContents, isTrustedRendererUrl, type RendererBuild } from "./owner";
import type { LiveOwner } from "./call-service";

type PermissionDecision = {
  permission: string;
  ownerValid: boolean;
  leaseActive: boolean;
  requestKind: "request" | "check";
  mediaTypes?: readonly string[];
  mediaType?: string;
};

export function allowsLiveMicrophonePermission(input: PermissionDecision): boolean {
  if (input.permission !== "media" || !input.ownerValid || !input.leaseActive) return false;
  if (input.requestKind === "request") {
    return Boolean(input.mediaTypes?.length) && input.mediaTypes?.every((type) => type === "audio") === true;
  }
  return input.mediaType === "audio" || input.mediaType === "unknown";
}

export function installLiveMicrophonePermissionHandlers(input: {
  targetSession: Session;
  getMainWindow: () => BrowserWindow | null;
  hasReservation: (owner: LiveOwner) => boolean;
  /** `app.isPackaged`; a packaged build trusts only the bundled renderer page. */
  isPackaged: boolean;
}): void {
  const build: RendererBuild = { isPackaged: input.isPackaged };
  input.targetSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const owner = requestOwner(input.getMainWindow(), contents, details.requestingUrl, details.isMainFrame, build);
    const allowed = allowsLiveMicrophonePermission({
      permission,
      ownerValid: owner !== null,
      leaseActive: owner !== null && input.hasReservation(owner),
      requestKind: "request",
      mediaTypes: "mediaTypes" in details ? details.mediaTypes : undefined,
    });
    callback(allowed);
  });

  input.targetSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    const owner = contents ? checkOwner(input.getMainWindow(), contents, requestingOrigin, build) : null;
    return allowsLiveMicrophonePermission({
      permission,
      ownerValid: owner !== null,
      leaseActive: owner !== null && input.hasReservation(owner),
      requestKind: "check",
      mediaType: details.mediaType,
    });
  });
}

function requestOwner(
  window: BrowserWindow | null,
  contents: WebContents,
  requestingUrl: string,
  isMainFrame: boolean,
  build: RendererBuild,
): LiveOwner | null {
  if (!isMainFrame) return null;
  const owner = liveOwnerFromWebContents(window, contents, build);
  return owner && owner.url === requestingUrl ? owner : null;
}

function checkOwner(
  window: BrowserWindow | null,
  contents: WebContents,
  requestingOrigin: string,
  build: RendererBuild,
): LiveOwner | null {
  const owner = liveOwnerFromWebContents(window, contents, build);
  if (!owner || !isTrustedRendererUrl(owner.url, build)) return null;
  let protocol: string;
  let origin: string;
  try {
    const parsed = new URL(owner.url);
    protocol = parsed.protocol;
    origin = parsed.origin;
  } catch {
    return null;
  }
  const validOrigin = protocol === "file:"
    ? requestingOrigin === "file://" || requestingOrigin === "null"
    : requestingOrigin === origin;
  return validOrigin ? owner : null;
}
