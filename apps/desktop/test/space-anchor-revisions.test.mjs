import assert from "node:assert/strict";
import test from "node:test";

import {
  PREFIX_CHARS,
  applySuggestionsSerial,
  buildTextAnchor,
  lineDiff,
  matchTextAnchor,
  sha256Hex,
} from "../electron/main/space-revisions.ts";

const DOC = [
  "# LaboFlow 市场分析",
  "",
  "市场规模测算基于 2025 年公开数据。",
  "第二段包含另一处待修订文字。",
].join("\n");

test("buildTextAnchor captures paraIndex, textPrefix, and the sha256 textHash", async () => {
  const selectionStart = DOC.indexOf("市场规模测算");
  const selected = "市场规模测算基于 2025 年公开数据。";
  const anchor = buildTextAnchor(DOC, selected, selectionStart);

  assert.ok(anchor);
  assert.equal(anchor.kind, "text");
  // selection starts on the third line (0-based index 2)
  assert.equal(anchor.paraIndex, 2);
  assert.equal(anchor.textPrefix, selected.slice(0, PREFIX_CHARS));
  assert.equal(anchor.textHash, sha256Hex(selected));
});

test("buildTextAnchor rejects an empty selection", () => {
  assert.equal(buildTextAnchor(DOC, "", 0), null);
});

test("matchTextAnchor: exact hash match resolves inside the anchor paragraph", () => {
  const selected = "市场规模测算基于 2025 年公开数据。";
  const anchor = buildTextAnchor(DOC, selected, DOC.indexOf(selected));
  const match = matchTextAnchor(DOC, anchor, selected);

  assert.equal(match.status, "exact");
  assert.equal(match.start, DOC.indexOf(selected));
  assert.equal(match.end, match.start + selected.length);
});

test("matchTextAnchor: prefix fallback still matches when the tail drifted", () => {
  // The selection is longer than PREFIX_CHARS; its head is intact while the
  // tail was edited after the anchor was taken, so the hint (full original)
  // no longer matches but the kept prefix still does.
  const head = "第二段包含另一处待修订文字。".padEnd(80, "字");
  const original = head + "旧的结尾";
  const longDoc = [DOC, original].join("\n");
  const driftedDoc = longDoc.replace(original, head + "新的结尾");

  const anchor = buildTextAnchor(longDoc, original, longDoc.indexOf(original));
  const match = matchTextAnchor(driftedDoc, anchor, original);

  assert.equal(match.status, "prefix");
  assert.equal(driftedDoc.slice(match.start, match.end), head.slice(0, PREFIX_CHARS));
});

test("matchTextAnchor: missing when the paragraph no longer holds the prefix", () => {
  const selected = "市场规模测算基于 2025 年公开数据。";
  const anchor = buildTextAnchor(DOC, selected, DOC.indexOf(selected));
  const rewritten = DOC.replace(selected, "这段被整体替换了。");
  const match = matchTextAnchor(rewritten, anchor, selected);

  assert.equal(match.status, "missing");
});

test("applySuggestionsSerial merges non-overlapping suggestions in one pass", () => {
  const first = "市场规模测算基于 2025 年公开数据。";
  const second = "第二段包含另一处待修订文字。";
  const anchorA = buildTextAnchor(DOC, first, DOC.indexOf(first));
  const anchorB = buildTextAnchor(DOC, second, DOC.indexOf(second));

  const result = applySuggestionsSerial(DOC, [
    {
      id: "b",
      anchor: anchorB,
      originalText: second,
      revisedText: "第二段已按建议修订。",
    },
    {
      id: "a",
      anchor: anchorA,
      originalText: first,
      revisedText: "市场规模测算已更新至 2026 年数据。",
    },
  ]);

  assert.deepEqual(result.applied, ["a", "b"]);
  assert.deepEqual(result.conflicts, []);
  assert.ok(result.content.includes("市场规模测算已更新至 2026 年数据。"));
  assert.ok(result.content.includes("第二段已按建议修订。"));
  // untouched text survives byte-for-byte
  assert.ok(result.content.startsWith("# LaboFlow 市场分析"));
});

test("applySuggestionsSerial flags missing anchors without blocking the rest", () => {
  const first = "市场规模测算基于 2025 年公开数据。";
  const anchorA = buildTextAnchor(DOC, first, DOC.indexOf(first));

  const result = applySuggestionsSerial(DOC, [
    { id: "gone", anchor: { kind: "text", paraIndex: 3, textPrefix: "不存在的文本", textHash: sha256Hex("不存在的文本") }, originalText: "不存在的文本", revisedText: "x" },
    { id: "ok", anchor: anchorA, originalText: first, revisedText: "第一段修订完成。" },
  ]);

  assert.deepEqual(result.applied, ["ok"]);
  assert.deepEqual(result.conflicts, [{ id: "gone", reason: "missing" }]);
  assert.ok(result.content.includes("第一段修订完成。"));
});

test("applySuggestionsSerial marks overlapping ranges as conflicts, applies the first", () => {
  const base = "abcdefghij";
  const anchorAll = {
    kind: "text",
    paraIndex: 0,
    textPrefix: "abcdefghij",
    textHash: sha256Hex("abcdefghij"),
  };
  const anchorPart = {
    kind: "text",
    paraIndex: 0,
    textPrefix: "cde",
    textHash: sha256Hex("cde"),
  };

  const result = applySuggestionsSerial(base, [
    { id: "wide", anchor: anchorAll, originalText: "abcdefghij", revisedText: "WIDE" },
    { id: "narrow", anchor: anchorPart, originalText: "cde", revisedText: "narrow" },
  ]);

  assert.deepEqual(result.applied, ["wide"]);
  assert.deepEqual(result.conflicts, [{ id: "narrow", reason: "overlap" }]);
  assert.equal(result.content, "WIDE");
});

test("applySuggestionsSerial ignores non-text anchors in the v1 MD pipeline", () => {
  const result = applySuggestionsSerial(DOC, [
    { id: "csv", anchor: { kind: "csv", row: 1, col: 1 }, originalText: "a", revisedText: "b" },
    { id: "none", anchor: null, originalText: "a", revisedText: "b" },
  ]);

  assert.deepEqual(result.applied, []);
  assert.deepEqual(
    result.conflicts.map((conflict) => conflict.id),
    ["csv", "none"],
  );
  assert.equal(result.content, DOC);
});

test("lineDiff marks added and removed lines around a stable spine", () => {
  const rows = lineDiff("one\ntwo\nthree", "one\nTWO\nthree\nfour");

  assert.deepEqual(
    rows.map((row) => row.type),
    ["same", "del", "add", "same", "add"],
  );
  assert.deepEqual(
    rows.filter((row) => row.type === "same").map((row) => row.text),
    ["one", "three"],
  );
});

test("lineDiff handles empty inputs", () => {
  assert.deepEqual(lineDiff("", "a\nb"), [
    { type: "add", text: "a" },
    { type: "add", text: "b" },
  ]);
  assert.deepEqual(lineDiff("a", ""), [{ type: "del", text: "a" }]);
});
