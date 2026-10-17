/**
 * FR-E-17: serial multi-expert dispatch.
 *
 * Renderer side: the mention parser must turn `@A 做X，然后 @B 做Y` into
 * ordered expert steps and refuse anything a chain cannot honor (a team in
 * the middle, an unknown name, a taskless segment) so the single-mention
 * path stays untouched. Main side: the chain runner dispatches strictly one
 * step at a time, feeds the previous finalText forward as the upstream
 * artifact, and stops after a non-completed step.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { startExpertChain } = await import(
  "../electron/main/laboflow/expert-chain.ts"
);

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [mention, queueSlice, en, zhCN] = await Promise.all([
  read("../src/stores/expert-mention.ts"),
  read("../src/stores/slices/queue-slice.ts"),
  read("../../../packages/i18n/src/locales/en/index.ts"),
  read("../../../packages/i18n/src/locales/zh-CN/index.ts"),
]);

test("chain parse: sequenced mentions split in text order across separators", () => {
  const parser = mention.match(
    /export async function matchExpertMentionChain\([\s\S]*?^\}/m,
  )?.[0] ?? "";
  // The sequencing vocabulary: Chinese 然后/接着/之后再, English then,
  // semicolons and newlines.
  assert.match(parser, /然后\|接着\|之后再\|then/);
  assert.match(parser, /\\n\+/);
  assert.match(parser, /segments\.length < 2\) return null/);
  // Every segment needs @name and a non-empty task.
  assert.match(parser, /if \(!match\) return null/);
  assert.match(parser, /if \(!task\) return null/);
  // A team or unknown name in the chain is not a chain.
  assert.match(parser, /if \(!expertId\) return null/);
});

test("chain dispatch rides the send path before single-mention dispatch", () => {
  assert.match(queueSlice, /const chainSteps = await matchExpertMentionChain\(content\)/);
  const chain = queueSlice.match(
    /const chainSteps = await matchExpertMentionChain\(content\);[\s\S]*?return true;\n\s*\} catch/,
  )?.[0] ?? "";
  assert.match(chain, /api\.invokeExpertChain\(\{/);
  assert.match(chain, /buildExpertDispatchTask\(step\.task, draft\)/);
  // Draft context rides with the first step only; later steps chain on
  // upstream artifacts instead.
  assert.match(chain, /index === 0/);
  const singleAt = queueSlice.indexOf(
    "const expertDispatch = await matchExpertMention(content);",
  );
  const chainAt = queueSlice.indexOf("matchExpertMentionChain(content)");
  assert.ok(chainAt > -1 && singleAt > chainAt, "chain must resolve first");
});

test("toast key exists in both source and mirror locales", () => {
  assert.match(en, /chainDispatched: "Serial dispatch of \{\{count\}\} experts started/);
  assert.match(zhCN, /chainDispatched: "已按序指派 \{\{count\}\} 位专家/);
});

function fakeDeps(script) {
  const calls = [];
  const cards = [];
  const completions = [];
  let step = 0;
  const deps = {
    invokeWithCompletion: async ({ expertId, task }) => {
      calls.push({ expertId, task });
      const index = step++;
      let settle;
      const completion = new Promise((resolve) => {
        settle = resolve;
      });
      completions.push(settle);
      script.onInvoke?.(index, { expertId, task }, settle);
      return { sessionId: `session-${index}`, completion };
    },
    postSessionCard: async (sessionId, message) => {
      cards.push({ sessionId, content: message.content, kind: message.kind });
    },
    broadcast: (event) => cards.push({ broadcast: event }),
    logger: { app: () => {} },
  };
  return {
    deps,
    calls,
    cards,
    complete: (index, result) => completions[index](result),
    settleAll: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

const STEPS = [
  { expertId: "e1", name: "数据分析", task: "分析销量" },
  { expertId: "e2", name: "PPT制作师", task: "做成PPT" },
];

test("serial execution: second dispatch waits for the first completion and inherits its output", async () => {
  const fake = fakeDeps({});
  let secondTask = null;
  fake.deps.invokeWithCompletion = ((original) => async (request) => {
    const result = await original(request);
    if (fake.calls.length === 2) secondTask = request.task;
    return result;
  })(fake.deps.invokeWithCompletion);

  const { firstSessionId } = await startExpertChain(fake.deps, STEPS, "origin-1");
  await fake.settleAll();
  assert.equal(fake.calls.length, 1, "only the first step dispatches upfront");
  assert.equal(firstSessionId, "session-0");

  fake.complete(0, { status: "completed", finalText: "销量结论：Q3 增长 12%" });
  await fake.settleAll();
  assert.equal(fake.calls.length, 2);
  assert.match(secondTask, /^做成PPT/);
  assert.match(secondTask, /上游专家「数据分析」的产出/);
  assert.match(secondTask, /Q3 增长 12%/);
  assert.ok(cardsInclude(fake.cards, "1/2 完成"));
  assert.ok(cardsInclude(fake.cards, "PPT制作师"));
});

test("chain completion posts a summary card into the origin session", async () => {
  const fake = fakeDeps({});
  await startExpertChain(fake.deps, STEPS, "origin-1");
  fake.complete(0, { status: "completed", finalText: "first" });
  await fake.settleAll();
  fake.complete(1, { status: "completed", finalText: "second" });
  await fake.settleAll();
  const done = fake.cards.find(
    (card) => card.content && card.content.includes("专家链 · 完成"),
  );
  assert.ok(done, "final summary card posted");
  assert.match(done.content, /数据分析/);
  assert.match(done.content, /PPT制作师/);
  assert.equal(done.sessionId, "origin-1");
});

test("a failed step stops the chain: no dispatch, no inherited garbage", async () => {
  const fake = fakeDeps({});
  await startExpertChain(fake.deps, STEPS, "origin-1");
  fake.complete(0, { status: "error", finalText: "" });
  await fake.settleAll();
  assert.equal(fake.calls.length, 1, "second step never dispatches");
  const stopped = fake.cards.find((card) => card.content?.includes("未完成"));
  assert.ok(stopped, "stop card explains where the chain halted");
  assert.match(stopped.content, /error/);
});

function cardsInclude(cards, needle) {
  return cards.some((card) => card.content?.includes(needle));
}
