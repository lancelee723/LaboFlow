/**
 * PDF Tools — bundled first-party plugin (ADR 0312, plugin carrier per ADR
 * 0313). The vendored pdf.js engine reads documents locally: text layers for
 * digital pages, decoded page bitmaps as model-visible images for scanned
 * pages when the session model has vision, and the user-configured MinerU
 * endpoint (Settings → plugin settings) as the opt-in OCR backend otherwise.
 *
 * Like laboflow.slides, this plugin runs as trusted first-party code: the
 * engine reads only the host-owned session roots (workspace, session
 * scratch, content-addressed attachments) through lib/paths.js containment.
 */
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

import {
  parsePageSpec,
  pdfPageCount,
  PdfEncryptedError,
  PdfInvalidError,
  readPdf,
} from "./lib/engine.js";
import { parseWithMineru } from "./lib/mineru.js";
import { dataDirFromPluginDataPath, resolvePdfPath } from "./lib/paths.js";

/** Aligned with MinerU's own hard ceiling; refused earlier to keep errors local. */
const MAX_PDF_BYTES = 200 * 1024 * 1024;
/** MinerU markdown window per call, aligned with the engine's text budget. */
const MINERU_MARKDOWN_CHAR_LIMIT = 80000;

const ENDPOINT_PATTERN = /^https?:\/\/[^\s/]+(:\d+)?(\/[^\s]*)?$/;

function normalizeMineruSettings(settings) {
  let endpoint =
    typeof settings?.mineruEndpoint === "string"
      ? settings.mineruEndpoint.trim().replace(/\/+$/, "")
      : "";
  // A pasted full endpoint (e.g. https://mineru.net/api/v4/extract/task) is a
  // common slip: the client appends its own /api/v4/... paths, so only the
  // base origin is meaningful. The extract/task endpoint also cannot upload
  // local files, so the paste never works as-is.
  const apiAt = endpoint.indexOf("/api/v");
  if (apiAt > 0) endpoint = endpoint.slice(0, apiAt);
  const apiKey =
    typeof settings?.mineruApiKey === "string" ? settings.mineruApiKey.trim() : "";
  if (!ENDPOINT_PATTERN.test(endpoint)) return undefined;
  return { endpoint, apiKey };
}

let toolsRegistered = false;

