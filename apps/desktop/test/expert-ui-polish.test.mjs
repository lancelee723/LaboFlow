import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [page, multiSelect, css, en, zhCN] = await Promise.all([
  read("../src/components/settings/AgentExpertsPage.tsx"),
  read("../src/components/settings/AgentMultiSelect.tsx"),
  read("../src/styles/settings.css"),
  read("../../../packages/i18n/src/locales/en/index.ts"),
  read("../../../packages/i18n/src/locales/zh-CN/index.ts"),
]);

test("required fields carry the red asterisk and armed error state", () => {
  // Expert editor: name + description required.
  assert.match(page, /label=\{t\("expert\.fieldName"\)\}\s*required/);
  assert.match(page, /label=\{t\("expert\.fieldDescription"\)\} required error=\{descriptionError\}/);
  // Team editor: name + description + members required.
  assert.match(page, /teamErrorsArmed && !teamForm\.name\.trim\(\)/);
  assert.match(page, /teamErrorsArmed && !teamForm\.description\.trim\(\)/);
  assert.match(page, /teamErrorsArmed && !teamForm\.members\.length/);
  // Errors arm on save, never block silent saves.
  assert.match(page, /setExpertErrorsArmed\(true\)/);
  assert.match(page, /setTeamErrorsArmed\(true\)/);
  // The asterisk renders and the red title clears via live re-evaluation.
  assert.match(page, /className=\{cx\("ext-field-label", error && "is-error"\)\}/);
  assert.match(css, /\.ext-field-label \.required-mark/);
  assert.match(css, /\.ext-field-label\.is-error \{/);
});

test("MCP servers list comes from the GLOBAL config with an inline add sheet", () => {
  assert.match(page, /api\.listMcpServers\(\{ level: "global" \}\)/);
  assert.match(page, /mcpServers: \[\]/);
  assert.match(page, /toggleFormMcp\(/);
  assert.match(page, /McpEditorSheet/);
  assert.match(page, /api\.upsertMcpServer\(/);
  assert.match(page, /draftToInput\(mcpEditorDraft, \{ level: "global" \}\)/);
  // The "Add" button lives in the MCP field title row; no comma-separation hint.
  assert.match(page, /t\("expert\.mcpAdd"\)/);
  assert.doesNotMatch(page, /splitList\(form\.mcpServers\)/);
  assert.match(zhCN, /mcpHint: "[^"]*勾选全局 MCP 服务器[^"]*"/);
  assert.doesNotMatch(zhCN, /mcpHint: "[^"]*逗号[^"]*"/);
});

test("skills use the dropdown multi-select", () => {
  assert.match(page, /AgentMultiSelect/);
  assert.match(page, /onChange=\{\(next\) => setForm\(\(current\) => \(\{ \.\.\.current, skills: next \}\)\)\}/);
  assert.match(multiSelect, /type="checkbox"/);
  assert.match(zhCN, /skillsSelect: "选择技能"/);
});

test("preset experts are editable and shadow via same-name save", () => {
  // Every (non-org) expert row exposes the editor, presets included.
  const row = page.match(/const renderExpertRow = \(expert: ExpertListItem\) => \{[\s\S]*?\n  \};/)?.[0] ?? "";
  assert.match(row, /void openExpertEditor\(expert\)/);
  // Preset name is immutable (shadowing depends on the name).
  assert.match(page, /disabled=\{editingPreset\}/);
  assert.match(zhCN, /presetNameHint: "预设专家名称不可修改/);
});

test("invoke dialog dispatches into a new session and navigates there", () => {
  assert.match(page, /t\("expert\.newSessionNote"\)/);
  assert.doesNotMatch(page, /expert\.targetSession/);
  assert.match(page, /await selectSession\(result\.sessionId\)/);
  const team = page.match(/const submitTeamInvoke = async \(\) => \{[\s\S]*?\n  \};/)?.[0] ?? "";
  assert.match(team, /await selectSession\(result\.sessionId\)/);
});

test("page lists experts and teams with capability rows in groups", () => {
  assert.match(page, /CapabilityGroupHeader label=\{t\("expert\.tabTeams"\)\} path="~\/\.agents\/teams"/);
  assert.match(page, /CapabilityGroupHeader\s+label=\{t\("expert\.tabMine"\)\}/);
  assert.match(page, /CapabilityGroupHeader label=\{t\("expert\.tabCenter"\)\}/);
  assert.match(page, /teams\.map\(renderTeamRow\)/);
  assert.match(page, /mineGroup\.map\(renderExpertRow\)/);
  assert.match(page, /presetGroup\.map\(renderExpertRow\)/);
  // No more squeezed card grids / dest rows for experts and teams.
  assert.doesNotMatch(page, /renderExpertCard/);
  assert.doesNotMatch(page, /renderTeamCard/);
});

test("group header keys exist across locales", () => {
  assert.match(en, /skillsSelect: "Select skills"/);
  assert.match(en, /mcpAdd: "Add"/);
  assert.match(en, /newSessionNote: "The task runs in a NEW conversation/);
});
