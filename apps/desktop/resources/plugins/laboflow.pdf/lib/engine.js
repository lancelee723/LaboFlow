/**
 * PDFRead engine (ADR 0312, plugin-carried since ADR 0313).
 *
 * Layered, per-page reading with no dependency beyond the vendored pdf.js
 * build: text-layer extraction for digital pages; decoded operator-list
 * bitmaps re-encoded as PNG through node:zlib for scanned pages. Decisions
 * and budgets mirror the superseded host-runtime module; this is the only
 * copy now.
 */
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { downscale, encodePng } from "./png.js";

/** A page whose text layer has fewer meaningful characters is "scanned". */
export const TEXT_PAGE_MIN_CHARS = 24;
/** Long-edge cap for a page image before it enters model context. */
export const IMAGE_MAX_LONG_EDGE = 1600;

export const DEFAULT_ENGINE_LIMITS = {
  maxPages: 30,
  perPageChars: 20000,
  totalChars: 120000,
  maxImages: 3,
  maxImageBase64Bytes: 1800000,
};

export class PdfEncryptedError extends Error {
  constructor(needsPassword, wrongPassword) {
    super(
      needsPassword
        ? "PDF document is password-protected; retry with the user's password"
        : "PDF password was rejected; ask the user for the correct password",
    );
    this.name = "PdfEncryptedError";
    this.needsPassword = needsPassword;
    this.wrongPassword = wrongPassword;
  }
}

export class PdfInvalidError extends Error {
  constructor(message) {
    super(message);
    this.name = "PdfInvalidError";
  }
}

/** Parse a 1-based page spec like `1-3,7` against a document's page count. */
export function parsePageSpec(spec, totalPages) {
  const trimmed = (spec ?? "").trim();
  if (!trimmed) return {};
  const pages = [];
  for (const partRaw of trimmed.split(",")) {
    const part = partRaw.trim();
    if (!part) return { error: `empty page in spec: ${JSON.stringify(spec)}` };
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from < 1 || to < from) return { error: `invalid page range: ${part}` };
      for (let page = from; page <= Math.min(to, totalPages); page++) pages.push(page);
      continue;
    }
    if (!/^\d+$/.test(part)) return { error: `invalid page: ${part}` };
    const page = Number(part);
    if (page < 1 || page > totalPages) {
      return { error: `page ${page} is outside 1..${totalPages}` };
    }
    pages.push(page);
  }
  if (!pages.length) return { error: `no pages in 1..${totalPages} match ${JSON.stringify(spec)}` };
  return { pages: [...new Set(pages)].sort((a, b) => a - b) };
}

const CJK_BOUNDARY = /[\u2e80-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;

/**
 * Join pdf.js text items into readable text. A separator is only inserted
 * where both boundary characters are Latin/digit; CJK runs join directly so
 * the layer does not gain stray spaces between every glyph.
 */
export function joinTextItems(items) {
  let text = "";
  let pendingEol = false;
  for (const item of items) {
    const piece = item.str;
    if (!piece) {
      pendingEol ||= item.hasEOL === true;
      continue;
    }
    if (text) {
      if (pendingEol) {
        text += "\n";
      } else if (
        !/\s/.test(text[text.length - 1] ?? " ") &&
        !/\s/.test(piece[0] ?? " ") &&
        !CJK_BOUNDARY.test(text[text.length - 1] ?? "") &&
        !CJK_BOUNDARY.test(piece[0] ?? "")
      ) {
        text += " ";
      }
    }
    text += piece;
    pendingEol = item.hasEOL === true;
  }
  if (pendingEol) text += "\n";
  return text;
}

function meaningfulChars(text) {
  let count = 0;
  for (const char of text) {
    if (!/\s/.test(char)) count++;
  }
  return count;
}

function asByteView(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof Uint8ClampedArray) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}