export async function onLoad() {
  const mineruFetch = (input) => pi.net.fetch(input);

  toolsRegistered = true;
  void pi.agent.registerTool({
    name: "read",
    description:
      "Read a PDF document page by page. Digital pages return their text layer; image-only (scanned) pages return a model-visible page image when the current model has vision. `path` follows the Read rules (workspace-relative, absolute inside the session scratch, or an attachments reference). `pages` selects a 1-based window such as 5-12,30; defaults to the first window of a large document. `password` is needed only when the tool reports the document is encrypted - ask the user for it and retry. Scanned pages that cannot be imaged are parsed through the configured MinerU endpoint, if any. Always pass action: \"read\".",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", const: "read", description: "Always \"read\"." },
        path: {
          type: "string",
          description: "Existing PDF file; workspace-relative or explicitly approved.",
        },
        pages: {
          type: "string",
          description:
            "1-based page window, for example 5-12,30. Defaults to the first window of the document.",
        },
        password: {
          type: "string",
          description:
            "Password for an encrypted PDF; supply on retry when the tool reports encryption.",
        },
      },
      required: ["path"],
    },
    execute: async (args, ctx) => {
      const rawPath = typeof args?.path === "string" ? args.path.trim() : "";
      if (!rawPath) {
        return { content: "PDF read: `path` is required.", isError: true };
      }
      const workspace = await pi.workspace.get();
      const pluginDataPath = await pi.plugin.getDataPath();
      const dataDir = dataDirFromPluginDataPath(pluginDataPath);
      const source = resolvePdfPath({
        path: rawPath,
        workspacePath: workspace?.path,
        dataDir,
        sessionId: ctx?.sessionId,
      });
      if (!source) {
        return {
          content:
            `PDF read: "${rawPath}" does not resolve to an existing PDF inside the workspace, ` +
            "session scratch, or attachments roots.",
          isError: true,
        };
      }
      const name = basename(source.absolute);
      const size = (await stat(source.absolute)).size;
      if (size > MAX_PDF_BYTES) {
        return {
          content: `PDF read: ${name} is ${Math.round(size / 1024 / 1024)}MB; the ceiling is 200MB.`,
          isError: true,
        };
      }
      const data = new Uint8Array(await readFile(source.absolute));
      const settings = await pi.plugin.getSettings();
      const mineru = normalizeMineruSettings(settings);
      const vision = ctx?.supportsVision === true;
      const password = typeof args?.password === "string" ? args.password : undefined;
      const pagesSpec = typeof args?.pages === "string" ? args.pages : undefined;

      let result;
      try {
        const totalPages = await pdfPageCount(data, password);
        const spec = pagesSpec ? parsePageSpec(pagesSpec, totalPages) : undefined;
        if (spec?.error) {
          return { content: `PDF read: ${spec.error}`, isError: true };
        }
        result = await readPdf({
          // pdf.js takes ownership of the buffer handed to getDocument (the
          // page-count probe transfer/detaches it), so the read re-reads bytes.
          data: new Uint8Array(await readFile(source.absolute)),
          ...(spec?.pages ? { pages: spec.pages } : {}),
          ...(password ? { password } : {}),
          includeImages: vision,
        });
      } catch (error) {
        if (error instanceof PdfEncryptedError) {
          return {
            content: error.needsPassword
              ? `${name} is password-protected. Ask the user for the password, then call plugin_laboflow_pdf_read again with \`password\`.`
              : `The password for ${name} was rejected. Ask the user for the correct password and retry.`,
            isError: true,
          };
        }
        if (error instanceof PdfInvalidError) {
          return { content: `PDF read: ${name} is not a readable PDF.`, isError: true };
        }
        return { content: `PDF read: reading ${name} failed: ${error?.message ?? error}`, isError: true };
      }

      const images = [];
      const textParts = [
        `PDF ${name}: ${result.totalPages} pages` +
          (result.metadata.title ? ` — "${result.metadata.title}"` : "") +
          (result.metadata.author ? ` — ${result.metadata.author}` : ""),
      ];
      if (result.textTruncated) {
        textParts.push("Note: text output hit the per-call budget; narrow `pages` for full content.");
      }
      if (result.pagesTruncated && !pagesSpec) {
        textParts.push(
          `Note: showing the first ${result.pages.length} of ${result.totalPages} pages; use \`pages\` for the rest.`,
        );
      }
      const needsMineru = [];
      for (const page of result.pages) {
        if (page.kind === "text") {
          textParts.push(`\n--- page ${page.page} (text) ---\n${page.text ?? ""}`);
          continue;
        }
        if (page.image) {
          images.push(page.image);
          textParts.push(`\n--- page ${page.page} (scanned; image attached) ---`);
          continue;
        }
        needsMineru.push(String(page.page));
        const reason =
          page.skipped === "vision-unavailable"
            ? "current model cannot see images"
            : page.skipped === "image-budget"
              ? "per-call image cap reached"
              : "page bitmap could not be recovered";
        textParts.push(`\n--- page ${page.page} (scanned; ${reason}) ---`);
      }

      if (needsMineru.length) {
        if (!mineru) {
          textParts.push(
            `\n[pages ${needsMineru.join(", ")} are scanned and could not be read locally: ` +
              (vision
                ? "their bitmaps did not decode."
                : "the current model has no vision.") +
              " A MinerU endpoint in this plugin's settings can parse them — ask the user to configure it.]",
          );
        } else {
          try {
            const markdown = await parseWithMineru(mineru, {
              fileName: name,
              data,
              signal: ctx?.signal,
              fetchImpl: mineruFetch,
            });
            const clipped = markdown.slice(0, MINERU_MARKDOWN_CHAR_LIMIT);
            textParts.push(
              `\n--- MinerU extraction (scanned pages ${needsMineru.join(", ")}) ---\n${clipped}` +
                (markdown.length > clipped.length ? "\n[truncated]" : ""),
            );
          } catch (error) {
            textParts.push(
              `\n[MinerU extraction failed for pages ${needsMineru.join(", ")}: ` +
                `${error?.message ?? error}. The local reading above is unaffected.]`,
            );
          }
        }
      }

      return {
        content: {
          text: textParts.join("\n"),
          totalPages: result.totalPages,
          readPages: result.pages.map((page) => page.page),
          ...(images.length ? { images } : {}),
        },
        details: {
          totalPages: result.totalPages,
          readPages: result.pages.length,
          scannedPages: result.pages.filter((page) => page.kind === "scanned").length,
          images: images.length,
          vision,
          mineruConfigured: Boolean(mineru),
        },
      };
    },
  });
}

export function onUnload() {
  toolsRegistered = false;
}
