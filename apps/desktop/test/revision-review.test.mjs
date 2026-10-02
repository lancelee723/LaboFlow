import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { register } from "node:module";
import * as ts from "typescript";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { buildReviewUserPrompt, parseReviewSuggestions, REVIEW_SYSTEM_PROMPT } = await import(
  "../electron/main/laboflow/revision-review.ts"
);

const nodeRequire = createRequire(import.meta.url);
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("review prompt embeds document and numbered comments with anchors", () => {
  const prompt = buildReviewUserPrompt(
    "第一段正文\n第二段正文",
    [
      { id: "c1", authorId: "u1", body: "第二段补数据来源", status: "open", anchor: { textPrefix: "第二段正文" } },
      { id: "c2", authorId: "u2", body: "标题太笼统", status: "open", anchor: null },
    ],
  );
  assert.match(prompt, /第二段正文/);
  assert.match(prompt, /\d+\. \[c1\] （位置：…第二段正文…）第二段补数据来源/);
  assert.match(prompt, /\d+\. \[c2\] 标题太笼统/);
  assert.match(REVIEW_SYSTEM_PROMPT, /JSON 数组/);
  assert.match(REVIEW_SYSTEM_PROMPT, /逐字/);
});

test("parseReviewSuggestions extracts fenced JSON and drops empty drafts", () => {
  const text = [
    "以下是建议：",
    "```json",
    JSON.stringify([
      { originalText: "第二段正文", revisedText: "第二段正文（数据来源：年报P12）", rationale: "补来源" },
      { originalText: "", revisedText: "x" },
      "junk",
    ]),
    "```",
  ].join("\n");
  const drafts = parseReviewSuggestions(text);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].originalText, "第二段正文");
  assert.equal(drafts[0].rationale, "补来源");
  assert.deepEqual(parseReviewSuggestions("没有数组"), []);
});

test("space-client review IPC prefers the injected main-process pipeline", async () => {
  const hostSource = read("../electron/main/space-client.ts");
  assert.match(hostSource, /deps\.reviewByComments/);
  const services = read("../electron/main/laboflow/services.ts");
  assert.match(services, /reviewByComments: \(spaceId, nodeId\) => reviewByComments\(spaceId, nodeId\)/);
  assert.match(services, /completeOneShot\(/);
});

test("server creates review-requested notifications for open comment authors", async () => {
  const schema = read("../../../apps/server/src/db/schema.ts");
  assert.match(schema, /spaceNotifications/);
  const service = read("../../../apps/server/src/spaces/spaces.service.ts");
  assert.match(service, /revision\.review-requested/);
  assert.match(service, /listNotifications/);
});
