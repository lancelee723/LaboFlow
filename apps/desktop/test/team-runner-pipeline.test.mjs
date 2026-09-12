import assert from "node:assert/strict";
import test from "node:test";

import { extractJson, TeamRunner } from "../electron/main/team-runner.ts";

/** Scripted headless driver: records prompts, answers from a queue of strings or fns. */
function scriptDriver(sessions) {
  const started = [];
  const driver = {
    start: async (request) => {
      started.push(request);
      const next = sessions.length ? sessions.shift() : "";
      const finalText = typeof next === "function" ? next(request) : next;
      return {
        sessionId: `s-${started.length}`,
        completion: Promise.resolve({
          sessionId: `s-${started.length}`,
          status: "completed",
          finalText,
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        }),
      };
    },
  };
  return { started, driver };
}

const TEAM = {
  name: "咨询交付团",
  description: "管线测试",
  members: ["行业研究员", "数据分析专家", "审稿人"],
  leaderStyle: "fine",
  integration: "moderator",
  body: "【拆解指令】x\n【整合指令】y",
};

function makeRunner({ driver, team, unknownExperts = [] }) {
  const broadcasts = [];
  const cards = [];
  const runner = new TeamRunner({
    getLogger: () => ({ app() {} }),
    getDriver: () => driver,
    getOneShotProvider: async () => null,
    resolveTeam: async () => ({ ...TEAM, ...team }),
    resolvePersona: async (id) => {
      if (unknownExperts.includes(id)) return null;
      return { name: id, personaPrompt: `你是${id}`, skills: [], mcpServers: [] };
    },
    broadcast: (event) => broadcasts.push(event),
    postSessionCard: async (_sessionId, message) => {
      cards.push(message);
    },
    getProjectPath: async () => undefined,
  });
  return { runner, broadcasts, cards };
}

/** Wait until the run reaches done/failed (broadcasts settle). */
async function settle(broadcasts) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (broadcasts.some((event) => event.type === "integrated" || event.type === "failed")) {
      return broadcasts.find((event) => event.type === "integrated" || event.type === "failed");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("pipeline did not settle");
}

function stageFrames(broadcasts) {
  return broadcasts
    .filter((event) => event.type === "member" && event.payload?.stage)
    .map((event) => event.payload.stage);
}

test("extractJson tolerates fenced and embedded JSON", () => {
  const plan = extractJson('```json\n{"subtasks":[{"expert":"A","brief":"x","dependsOn":[]}]}\n```');
  assert.equal(plan?.subtasks.length, 1);
  assert.equal(extractJson("no json here"), null);
});

test("pipeline stages run in order with summaries handed downstream", async () => {
  const { started, driver } = scriptDriver(["分析结论A", "基于A的测算B", "基于B的评审C"]);
  const { runner, broadcasts, cards } = makeRunner({
    driver,
    team: {
      pipeline: "分析|测算|评审",
      stageExperts: "分析=行业研究员, 测算=数据分析专家, 评审=审稿人",
    },
  });
  await runner.invoke({ sessionId: "parent-1", teamId: "t", task: "交付研究" });
  await settle(broadcasts);

  assert.deepEqual(
    stageFrames(broadcasts).map((frame) => [frame.index, frame.name, frame.expert]),
    [
      [1, "分析", "行业研究员"],
      [2, "测算", "数据分析专家"],
      [3, "评审", "审稿人"],
    ],
  );
  const integrated = broadcasts.find((event) => event.type === "integrated");
  assert.equal(integrated.payload.integrated, "基于B的评审C");
  assert.match(started[1].prompt, /分析结论A/);
  assert.match(started[2].prompt, /基于A的测算B/);
  assert.match(started[0].prompt, /\[管线阶段 1\/3：分析\]/);
  assert.equal(cards.length, 1);
  assert.match(cards[0].content, /管线：分析 → 测算 → 评审/);
});

test("goal mode repeats until [LOOP:DONE] or maxRounds cap", async () => {
  const { started, driver } = scriptDriver([
    () => `[LOOP:NEXT] 第一轮：完成一半。剩余：数据核对。`,
    () => `[LOOP:NEXT] 第二轮：接近完成。`,
    () => `[LOOP:DONE] 全部完成，理由：阻断项清零。`,
  ]);
  const { runner, broadcasts } = makeRunner({
    driver,
    team: { pipeline: "评审", stageExperts: "评审=审稿人", goal: "阻断项清零", maxRounds: 5 },
  });
  await runner.invoke({ teamId: "t", task: "审阅交付" });
  await settle(broadcasts);

  assert.equal(started.length, 3, "stops at the DONE verdict");
  assert.match(started[1].prompt, /第 2\/5 轮/);
  assert.match(started[1].prompt, /第一轮：完成一半/);
  const integrated = broadcasts.find((event) => event.type === "integrated");
  assert.match(integrated.payload.integrated, /阻断项清零/);
});

test("goal mode hard-stops at maxRounds without DONE and reports failure", async () => {
  const { started, driver } = scriptDriver([
    () => `[LOOP:NEXT] r1`,
    () => `[LOOP:NEXT] r2`,
    () => `[LOOP:NEXT] r3`,
  ]);
  const { runner, broadcasts } = makeRunner({
    driver,
    team: { pipeline: "评审", stageExperts: "评审=审稿人", goal: "永不满足", maxRounds: 3 },
  });
  await runner.invoke({ teamId: "t", task: "x" });
  const last = await settle(broadcasts);
  assert.equal(started.length, 3, "maxRounds cap");
  assert.equal(last.type, "failed");
  assert.match(String(last.payload.error), /after 3 rounds/);
});

test("budget exhaustion fails the pipeline before a stage starts", async () => {
  const { started, driver } = scriptDriver(["唯一产出"]);
  const { runner, broadcasts } = makeRunner({
    driver,
    team: {
      pipeline: "分析|测算",
      stageExperts: "分析=行业研究员, 测算=数据分析专家",
      budgetTokens: 10, // 30 tokens per round exhausts after stage 1
    },
  });
  await runner.invoke({ teamId: "t", task: "x" });
  const last = await settle(broadcasts);
  assert.equal(started.length, 1);
  assert.equal(last.type, "failed");
  assert.equal(last.payload.budget, true);
});

test("unknown stage expert fails the run with a readable error", async () => {
  const { started, driver } = scriptDriver([]);
  const { runner, broadcasts } = makeRunner({
    driver,
    team: { pipeline: "分析", stageExperts: "分析=不存在的人" },
    unknownExperts: ["不存在的人"],
  });
  await runner.invoke({ teamId: "t", task: "x" });
  const last = await settle(broadcasts);
  assert.equal(started.length, 0);
  assert.equal(last.type, "failed");
  assert.match(String(last.payload.error), /不存在的人/);
});
