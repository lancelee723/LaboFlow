/**
 * FR-TC-12: 划词 AI 就地改. Prompt/cleanup contract for the one-shot
 * selection rewrite (main side), plus the renderer wiring that keeps the
 * revision pipeline the only write path: the AI fills the dialog, submit
 * goes through spaceRevisionCreate, provenance flips on hand edits.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { REWRITE_SYSTEM_PROMPT, buildRewriteUserPrompt, cleanRewriteOutput } =
  await import("../electron/main/laboflow/revision-review.ts");

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("rewrite prompt keeps the selection first-class and context read-only", () => {
  const prompt = buildRewriteUserPrompt(
    "季度收入同比增长百分之十二",
    "改成数字形式",
    { before: "财务摘要：", after: "\n\n成本结构见下表。" },
  );
  assert.match(prompt, /"""[\s\S]*季度收入同比增长百分之十二[\s\S]*"""/);
  assert.match(prompt, /改写指令：改成数字形式/);
  assert.match(prompt, /只输出改写后的选区文本/);
  // Reading order: preceding context, then the selection, then what follows.
  const beforeAt = prompt.indexOf("财务摘要");
  const at = prompt.indexOf("季度收入同比增长百分之十二");
  const afterAt = prompt.indexOf("成本结构见下表");
  assert.ok(beforeAt > -1 && beforeAt < at && at < afterAt, "selection sits between its contexts");
  // Default instruction when the box is empty.
  assert.match(buildRewriteUserPrompt("文本", ""), /更精炼、更专业/);
});

test("cleanRewriteOutput strips fences and quote wraps, refuses prose no-ops", () => {
  assert.equal(cleanRewriteOutput("同比增长 12%", "原文"), "同比增长 12%");
  assert.equal(cleanRewriteOutput("```markdown\n同比增长 12%\n```", "原文"), "同比增长 12%");
  assert.equal(cleanRewriteOutput('"同比增长 12%"', "原文"), "同比增长 12%");
  assert.equal(cleanRewriteOutput("“同比增长 12%”", "原文"), "同比增长 12%");
  // Echoing the original, empty, or missing output must never replace text.
  assert.equal(cleanRewriteOutput("原文", "原文"), "原文");
  assert.equal(cleanRewriteOutput("  ", "原文"), "原文");
});

test("editor wires the rewrite through the revision dialog, provenance flips on edit", async () => {
  const editor = await read("../src/components/space/MdDocEditor.tsx");
  assert.match(editor, /api\.spaceRewriteSelection\(\{/);
  // The rewrite result lands in the dialog, not the document.
  assert.match(editor, /setRevisionDraft\(result\.text\)/);
  // Submit rides the revision pipeline; untouched AI output is "agent".
  assert.match(editor, /producedBy: aiOriginText !== null && revised === aiOriginText \? "agent" : "user"/);
  // A hand edit reverts provenance to the user.
  assert.match(editor, /event\.target\.value !== aiOriginText/);
});

test("main keeps the rewrite off the document write path", async () => {
  const services = await read("../electron/main/laboflow/services.ts");
  const rewrite = services.match(
    /async function rewriteSelection\([\s\S]*?return \{ text: cleanRewriteOutput\(result\.text \?\? "", selectedText\) \};\n  \}/,
  )?.[0] ?? "";
  assert.match(rewrite, /completeOneShot\(/);
  assert.match(rewrite, /cleanRewriteOutput/);
  assert.doesNotMatch(rewrite, /createRevision|spaceDocSave|appendMessage/);
  const host = await read("../electron/main/space-client.ts");
  assert.match(host, /IPC\.invoke\.spaceRewriteSelection/);
});