function decodeObj(page, objId) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolvePromise(value);
      }
    };
    try {
      page.objs.get(objId, (obj) => {
        const bytes = asByteView(obj?.data);
        if (
          obj &&
          typeof obj.width === "number" &&
          typeof obj.height === "number" &&
          typeof obj.kind === "number" &&
          bytes &&
          bytes.length > 0
        ) {
          finish({ width: obj.width, height: obj.height, kind: obj.kind, data: bytes });
        } else {
          finish(undefined);
        }
      });
    } catch {
      finish(undefined);
    }
    setTimeout(() => finish(undefined), 5000);
  });
}

function imageToBitmap(image) {
  // pdf.js ImageKind: 2 = RGB_24BPP, 3 = RGBA_32BPP; 1 (grayscale stencil
  // masks) is not page photography.
  if (image.kind === 2) return { width: image.width, height: image.height, channels: 3, data: image.data };
  if (image.kind === 3) return { width: image.width, height: image.height, channels: 4, data: image.data };
  return undefined;
}

async function largestPageImage(page, ops) {
  let operatorList;
  try {
    operatorList = await page.getOperatorList();
  } catch {
    return undefined;
  }
  const imageFn = ops.paintImageXObject;
  const objIds = [];
  for (let i = 0; i < operatorList.fnArray.length; i++) {
    if (operatorList.fnArray[i] !== imageFn) continue;
    const arg = operatorList.argsArray[i]?.[0];
    if (typeof arg === "string") objIds.push(arg);
  }
  let best;
  let bestArea = 0;
  for (const objId of objIds) {
    const decoded = await decodeObj(page, objId);
    const bitmap = decoded ? imageToBitmap(decoded) : undefined;
    if (!bitmap) continue;
    const area = bitmap.width * bitmap.height;
    if (area > bestArea) {
      best = bitmap;
      bestArea = area;
    }
  }
  return best;
}

let pdfjsModule;

/**
 * Canvas-API skeletons for the Electron utilityProcess.
 *
 * pdf.js judges its environment by `process.type`: inside a utility process
 * ("utility") it takes the browser branch, skips its own Node polyfills, and
 * then executes module-top-level `new DOMMatrix()` — which throws in a
 * process without a DOM. We do not render, so only the classes pdf.js
 * touches at import time (and the transform methods its canvas helpers may
 * call) need to exist; they are inert for text extraction and bitmap
 * recovery.
 */
