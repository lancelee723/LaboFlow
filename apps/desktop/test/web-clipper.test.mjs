import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as ts from "typescript";

import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const nodeRequire = createRequire(import.meta.url);
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("clip url guard: http(s) only, no credentials, parse errors mapped", async () => {
  const { validateClipUrl, clipErrorMessage } = await import(
    "../electron/main/web-clipper.ts"
  );
  const ok = validateClipUrl("  https://example.com/a?b=1 ");
  assert.equal(ok.host, "example.com");
  assert.throws(() => validateClipUrl("file:///etc/passwd"), /http\(s\)/);
  assert.throws(() => validateClipUrl("ftp://x"), /http\(s\)/);
  assert.throws(() => validateClipUrl("https://user:pass@example.com/"), /credentials/);
  assert.throws(() => validateClipUrl("not a url"), /invalid url/);
  assert.equal(clipErrorMessage(403), "page requires login");
  assert.equal(clipErrorMessage(404), "page not found");
  assert.equal(clipErrorMessage(502), "server error");
  assert.equal(clipErrorMessage(418), "http 418");
});

test("parseHtmlToBlocks converts article markup into editor blocks", async () => {
  const { outputText } = ts.transpileModule(
    read("../src/components/space/HtmlCollabEditor.tsx"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
      fileName: "HtmlCollabEditor.tsx",
    },
  );
  const module = { exports: {} };
  new Function("require", "exports", "module", "DOMParser", outputText)((id) => {
    if (id.startsWith(".")) {
      return new Proxy(function () {}, { get: () => () => null });
    }
    return nodeRequire(id);
  }, module.exports, module, DOMParserShim);
  const { parseHtmlToBlocks } = module.exports;

  const blocks = parseHtmlToBlocks(
    "<h1>行业扫描</h1><p>第一段。</p><ul><li>要点A</li><li>要点B</li></ul><ol><li>步骤1</li></ol><h2>数据</h2><figure><img src=\"https://x/y.png\"></figure>",
  );
  assert.deepEqual(
    blocks.map((block) => block.type),
    ["h1", "paragraph", "bullet", "bullet", "numbered", "h2", "image"],
  );
  assert.equal(blocks[0].text, "行业扫描");
  assert.equal(blocks[5].text, "数据");
  assert.equal(blocks[6].src, "https://x/y.png");
});

/** Minimal DOMParser over jsdom so the pure parser can run in node tests. */
function DOMParserShim() {}
Object.defineProperty(DOMParserShim.prototype, "parseFromString", {
  value: function parseFromString(html) {
    const { JSDOM } = nodeRequire("jsdom");
    const dom = new JSDOM(`<body>${html}</body>`);
    return dom.window.document;
  },
  writable: true,
});
