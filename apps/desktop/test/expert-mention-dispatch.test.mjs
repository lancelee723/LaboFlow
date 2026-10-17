import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [queueSlice, mention, hook, popup, composer, composerToolbar, en, zhCN] = await Promise.all([
  read("../src/stores/slices/queue-slice.ts"),
  read("../src/stores/expert-mention.ts"),
  read("../src/hooks/use-composer-autocomplete.ts"),
  read("../src/components/ComposerAutocomplete.tsx"),
  read("../src/components/Composer.tsx"),
  read("../src/features/chat/composer/ComposerToolbar.tsx"),
  read("../../../packages/i18n/src/locales/en/index.ts"),
  read("../../../packages/i18n/src/locales/zh-CN/index.ts"),
]);
const composerSurface = [composer, composerToolbar].join("\n");

test("@ picker merges experts then teams ahead of contexts and files", () => {
  assert.match(hook, /kind: "expert"; expert: ExpertListItem; match: FuzzyMatch/);
  assert.match(hook, /kind: "team"; team: ExpertTeamListItem; match: FuzzyMatch/);
  // Order: experts, teams, conversations, files.
  assert.match(
    hook,
    /\[\.\.\.expertItems, \.\.\.teamItems, \.\.\.contexts, \.\.\.fileItems\]/,
  );
  assert.match(hook, /api\s*\.listExperts\(\)/);
  assert.match(hook, /api\s*\.listExpertTeams\(\)/);
  // Disabled entries never surface in the picker.
  assert.match(hook, /expert\.enabled !== false/);
  assert.match(hook, /team\.enabled !== false/);
});

test("accepting an expert/team item inserts the mention token", () => {
  assert.match(hook, /applyCompletion\(value, trigger, `@\$\{item\.expert\.name\} `\)/);
  assert.match(hook, /applyCompletion\(value, trigger, `@\$\{item\.team\.name\} `\)/);
});

test("popup renders two separate agent groups, experts above teams", () => {
  assert.match(popup, /t\("chat\.expertGroup"\)/);
  assert.match(popup, /t\("chat\.teamGroup"\)/);
  const expertGroup = popup.indexOf('item.kind === "expert" && lastGroup !== "expert"');
  const teamGroup = popup.indexOf('item.kind === "team" && lastGroup !== "team"');
  assert.ok(expertGroup > -1 && teamGroup > expertGroup);
});

test("group header keys exist across locales", () => {
  assert.match(en, /expertGroup: "Experts",/);
  assert.match(en, /teamGroup: "Expert teams",/);
  assert.match(zhCN, /expertGroup: "专家",/);
  assert.match(zhCN, /teamGroup: "专家团队",/);
});

test("plus menu mirrors the @ picker with a team section", () => {
  assert.match(composerSurface, /plusTeams\?\.length \? \(/);
  assert.match(composerSurface, /insertComposerText\(`@\$\{team\.name\} `\)/);
  assert.match(composerSurface, /api\s*\.listExpertTeams\(\)/);
});

test("send path dispatches teams through invokeExpertTeam with the envelope", () => {
  const dispatch = queueSlice.match(
    /const expertDispatch = await matchExpertMention\(content\);[\s\S]*?return true;\n\s*\}/,
  )?.[0] ?? "";
  assert.match(dispatch, /buildExpertDispatchTask\(expertDispatch\.task, draft\)/);
  assert.match(dispatch, /expertDispatch\.kind === "team"/);
  assert.match(dispatch, /api\.invokeExpertTeam\(\{/);
  assert.match(dispatch, /teamId: expertDispatch\.id/);
  assert.match(dispatch, /api\.invokeExpert\(\{/);
  assert.match(dispatch, /expertId: expertDispatch\.id/);
});

test("mention resolution covers both registries, experts winning ties", () => {
  // The registry fetch lives in the shared `resolveRegistries` helper both
  // the single-mention and the FR-E-17 chain parse go through.
  assert.match(mention, /async function resolveRegistries\(\)/);
  assert.match(mention, /api\s*\.listExperts\(\)/);
  assert.match(mention, /api\s*\.listExpertTeams\(\)/);
  assert.match(mention, /expert\.enabled !== false/);
  assert.match(mention, /team\.enabled !== false/);
  assert.match(mention, /kind: "expert", id: expertId, name, task/);
  assert.match(mention, /kind: "team", id: teamId, name, task/);
  // Unknown names and expert-registry outages still fall back to the agent.
  assert.match(mention, /return null/);
});