function installCanvasPolyfills() {
  class DOMMatrix {
    constructor(init) {
      this.m11 = 1; this.m12 = 0; this.m13 = 0; this.m14 = 0;
      this.m21 = 0; this.m22 = 1; this.m23 = 0; this.m24 = 0;
      this.m31 = 0; this.m32 = 0; this.m33 = 1; this.m34 = 0;
      this.m41 = 0; this.m42 = 0; this.m43 = 0; this.m44 = 1;
      if (init) {
        if (typeof init === "string") throw new TypeError("DOMMatrix: string init unsupported");
        if (init instanceof DOMMatrix) {
          this.m11 = init.m11; this.m12 = init.m12; this.m21 = init.m21; this.m22 = init.m22;
          this.m41 = init.m41; this.m42 = init.m42;
        } else if (Array.isArray(init) || init instanceof Float32Array || init instanceof Float64Array) {
          if (init.length === 6) {
            this.m11 = init[0]; this.m12 = init[1]; this.m21 = init[2]; this.m22 = init[3];
            this.m41 = init[4]; this.m42 = init[5];
          } else if (init.length === 16) {
            for (let i = 0; i < 16; i++) this[`m${Math.floor(i / 4) + 1}${(i % 4) + 1}`] = init[i];
          } else {
            throw new TypeError("DOMMatrix: init must have 6 or 16 components");
          }
        }
      }
    }
    get a() { return this.m11; } get b() { return this.m12; }
    get c() { return this.m21; } get d() { return this.m22; }
    get e() { return this.m41; } get f() { return this.m42; }
    multiplySelf(other) {
      const o = other instanceof DOMMatrix ? other : new DOMMatrix(other);
      const m11 = this.m11 * o.m11 + this.m12 * o.m21;
      const m12 = this.m11 * o.m12 + this.m12 * o.m22;
      const m21 = this.m21 * o.m11 + this.m22 * o.m21;
      const m22 = this.m21 * o.m12 + this.m22 * o.m22;
      const m41 = this.m41 * o.m11 + this.m42 * o.m21 + o.m41;
      const m42 = this.m41 * o.m12 + this.m42 * o.m22 + o.m42;
      this.m11 = m11; this.m12 = m12; this.m21 = m21; this.m22 = m22;
      this.m41 = m41; this.m42 = m42;
      return this;
    }
    preMultiplySelf(other) {
      const o = other instanceof DOMMatrix ? other : new DOMMatrix(other);
      const m11 = o.m11 * this.m11 + o.m12 * this.m21;
      const m12 = o.m11 * this.m12 + o.m12 * this.m22;
      const m21 = o.m21 * this.m11 + o.m22 * this.m21;
      const m22 = o.m21 * this.m12 + o.m22 * this.m22;
      const m41 = o.m41 * this.m11 + o.m42 * this.m21 + this.m41;
      const m42 = o.m41 * this.m12 + o.m42 * this.m22 + this.m42;
      this.m11 = m11; this.m12 = m12; this.m21 = m21; this.m22 = m22;
      this.m41 = m41; this.m42 = m42;
      return this;
    }
    translate(tx = 0, ty = 0) {
      return new DOMMatrix([1, 0, 0, 1, tx, ty]).multiplySelf(this);
    }
    scale(sx = 1, sy = sx) {
      return new DOMMatrix([sx, 0, 0, sy, 0, 0]).multiplySelf(this);
    }
    invertSelf() {
      const det = this.m11 * this.m22 - this.m12 * this.m21;
      const m11 = this.m22 / det;
      const m12 = -this.m12 / det;
      const m21 = -this.m21 / det;
      const m22 = this.m11 / det;
      const m41 = (this.m42 * this.m21 - this.m41 * this.m22) / det;
      const m42 = (this.m41 * this.m12 - this.m42 * this.m11) / det;
      this.m11 = m11; this.m12 = m12; this.m21 = m21; this.m22 = m22;
      this.m41 = m41; this.m42 = m42;
      return this;
    }
    flipX() { return new DOMMatrix([-1, 0, 0, 1, 0, 0]).multiplySelf(this); }
    flipY() { return new DOMMatrix([1, 0, 0, -1, 0, 0]).multiplySelf(this); }
  }
  if (typeof globalThis.DOMMatrix === "undefined") globalThis.DOMMatrix = DOMMatrix;
  if (typeof globalThis.Path2D === "undefined") {
    globalThis.Path2D = class Path2D {
      constructor(init) { this.segments = []; if (init) this.segments.push(String(init)); }
      addPath() {}
      moveTo() {} lineTo() {} bezierCurveTo() {} quadraticCurveTo() {}
      closePath() {} rect() {} arc() {} arcTo() {} ellipse() {}
    };
  }
  if (typeof globalThis.ImageData === "undefined") {
    globalThis.ImageData = class ImageData {
      constructor(data, width, height) {
        this.data = data;
        this.width = width;
        this.height = height ?? Math.floor(data.length / (width * 4));
      }
    };
  }
}

async function loadPdfjs() {
  if (!pdfjsModule) {
    const pluginDir = dirname(fileURLToPath(import.meta.url));
    const vendorDir = join(pluginDir, "..", "vendor", "pdfjs");
    const wasmUrl = pathToFileURL(join(vendorDir, "wasm")).href + "/";
    installCanvasPolyfills();
    const pdfjs = await import(pathToFileURL(join(vendorDir, "pdf.mjs")).href);
    // Node runs pdf.js through a fake worker resolved from workerSrc; the
    // module namespace itself is frozen, so wasmUrl rides getDocument.
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(join(vendorDir, "pdf.worker.mjs")).href;
    pdfjsModule = { module: pdfjs, wasmUrl };
  }
  return pdfjsModule;
}

