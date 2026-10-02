import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import { readFile } from "node:fs/promises";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { attachSpaceDoc, renderSpaceDocMarkdown } = await import(
  "../electron/main/session-attach.ts"
);

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("attachSpaceDoc writes a headered snapshot into the session scratch dir", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "t64-space-attach-"));
  try {
    const saved = await attachSpaceDoc(
      dataDir,
      "sess123",
      "访谈纪要",
      "md",
      "验收空间",
      "第一段正文",
    );
    assert.equal(saved.name, "访谈纪要.md");
    assert.ok(existsSync(saved.path));
    const text = readFileSync(saved.path, "utf8");
    assert.match(text, /# 团队空间文档：访谈纪要/);
    assert.match(text, /来源空间：验收空间/);
    assert.match(text, /第一段正文/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("attachSpaceDoc keeps the document extension for csv/html", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "t64-space-attach-"));
  try {
    const csv = await attachSpaceDoc(dataDir, "sess123", "数据", "csv", "空间", "a,b\n1,2");
    assert.equal(csv.name, "数据.csv");
    const html = await attachSpaceDoc(dataDir, "sess123", "页面.html", "html", "空间", "<p>x</p>");
    assert.equal(html.name, "页面.html");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("attachSpaceDoc rejects unsafe session ids and truncates huge docs", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "t64-space-attach-"));
  try {
    await assert.rejects(
      attachSpaceDoc(dataDir, "../escape", "x", "md", "s", "c"),
      /invalid session id/,
    );
    const saved = await attachSpaceDoc(dataDir, "sess123", "big", "md", "s", "x".repeat(400_001));
    const text = readFileSync(saved.path, "utf8");
    assert.match(text, /文档过长，已截断/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("renderSpaceDocMarkdown headers the source space for traceability", () => {
  const text = renderSpaceDocMarkdown("纪要", "空间A", "正文");
  assert.match(text, /来源空间：空间A/);
});

test("composer plus menu wires the team-space source end to end", async () => {
  const [toolbar, composer, protocol, api] = await Promise.all([
    read("../src/features/chat/composer/ComposerToolbar.tsx"),
    read("../src/components/Composer.tsx"),
    read("../../../packages/shared/src/protocol.ts"),
    read("../src/lib/api.ts"),
  ]);
  // Channel registered in the shared protocol and invoked by the renderer api.
  assert.match(protocol, /composerAttachSpaceDoc: "pi-desktop\/composer\/attachSpaceDoc"/);
  assert.match(api, /composerAttachSpaceDoc: \(input: \{/);
  assert.match(api, /IPC\.invoke\.composerAttachSpaceDoc/);
  // Toolbar renders the fifth sub-mode and lists only readable docs.
  assert.match(toolbar, /setPlusSpaceMode\(true\)/);
  assert.match(toolbar, /t\("chat\.pickSpaceDoc"\)/);
  assert.match(toolbar, /function spaceDocEntries/);
  assert.match(toolbar, /node\.perm === "none"/);
  // Composer splices the returned scratch file as a chip.
  assert.match(composer, /attachSpaceDocContext/);
  assert.match(composer, /api\.composerAttachSpaceDoc\(/);
  assert.match(composer, /onAttachSpaceDoc=\{attachSpaceDocContext\}/);
});

test("space-source i18n keys exist in all nine locales", async () => {
  const locales = ["en", "de", "es", "fr", "ko", "pt-BR", "tr", "zh-CN", "zh-TW"];
  for (const locale of locales) {
    const src = await read(`../../../packages/i18n/src/locales/${locale}/index.ts`);
    for (const key of [
      "pickSpaceDoc",
      "spaceAllSpaces",
      "spaceDocsEmpty",
      "spaceDocsLoading",
      "noSpacesYet",
      "spaceDocAttached",
    ]) {
      assert.match(src, new RegExp(`${key}:`), `${locale} missing ${key}`);
    }
  }
});
