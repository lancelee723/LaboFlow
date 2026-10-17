import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ForegroundSessionRegistry } from "../electron/main/expert-foreground.ts";
import { TeamRunner } from "../electron/main/team-runner.ts";

const expertServiceSource = await readFile(
  new URL("../electron/main/expert-service.ts", import.meta.url),
  "utf8",
);
const indexSource = await readFile(
  new URL("../electron/main/index.ts", import.meta.url),
  "utf8",
);
const agentIpcSource = await readFile(
  new URL("../electron/main/ipc/agent-ipc.ts", import.meta.url),
  "utf8",
);
const laboflowServicesSource = await readFile(
  new URL("../electron/main/laboflow/services.ts", import.meta.url),
  "utf8",
);
const appStoreSource = await readFile(
  new URL("../src/stores/slices/queue-slice.ts", import.meta.url),
  "utf8",
);

function makeRegistry() {
  const dir = mkdtempSync(join(tmpdir(), "expert-fg-"));
  return new ForegroundSessionRegistry(dir);
}

test("foreground registry persists bindings across instances", () => {
  const dir = mkdtempSync(join(tmpdir(), "expert-fg-"));
  const first = new ForegroundSessionRegistry(dir);
  first.register("s1", {
    kind: "expert",
    id: "数据分析专家",
    name: "数据分析专家",
    personaPrompt: "你是数据分析专家。",
  });
  assert.ok(existsSync(join(dir, "expert-sessions.json")));

  const second = new ForegroundSessionRegistry(dir);
  // lookup returns the full binding record (persona + optional tool list).
  assert.equal(second.lookup("s1")?.personaPrompt, "你是数据分析专家。");
  assert.equal(second.lookup("missing"), undefined);

  second.forget("s1");
  assert.equal(second.lookup("s1"), undefined);
});

test("registry tolerates a corrupt file and starts empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "expert-fg-"));
  const file = join(dir, "expert-sessions.json");
  writeFileSync(file, "{not json", "utf8");
  const registry = new ForegroundSessionRegistry(dir);
  assert.equal(registry.lookup("s1"), undefined);
  registry.register("s1", {
    kind: "team",
    id: "t",
    name: "T",
    personaPrompt: "p",
    tools: ["Read"],
  });
  assert.equal(registry.lookup("s1")?.personaPrompt, "p");
  assert.deepEqual(registry.lookup("s1")?.tools, ["Read"]);
});

test("team invoke streams into a NEW session and registers the moderator persona", async () => {
  const started = [];
  const cards = [];
  const cardTargets = [];
  const created = [];
  const registered = {};
  const runner = new TeamRunner({
    getLogger: () => ({ app() {} }),
    getDriver: () => ({
      start: async (request) => {
        started.push(request);
        return {
          sessionId: `m-${started.length}`,
          completion: Promise.resolve({
            sessionId: `m-${started.length}`,
            status: "completed",
            finalText: "",
            usage: { totalTokens: 0 },
          }),
        };
      },
    }),
    getOneShotProvider: async () => null,
    resolveTeam: async () => ({
      name: "咨询交付团",
      description: "",
      members: ["行业研究员"],
      leaderStyle: "fine",
      integration: "moderator",
      body: "【拆解指令】p\n【整合指令】q",
    }),
    resolvePersona: async (id) => ({ name: id, personaPrompt: `你是${id}` }),
    broadcast: () => {},
    postSessionCard: async (sessionId, message) => {
      cardTargets.push(sessionId);
      cards.push(message);
    },
    getProjectPath: async (sessionId) =>
      sessionId === "parent-9" ? "/proj/team" : undefined,
    createSession: async (input) => {
      const id = `fg-${created.length + 1}`;
      created.push({ id, ...input });
      return { id };
    },
    foregroundRegistry: {
      register: (sessionId, record) => {
        registered[sessionId] = record;
      },
    },
  });

  const result = await runner.invoke({
    sessionId: "parent-9",
    teamId: "t",
    task: "交付研究",
  });

  assert.equal(result.sessionId, "fg-1");
  assert.equal(created[0].projectPath, "/proj/team");
  assert.match(created[0].title, /^咨询交付团 · /);
  // Kickoff milestone posts to the new session, and the moderator persona is
  // registered for follow-up questions after the run settles.
  assert.equal(cardTargets[0], "fg-1");
  assert.match(cards[0].content, /已受理/);
  assert.equal(registered["fg-1"].kind, "team");
  assert.ok(registered["fg-1"].personaPrompt.includes("【整合指令】"));
});

