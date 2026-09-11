import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCitationSource,
  kbCardKind,
  parseCitationSegments,
} from "../src/components/kb/citations.ts";

test("parseCitationSegments splits complete [引用:n] markers", () => {
  const segments = parseCitationSegments("营收增长 [引用:1]，利润率 [引用:2]");
  assert.deepEqual(
    segments.map((segment) => segment.kind),
    ["text", "citation", "text", "citation"],
  );
  assert.deepEqual(
    segments.filter((s) => s.kind === "citation").map((s) => s.n),
    [1, 2],
  );
  assert.equal(segments[0].text, "营收增长 ");
  assert.equal(segments[2].text, "，利润率 ");
});

test("parseCitationSegments keeps partial markers as plain text while streaming", () => {
  for (const partial of ["见 [引用:", "见 [引用:1", "见 [引用", "引用:1]", "[引用:]"]) {
    const segments = parseCitationSegments(partial);
    assert.equal(segments.length, 1, partial);
    assert.equal(segments[0].kind, "text", partial);
    assert.equal(segments[0].text, partial);
  }
});

test("parseCitationSegments handles sources without markers", () => {
  assert.deepEqual(parseCitationSegments(""), []);
  assert.deepEqual(parseCitationSegments("plain answer"), [
    { kind: "text", text: "plain answer" },
  ]);
});

test("buildCitationSource rewrites complete markers into no-op badge links", () => {
  const out = buildCitationSource(
    "依据年报 [引用:3] 得出结论",
    (n) => `#kb-citation-${n}`,
  );
  assert.equal(out, "依据年报 [[3]](#kb-citation-3) 得出结论");
});

test("buildCitationSource leaves partial markers untouched", () => {
  const partial = "结论待补充 [引用:";
  assert.equal(
    buildCitationSource(partial, (n) => `#kb-citation-${n}`),
    partial,
  );
});

test("buildCitationSource skips fenced code blocks", () => {
  const source = "前文 [引用:1]\n```text\nliteral [引用:2] stays\n```\n后文 [引用:2]";
  const out = buildCitationSource(source, (n) => `#kb-citation-${n}`);
  assert.equal(
    out,
    "前文 [[1]](#kb-citation-1)\n```text\nliteral [引用:2] stays\n```\n后文 [[2]](#kb-citation-2)",
  );
});

test("buildCitationSource skips inline code spans", () => {
  const out = buildCitationSource(
    "回答 `code [引用:1]` 与 [引用:1]",
    (n) => `#kb-citation-${n}`,
  );
  assert.equal(out, "回答 `code [引用:1]` 与 [[1]](#kb-citation-1)");
});

test("buildCitationSource passes through content without markers", () => {
  const source = "# Heading\n\n普通回答，无引用。";
  assert.equal(buildCitationSource(source, (n) => `#${n}`), source);
});

test("kbCardKind narrows only known card kinds", () => {
  assert.equal(kbCardKind("expert-card"), "expert-card");
  assert.equal(kbCardKind("team-card"), "team-card");
  assert.equal(kbCardKind("message"), null);
  assert.equal(kbCardKind(undefined), null);
  assert.equal(kbCardKind(null), null);
});
