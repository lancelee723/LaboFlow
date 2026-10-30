/**
 * Engine and client tests for the bundled laboflow.pdf plugin (ADR 0312/0313).
 * Imports the plugin's lib modules directly; fixtures live in
 * test/fixtures/pdf.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync, deflateRawSync } from "node:zlib";

import {
  joinTextItems,
  parsePageSpec,
  PdfEncryptedError,
  PdfInvalidError,
  pdfPageCount,
  readPdf,
} from "../resources/plugins/laboflow.pdf/lib/engine.js";
import { downscale, encodePng } from "../resources/plugins/laboflow.pdf/lib/png.js";
import {
  parseWithMineru,
  parseWithMineruAgent,
  readMarkdownFromZip,
} from "../resources/plugins/laboflow.pdf/lib/mineru.js";
import {
  dataDirFromPluginDataPath,
  resolvePdfPath,
} from "../resources/plugins/laboflow.pdf/lib/paths.js";
// From the plugin entry: mode resolution incl. the legacy-settings migration.
import { normalizeMineruSettings } from "../resources/plugins/laboflow.pdf/main.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  new Uint8Array(readFileSync(join(here, "fixtures", "pdf", name)));

test("parsePageSpec parses ranges, clamps, and rejects malformed input", () => {
  assert.deepEqual(parsePageSpec("3,1-2,2", 10), { pages: [1, 2, 3] });
  assert.deepEqual(parsePageSpec("8-20", 10), { pages: [8, 9, 10] });
  assert.deepEqual(parsePageSpec("  ", 10), {});
  assert.ok(parsePageSpec("11", 10).error);
  assert.ok(parsePageSpec("5-2", 10).error);
  assert.ok(parsePageSpec("a", 10).error);
});

test("joinTextItems joins Latin with single spaces and CJK without any", () => {
  assert.equal(
    joinTextItems([
      { str: "Lorem " },
      { str: "ipsum dolor" },
      { str: "sit amet", hasEOL: true },
      { str: "Second page" },
    ]),
    "Lorem ipsum dolor sit amet\nSecond page",
  );
  assert.equal(joinTextItems([{ str: "贵州" }, { str: "茅台" }]), "贵州茅台");
  assert.equal(joinTextItems([{ str: "营收" }, { str: "1.2B" }]), "营收1.2B");
});

test("png encoder round-trips pixels and downscale box-averages", () => {
  const width = 4;
  const height = 3;
  const data = new Uint8Array(
    Array.from({ length: width * height * 3 }, (_, i) => (i * 7) % 256),
  );
  const png = encodePng({ width, height, channels: 3, data });
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), width);
  assert.equal(png.readUInt32BE(20), height);
  const idatAt = png.indexOf(Buffer.from("IDAT", "ascii"));
  const idatLength = png.readUInt32BE(idatAt - 4);
  const inflated = inflateSync(png.subarray(idatAt + 4, idatAt + 4 + idatLength));
  assert.equal(inflated.length, (width * 3 + 1) * height);

  const scaled = downscale(
    {
      width: 4,
      height: 1,
      channels: 3,
      data: new Uint8Array([10, 0, 0, 20, 0, 0, 30, 0, 0, 40, 0, 0]),
    },
    2,
  );
  assert.equal(scaled.width, 2);
  assert.deepEqual([...scaled.data], [15, 0, 0, 35, 0, 0]);
});

test("readPdf extracts the text layer page by page and honors page windows", async () => {
  const result = await readPdf({
    data: fixture("text-two-pages.pdf"),
    includeImages: false,
  });
  assert.equal(result.totalPages, 2);
  assert.equal(result.pagesTruncated, false);
  assert.ok(result.pages[0].text.includes("Lorem ipsum dolor sit amet"));
  assert.ok(result.pages[1].text.includes("consolidated statements"));
  const windowed = await readPdf({
    data: fixture("text-two-pages.pdf"),
    pages: [2],
    includeImages: false,
  });
  assert.equal(windowed.pages.length, 1);
  assert.equal(windowed.pages[0].page, 2);
  assert.equal(await pdfPageCount(fixture("text-two-pages.pdf")), 2);
});

test("readPdf classifies scanned pages and recovers bitmaps (RGB and DCTDecode)", async () => {
  const result = await readPdf({
    data: fixture("images-two-pages.pdf"),
    includeImages: true,
  });
  assert.deepEqual(result.pages.map((page) => page.kind), ["scanned", "scanned"]);
  assert.deepEqual(
    { w: result.pages[0].image?.width, h: result.pages[0].image?.height },
    { w: 4, h: 3 },
  );
  assert.deepEqual(
    { w: result.pages[1].image?.width, h: result.pages[1].image?.height },
    { w: 8, h: 6 },
  );
  const off = await readPdf({
    data: fixture("images-two-pages.pdf"),
    includeImages: false,
  });
  assert.ok(off.pages.every((page) => page.skipped === "vision-unavailable"));
  const capped = await readPdf({
    data: fixture("images-two-pages.pdf"),
    includeImages: true,
    limits: { maxImages: 1 },
  });
  assert.equal(capped.pages[1].skipped, "image-budget");
});

test("readPdf surfaces encryption as typed, actionable errors", async () => {
  await assert.rejects(
    () =>
      readPdf({ data: fixture("encrypted-user-password.pdf"), includeImages: false }),
    PdfEncryptedError,
  );
  await assert.rejects(
    () =>
      readPdf({
        data: fixture("encrypted-user-password.pdf"),
        password: "wrong-password",
        includeImages: false,
      }),
    (error) => error instanceof PdfEncryptedError && error.wrongPassword === true,
  );
  const opened = await readPdf({
    data: fixture("encrypted-user-password.pdf"),
    password: "hunter2",
    includeImages: false,
  });
  assert.ok(opened.pages[0].text.includes("Lorem ipsum"));
  await assert.rejects(
    () => readPdf({ data: new Uint8Array([1, 2, 3, 4]), includeImages: false }),
    PdfInvalidError,
  );
});

function buildZip(entries) {
  const encoder = new TextEncoder();
  const crc = (bytes) => {
    let c = 0xffffffff;
    for (const byte of bytes) {
      c ^= byte;
      for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const concat = (parts) => {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  };
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const stored = entry.deflate
      ? new Uint8Array(deflateRawSync(Buffer.from(entry.data)))
      : entry.data;
    const method = entry.deflate ? 8 : 0;
    const local = new Uint8Array(30 + nameBytes.length + stored.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, crc(entry.data), true);
    localView.setUint32(18, stored.length, true);
    localView.setUint32(22, entry.data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(stored, 30 + nameBytes.length);
    locals.push(local);
    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, crc(entry.data), true);
    centralView.setUint32(20, stored.length, true);
    centralView.setUint32(24, entry.data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralDir = concat(centrals);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, centrals.length, true);
  eocdView.setUint16(10, centrals.length, true);
  eocdView.setUint32(12, centralDir.length, true);
  eocdView.setUint32(16, offset, true);
  return concat([...locals, centralDir, eocd]);
}

const markdown = new TextEncoder().encode(
  "# Annual Report\n\nRevenue grew 12% year over year.",
);

test("readMarkdownFromZip prefers full.md and reads deflated entries", () => {
  const zip = buildZip([
    { name: "images/page1.png", data: new TextEncoder().encode("png") },
    { name: "smuggle.md", data: new TextEncoder().encode("wrong file") },
    { name: "full.md", data: markdown },
  ]);
  assert.equal(
    readMarkdownFromZip(zip),
    "# Annual Report\n\nRevenue grew 12% year over year.",
  );
  const deflated = buildZip([{ name: "chunk0.md", data: markdown, deflate: true }]);
  assert.ok(readMarkdownFromZip(deflated).includes("Revenue grew 12%"));
  assert.throws(
    () => readMarkdownFromZip(new TextEncoder().encode("not a zip")),
    /not a ZIP/,
  );
});

test("parseWithMineru follows the official v4 signed-upload flow", async () => {
  const zip = buildZip([{ name: "full.md", data: markdown }]);
  const calls = [];
  const fetchImpl = async (input) => {
    calls.push(`${input.method ?? "GET"} ${input.url}`);
    if (input.url.endsWith("/api/v4/file-urls/batch")) {
      assert.equal(input.headers.Authorization, "Bearer tok");
      const body = JSON.parse(input.body);
      // Exact official example shape: model_version + files[name, data_id].
      assert.deepEqual(body, {
        model_version: "vlm",
        files: [{ name: "report.pdf", data_id: "report.pdf" }],
      });
      return {
        status: 200,
        bodyText: JSON.stringify({
          code: 0,
          data: { batch_id: "b1", file_urls: ["https://oss/upload"] },
        }),
      };
    }
    if (input.url === "https://oss/upload") {
      // PUT of raw bytes: no auth header or content type may leak onto the
      // signed URL, and the PDF rides bodyBase64.
      assert.equal(input.method, "PUT");
      assert.equal(input.headers?.Authorization, undefined);
      assert.equal(input.headers?.["Content-Type"], undefined);
      assert.equal(Buffer.from(input.bodyBase64, "base64")[0], 1);
      return { status: 200 };
    }
    if (input.url.includes("/api/v4/extract-results/batch/b1")) {
      return {
        status: 200,
        bodyText: JSON.stringify({
          code: 0,
          data: {
            extract_result: [{ state: "done", full_zip_url: "https://oss/zip" }],
          },
        }),
      };
    }
    if (input.url === "https://oss/zip") {
      assert.equal(input.responseFormat, "base64");
      return { status: 200, bodyBase64: Buffer.from(zip).toString("base64") };
    }
    throw new Error(`unexpected fetch ${input.url}`);
  };
  const result = await parseWithMineru(
    { endpoint: "https://mineru.net", apiKey: "tok" },
    {
      fileName: "report.pdf",
      data: new Uint8Array([1, 2, 3]),
      fetchImpl,
      pollIntervalMs: 1,
    },
  );
  assert.ok(result.includes("Revenue grew 12%"));
  assert.ok(calls[0].includes("file-urls/batch"));
});

test("parseWithMineruAgent follows the official v1 tokenless flow", async () => {
  const fetchCalls = [];
  const fetchImpl = async (input) => {
    fetchCalls.push(`${input.method ?? "GET"} ${input.url}`);
    if (input.url.endsWith("/api/v1/agent/parse/file")) {
      // Tokenless: no Authorization header may be sent.
      assert.equal(input.headers?.Authorization, undefined);
      assert.deepEqual(JSON.parse(input.body), {
        file_name: "scan.pdf",
        language: "ch",
        is_ocr: true,
      });
      return {
        status: 200,
        bodyText: JSON.stringify({
          code: 0,
          data: { task_id: "a1", file_url: "https://oss/put" },
        }),
      };
    }
    if (input.url === "https://oss/put") {
      assert.equal(input.method, "PUT");
      assert.equal(Buffer.from(input.bodyBase64, "base64")[0], 9);
      return { status: 200 };
    }
    if (input.url === "https://mineru.net/api/v1/agent/parse/a1") {
      return {
        status: 200,
        bodyText: JSON.stringify({
          code: 0,
          data: { state: "done", markdown_url: "https://cdn/full.md" },
        }),
      };
    }
    if (input.url === "https://cdn/full.md") {
      return { status: 200, bodyText: "# Scanned\n\nOCR body." };
    }
    throw new Error(`unexpected fetch ${input.url}`);
  };
  const result = await parseWithMineruAgent(
    { endpoint: "https://mineru.net", apiKey: "" },
    { fileName: "scan.pdf", data: new Uint8Array([9]), fetchImpl, pollIntervalMs: 1 },
  );
  assert.equal(result, "# Scanned\n\nOCR body.");
  assert.ok(fetchCalls[0].includes("/api/v1/agent/parse/file"));
});

test("parseWithMineruAgent surfaces rejection and failure states", async () => {
  await assert.rejects(
    () =>
      parseWithMineruAgent(
        { endpoint: "https://mineru.net", apiKey: "" },
        {
          fileName: "r.pdf",
          data: new Uint8Array([1]),
          fetchImpl: async () => ({
            status: 200,
            bodyText: JSON.stringify({ code: -1, msg: "ip rate limited" }),
          }),
        },
      ),
    /ip rate limited/,
  );
  await assert.rejects(
    () =>
      parseWithMineruAgent(
        { endpoint: "https://mineru.net", apiKey: "" },
        {
          fileName: "r.pdf",
          data: new Uint8Array([1]),
          pollIntervalMs: 1,
          fetchImpl: async (input) => {
            if (input.url.endsWith("/api/v1/agent/parse/file")) {
              return {
                status: 200,
                bodyText: JSON.stringify({
                  code: 0,
                  data: { task_id: "a2", file_url: "https://oss/put" },
                }),
              };
            }
            if (input.url === "https://oss/put") return { status: 200 };
            return {
              status: 200,
              bodyText: JSON.stringify({
                code: 0,
                data: { state: "failed", err_msg: "page limit exceeded" },
              }),
            };
          },
        },
      ),
    /page limit exceeded/,
  );
});

test("parseWithMineru surfaces upload and parse failures", async () => {
  await assert.rejects(
    () =>
      parseWithMineru(
        { endpoint: "https://mineru.net", apiKey: "bad" },
        {
          fileName: "r.pdf",
          data: new Uint8Array([1]),
          fetchImpl: async () => ({
            status: 200,
            bodyText: JSON.stringify({ code: 401, msg: "invalid token" }),
          }),
        },
      ),
    /invalid token/,
  );
  await assert.rejects(
    () =>
      parseWithMineru(
        { endpoint: "https://mineru.net", apiKey: "tok" },
        {
          fileName: "r.pdf",
          data: new Uint8Array([1]),
          pollIntervalMs: 1,
          fetchImpl: async (input) => {
            if (input.url.endsWith("/api/v4/file-urls/batch")) {
              return {
                status: 200,
                bodyText: JSON.stringify({
                  code: 0,
                  data: { batch_id: "b2", file_urls: ["https://oss/u"] },
                }),
              };
            }
            if (input.url === "https://oss/u") return { status: 200 };
            return {
              status: 200,
              bodyText: JSON.stringify({
                code: 0,
                data: {
                  extract_result: [
                    { state: "failed", err_msg: "page limit exceeded" },
                  ],
                },
              }),
            };
          },
        },
      ),
    /page limit exceeded/,
  );
});

test("normalizeMineruSettings routes modes and migrates legacy stored state", () => {
  // Official modes pin the base and (for agent) drop the token.
  assert.deepEqual(normalizeMineruSettings({ mineruMode: "agent" }), {
    mode: "agent",
    endpoint: "https://mineru.net",
    apiKey: "",
  });
  assert.deepEqual(
    normalizeMineruSettings({ mineruMode: "precision", mineruApiKey: " tok " }),
    { mode: "precision", endpoint: "https://mineru.net", apiKey: "tok" },
  );
  // Precision without a token is unconfigured — the tool reports it.
  assert.equal(normalizeMineruSettings({ mineruMode: "precision" }), undefined);
  // Custom keeps the user base (api/vN suffix stripped) and token.
  assert.deepEqual(
    normalizeMineruSettings({
      mineruMode: "custom",
      mineruEndpoint: "https://pdf.corp.cn/api/v4/extract/task/",
      mineruApiKey: "k",
    }),
    { mode: "custom", endpoint: "https://pdf.corp.cn", apiKey: "k" },
  );
  assert.equal(
    normalizeMineruSettings({ mineruMode: "custom", mineruEndpoint: "notaurl" }),
    undefined,
  );
  // Legacy state (no mode): official/empty endpoint + token -> precision;
  // foreign endpoint -> custom; nothing -> unconfigured.
  assert.deepEqual(
    normalizeMineruSettings({
      mineruEndpoint: "https://mineru.net/api/v4/extract/task",
      mineruApiKey: "tok",
    }),
    { mode: "precision", endpoint: "https://mineru.net", apiKey: "tok" },
  );
  assert.deepEqual(
    normalizeMineruSettings({ mineruEndpoint: "https://pdf.corp.cn", mineruApiKey: "k" }),
    { mode: "custom", endpoint: "https://pdf.corp.cn", apiKey: "k" },
  );
  assert.equal(normalizeMineruSettings({}), undefined);
  assert.equal(normalizeMineruSettings(undefined), undefined);
});

test("resolvePdfPath confines reads to the session roots", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir, homedir } = await import("node:os");
  const dataDir = mkdtempSync(join(tmpdir(), "pdfroots-"));
  mkdirSync(join(dataDir, "attachments"), { recursive: true });
  mkdirSync(join(dataDir, "scratch", "s1"), { recursive: true });
  const workspace = mkdtempSync(join(tmpdir(), "pdfws-"));
  const { realpathSync } = await import("node:fs");
  writeFileSync(join(workspace, "report.pdf"), "pdf");
  writeFileSync(join(dataDir, "attachments", "abc123"), "pdf");
  writeFileSync(join(dataDir, "scratch", "s1", "pasted.pdf"), "pdf");
  writeFileSync(join(tmpdir(), "outside.pdf"), "pdf");

  const resolve = (path, sessionId = "s1") =>
    resolvePdfPath({
      path,
      workspacePath: workspace,
      dataDir,
      sessionId,
    });

  assert.equal(
    resolve("report.pdf")?.absolute,
    realpathSync(join(workspace, "report.pdf")),
  );
  assert.ok(resolve(join(dataDir, "attachments", "abc123")));
  assert.ok(resolve(join(dataDir, "scratch", "s1", "pasted.pdf")));
  assert.equal(resolve(join(tmpdir(), "outside.pdf")), undefined);
  assert.equal(resolve("../escape.pdf"), undefined);
  assert.equal(resolve("missing.pdf"), undefined);
  assert.equal(resolve("pasted.pdf", "s2"), undefined);
  assert.equal(
    dataDirFromPluginDataPath(join(dataDir, "plugins", "data", "laboflow.pdf")),
    dataDir,
  );
  assert.equal(
    dataDirFromPluginDataPath(join(tmpdir(), "nowhere", "a", "b")),
    undefined,
  );
  void homedir;
});