test("expert invoke foregrounds: session.create, driver on the new session, no back-posted card", () => {
  // The lifecycle lives in `invokeWithCompletion` (FR-E-17 split so a serial
  // chain can await the first turn); plain `invoke` is a thin delegate.
  const invoke = expertServiceSource.match(
    /async invokeWithCompletion\([\s\S]*?return \{ sessionId, completion: run\.completion \};\n  \}/,
  )?.[0] ?? "";
  assert.match(expertServiceSource, /await this\.invokeWithCompletion\(request\)/);
  assert.match(invoke, /session\.create/);
  assert.match(invoke, /projectPath/);
  assert.match(invoke, /mode: "agent"/);
  assert.match(invoke, /title: `\$\{persona\.name\} · \$\{request\.task\.slice\(0, 24\)\}`/);
  // First turn runs on the created session with the persona — through the
  // FR-PPT-15 structured skill binding, never the raw persona alone.
  assert.match(invoke, /driver\.start\(\{\s*sessionId,/);
  assert.match(invoke, /withToolsClause\(\s*withSkillsBinding\(persona\.personaPrompt, persona\.skills\)/);
  assert.match(invoke, /personaPrompt: boundPrompt/);
  // Tool allowlist (module 01 polish): rides the registry record and the
  // first-turn driver request.
  assert.match(invoke, /\.\.\.\(persona\.tools\.length \? \{ tools: persona\.tools \} : \{\}\)/);
  assert.match(invoke, /\.\.\.\(persona\.tools\.length \? \{ allowedTools: persona\.tools \} : \{\}\)/);
  assert.doesNotMatch(invoke, /newSession:/);
  // Foreground polish: no completion card is posted anywhere.
  assert.doesNotMatch(invoke, /postSessionCard/);
  assert.match(invoke, /foregroundRegistry\.register\(sessionId/);
});

test("agentPrompt keeps the expert persona via the laboflow service factory", () => {
  // T6.0 remount: the persona lookup lives in the IPC layer, the registry
  // wiring lives next to the service construction in the laboflow factory.
  assert.match(agentIpcSource, /expertPersona = resolveExpertPersona\?\.\(req\.sessionId\)/);
  assert.match(
    agentIpcSource,
    /\.\.\.\(expertPersona \? \{ personaPrompt: expertPersona\.personaPrompt \} : \{\}\)/,
  );
  assert.match(
    agentIpcSource,
    /\.\.\.\(expertPersona\?\.tools\?\.length \? \{ allowedTools: expertPersona\.tools \} : \{\}\)/,
  );
  assert.match(laboflowServicesSource, /new ForegroundSessionRegistry\(dataDir\)/);
  assert.match(laboflowServicesSource, /foregroundRegistry: expertForegroundRegistry/);
  // index.ts feeds the resolver into the upstream IPC dependency surface.
  assert.match(
    indexSource,
    /resolveExpertPersona: \(sessionId: string\) =>\s*laboflow\.services\.expertService\.foregroundRecord\(sessionId\)/,
  );
});

test("@mention dispatch navigates to the new expert session", () => {
  const dispatch = appStoreSource.match(
    /const expertDispatch = await matchExpertMention\(content\);[\s\S]*?return true;\n\s*\}/,
  )?.[0] ?? "";
  assert.match(dispatch, /dispatchedSessionId = result\.sessionId/);
  assert.match(dispatch, /await get\(\)\.refreshSessions\(\)/);
  assert.match(dispatch, /await get\(\)\.selectSession\(dispatchedSessionId\)/);
});

test("FR-PPT-15: withSkillsBinding renders the structured binding block", async () => {
  const { withSkillsBinding } = await import("../electron/main/expert-service.ts");
  const bare = withSkillsBinding("你是专家。", []);
  assert.equal(bare, "你是专家。", "no skills → no binding block");
  const bound = withSkillsBinding("你是专家。", ["ppt-master", "chart-helper"]);
  assert.match(bound, /## 工具链绑定（结构化声明）/);
  assert.match(bound, /ppt-master/);
  assert.match(bound, /chart-helper/);
});
