/**
 * MinerU client for PDFRead's external OCR leg (ADR 0312/0313).
 *
 * Uses the JSON-upload v4 flow so every request rides `pi.net.fetch`, whose
 * body is text-only: the PDF is submitted base64-encoded to
 * POST /api/v4/file-queue/file, polled at
 * GET  /api/v4/extract-results/task/{task_id}, and the resulting archive is
 * downloaded with `responseFormat: "base64"` and read by a minimal
 * central-directory ZIP walker over node:zlib (stored + deflate).
 */
import { inflateRawSync } from "node:zlib";

export class MineruError extends Error {
  constructor(message) {
    super(message);
    this.name = "MineruError";
  }
}

const DEFAULT_DEADLINE_MS = 540000;
const DEFAULT_POLL_INTERVAL_MS = 3000;

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function lastIndexOf(haystack, needle) {
  outer: for (let i = haystack.length - needle.length; i >= 0; i--) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function b64ToBytes(base64) {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

/** Read `full.md` (or the first .md entry) out of a MinerU result archive. */
export function readMarkdownFromZip(zip) {
  const eocd = lastIndexOf(zip, [0x50, 0x4b, 0x05, 0x06]);
  if (eocd < 0) throw new MineruError("MinerU result is not a ZIP archive");
  const entryCount = view(zip).getUint16(eocd + 10, true);
  let offset = view(zip).getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const candidates = [];
  for (let i = 0; i < entryCount; i++) {
    if (view(zip).getUint32(offset, true) !== 0x02014b50) {
      throw new MineruError("MinerU result ZIP central directory is corrupt");
    }
    const method = view(zip).getUint16(offset + 10, true);
    const compressedSize = view(zip).getUint32(offset + 20, true);
    const nameLength = view(zip).getUint16(offset + 28, true);
    const extraLength = view(zip).getUint16(offset + 30, true);
    const commentLength = view(zip).getUint16(offset + 32, true);
    const localOffset = view(zip).getUint32(offset + 42, true);
    const name = decoder.decode(zip.subarray(offset + 46, offset + 46 + nameLength));
    if (name.toLowerCase().endsWith(".md")) {
      const text = readEntry(zip, localOffset, method, compressedSize, decoder);
      if (text !== undefined) {
        candidates.push({ name, text, isFull: name.toLowerCase() === "full.md" });
      }
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  const chosen = candidates.find((entry) => entry.isFull) ?? candidates[0];
  if (!chosen) throw new MineruError("MinerU result archive contains no markdown");
  return chosen.text;
}

function readEntry(zip, localOffset, method, compressedSize, decoder) {
  if (view(zip).getUint32(localOffset, true) !== 0x04034b50) return undefined;
  const nameLength = view(zip).getUint16(localOffset + 26, true);
  const extraLength = view(zip).getUint16(localOffset + 28, true);
  const dataStart = localOffset + 30 + nameLength + extraLength;
  const raw = zip.subarray(dataStart, dataStart + compressedSize);
  const bytes = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : undefined;
  if (!bytes) return undefined;
  return decoder.decode(bytes);
}

/**
 * Submit a PDF to MinerU and return the extracted markdown.
 *
 * `fetchImpl` adapts the host `pi.net.fetch`: `{ url, method, headers, body,
 * responseFormat }` → `{ status, headers, bodyText?, bodyBase64? }`.
 */
export async function parseWithMineru(config, input) {
  const fetchImpl = input.fetchImpl;
  const deadline = Date.now() + (input.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const base = config.endpoint.replace(/\/+$/, "");

  const headers = { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" };
  const submitResponse = await fetchImpl({
    url: `${base}/api/v4/file-queue/file`,
    method: "POST",
    headers,
    body: JSON.stringify({
      name: input.fileName,
      is_ocr: true,
      enable_table: true,
      language: "ch",
      file: Buffer.from(input.data).toString("base64"),
    }),
  });
  const submit = JSON.parse(submitResponse.bodyText ?? "{}");
  const taskId = submit?.data?.task_id;
  if (submit.code !== 0 || !taskId) {
    throw new MineruError(`MinerU rejected the upload: ${submit.msg ?? `code ${submit.code}`}`);
  }

  for (;;) {
    if (input.signal?.aborted) throw new MineruError("MinerU parse aborted");
    if (Date.now() > deadline) {
      throw new MineruError(
        `MinerU parse did not finish within ${Math.round((input.deadlineMs ?? DEFAULT_DEADLINE_MS) / 1000)}s`,
      );
    }
    const pollResponse = await fetchImpl({
      url: `${base}/api/v4/extract-results/task/${taskId}`,
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    const payload = JSON.parse(pollResponse.bodyText ?? "{}");
    if (payload.code !== 0) {
      throw new MineruError(`MinerU result poll failed: ${payload.msg ?? `code ${payload.code}`}`);
    }
    const result = payload?.data;
    if (result?.state === "done" && result.full_zip_url) {
      const zipResponse = await fetchImpl({
        url: result.full_zip_url,
        responseFormat: "base64",
      });
      if (!zipResponse.bodyBase64) {
        throw new MineruError("MinerU result download returned no binary body");
      }
      return readMarkdownFromZip(b64ToBytes(zipResponse.bodyBase64));
    }
    if (result?.state === "failed" || result?.state === "convert failed") {
      throw new MineruError(`MinerU parsing failed: ${result.err_msg ?? "unknown error"}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs));
  }
}
