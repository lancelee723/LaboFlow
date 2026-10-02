/**
 * T52.5 web clipping: load a user-typed URL in a hidden offscreen window,
 * run the vendored Readability against the live DOM, and hand back a clean
 * article snapshot (title + content HTML) for a team-space html node.
 *
 * SSRF posture: the URL must be http(s) with no embedded credentials; the
 * navigation itself goes through the default session, so the same network
 * policy that governs the built-in browser applies (ADR 0177/0272). The
 * window is hidden and sandboxed, and destroyed no matter how the parse ends.
 */

import readabilitySource from "./vendor/readability/Readability.js?raw";

const READABILITY_TIMEOUT_MS = 20_000;
const MAX_ARTICLE_BYTES = 2_000_000;

export type ClipResult = {
  url: string;
  title: string;
  contentHtml: string;
  textContent: string;
  byline: string;
  clippedAt: string;
};

/** Parse-time guard: only http(s), no credentials, sane length. */
export function validateClipUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw Object.assign(new Error("invalid url"), { errorCode: "INVALID_ARGUMENT" });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw Object.assign(new Error("only http(s) urls can be clipped"), {
      errorCode: "INVALID_ARGUMENT",
    });
  }
  if (parsed.username || parsed.password) {
    throw Object.assign(new Error("urls with credentials cannot be clipped"), {
      errorCode: "INVALID_ARGUMENT",
    });
  }
  return parsed;
}

export async function clipWebPage(rawUrl: string): Promise<ClipResult> {
  const url = validateClipUrl(rawUrl);
  const clippedAt = new Date().toISOString();

  // Lazy: keep the pure guards importable outside electron (tests).
  const { BrowserWindow } = await import("electron");
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      images: false,
    },
  });
  const timeout = setTimeout(() => window.destroy(), READABILITY_TIMEOUT_MS);
  try {
    await window.loadURL(url.toString(), { userAgent: "LaboFlowClipper/1.0" });
    const injected = (await window.webContents.executeJavaScript(
      `(() => {
        try {
          ${readabilitySource}
          const uri = ${JSON.stringify({
            spec: url.toString(),
            host: url.host,
            prePath: url.origin,
            pathQuery: url.pathname + url.search,
          })};
          const documentClone = document.cloneNode(true);
          const article = new Readability(documentClone, { uri }).parse();
          if (!article) return { error: "page is not readable" };
          return {
            title: article.title || document.title || "",
            contentHtml: article.content || "",
            textContent: article.textContent || "",
            byline: article.byline || "",
          };
        } catch (error) {
          return { error: String(error && error.message ? error.message : error) };
        }
      })()`,
      true,
    )) as
      | { error?: string; title?: string; contentHtml?: string; textContent?: string; byline?: string }
      | undefined;
    if (!injected || typeof injected.error === "string") {
      throw Object.assign(
        new Error(injected?.error ?? "page could not be parsed"),
        { errorCode: "CLIP_PARSE_FAILED" },
      );
    }
    const article = injected as {
      title?: string;
      contentHtml?: string;
      textContent?: string;
      byline?: string;
    };
    return {
      url: url.toString(),
      title: article.title || url.host,
      contentHtml: article.contentHtml ?? "",
      textContent: (article.textContent ?? "").slice(0, 100_000),
      byline: article.byline ?? "",
      clippedAt,
    };
  } finally {
    clearTimeout(timeout);
    window.destroy();
  }
}
