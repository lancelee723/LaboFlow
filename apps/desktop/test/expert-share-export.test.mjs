import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { expertToMarkdown } = await import("../src/lib/expert-export.ts");

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("expert export renders frontmatter bindings plus persona body", () => {
  const md = expertToMarkdown({
    name: "数据分析专家",
    description: "严谨的数据分析师",
    industry: "TMT",
    tags: ["数据", "归因"],
    examples: ["口径对齐", "敏感性分析"],
    skills: ["sheets"],
    mcpServers: ["warehouse"],
    model: "glm/glm-5.3-flash",
    thinkingLevel: "high",
    body: "你以严谨的数据分析师身份工作……",
  });
  assert.match(md, /^---\n/);
  assert.match(md, /name: "数据分析专家"/);
  assert.match(md, /skills: \["sheets"\]/);
  assert.match(md, /mcpServers: \["warehouse"\]/);
  assert.match(md, /source: shared/);
  assert.match(md, /你以严谨的数据分析师身份工作……/);
});

test("empty optional fields collapse into the frontmatter", () => {
  const md = expertToMarkdown({ name: "极简专家", body: "正文" });
  assert.doesNotMatch(md, /description/);
  assert.doesNotMatch(md, /model/);
  assert.match(md, /tags: \[\]/);
});

test("settings page exposes export on personal experts; org precedence wired", () => {
  const page = read("../src/components/settings/AgentExpertsPage.tsx");
  assert.match(page, /downloadExpertMarkdown\(/);
  assert.match(page, /expert\.source === "user" \? \(/);
  const service = read("../electron/main/expert-service.ts");
  assert.match(service, /isOrgActive\?\./);
  assert.match(service, /const orgWins = Boolean\(orgPack && this\.deps\.isOrgActive\?\.\(\)\);/);
  const services = read("../electron/main/laboflow/services.ts");
  assert.match(services, /isOrgActive: \(\) => Boolean\(orgService\.getBootstrap\(\)\)/);
});