async function openDocument({ module, wasmUrl }, input) {
  try {
    return await module.getDocument({
      data: input.data,
      ...(input.password ? { password: input.password } : {}),
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      wasmUrl,
    }).promise;
  } catch (error) {
    const name = error?.name;
    const code = error?.code;
    if (name === "PasswordException") {
      throw new PdfEncryptedError(code !== 2, code === 2);
    }
    if (name === "InvalidPDFException") {
      throw new PdfInvalidError("the file is not a readable PDF document");
    }
    throw error;
  }
}

/** Cheap page-count probe: parses structure without extracting content. */
export async function pdfPageCount(data, password) {
  const pdfjs = await loadPdfjs();
  const document = await openDocument(pdfjs, { data, password });
  try {
    return document.numPages;
  } finally {
    await document.destroy().catch(() => undefined);
  }
}

/** Read a window of a PDF, layer by layer (see module doc). */
export async function readPdf(input) {
  const limits = { ...DEFAULT_ENGINE_LIMITS, ...(input.limits ?? {}) };
  const pdfjs = await loadPdfjs();
  const document = await openDocument(pdfjs, input);
  try {
    let metadata = {};
    try {
      const info = (await document.getMetadata()).info;
      if (info) {
        const pick = (key) =>
          typeof info[key] === "string" && info[key].trim() ? info[key].trim() : undefined;
        metadata = {
          ...(pick("Title") ? { title: pick("Title") } : {}),
          ...(pick("Author") ? { author: pick("Author") } : {}),
          ...(pick("Producer") ? { producer: pick("Producer") } : {}),
        };
      }
    } catch {
      // Metadata is optional; unreadable metadata must not fail the read.
    }

    let requested = input.pages;
    let pagesTruncated = false;
    if (!requested) {
      requested = Array.from({ length: Math.min(document.numPages, limits.maxPages) }, (_, i) => i + 1);
      pagesTruncated = document.numPages > limits.maxPages;
    }
    const pages = [];
    let totalChars = 0;
    let images = 0;
    let textTruncated = false;
    for (const pageNumber of requested) {
      if (pages.length >= limits.maxPages) {
        pagesTruncated = true;
        break;
      }
      const page = await document.getPage(pageNumber);
      const text = joinTextItems((await page.getTextContent()).items);
      if (meaningfulChars(text) >= TEXT_PAGE_MIN_CHARS) {
        let clipped = text.slice(0, limits.perPageChars);
        if (totalChars + clipped.length > limits.totalChars) {
          clipped = clipped.slice(0, Math.max(0, limits.totalChars - totalChars));
        }
        textTruncated ||= clipped.length < text.length;
        totalChars += clipped.length;
        pages.push({ page: pageNumber, kind: "text", text: clipped });
        continue;
      }
      const outcome = { page: pageNumber, kind: "scanned" };
      if (!input.includeImages) {
        outcome.skipped = "vision-unavailable";
      } else if (images >= limits.maxImages) {
        outcome.skipped = "image-budget";
      } else {
        const bitmap = await largestPageImage(page, pdfjs.module.OPS);
        if (!bitmap) {
          outcome.skipped = "no-image-recovered";
        } else {
          const scaled = downscale(bitmap, IMAGE_MAX_LONG_EDGE);
          const encoded = encodePng(scaled).toString("base64");
          if (encoded.length > limits.maxImageBase64Bytes) {
            outcome.skipped = "no-image-recovered";
          } else {
            images++;
            outcome.image = {
              mimeType: "image/png",
              data: encoded,
              width: scaled.width,
              height: scaled.height,
            };
          }
        }
      }
      pages.push(outcome);
    }
    return {
      totalPages: document.numPages,
      metadata,
      pages,
      textTruncated,
      pagesTruncated,
    };
  } finally {
    await document.destroy().catch(() => undefined);
  }
}
