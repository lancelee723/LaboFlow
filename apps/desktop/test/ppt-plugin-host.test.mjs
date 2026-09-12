/**
 * Host-side integration via the official @pi-desktop/plugin-sdk — the only
 * test facility the Pi plugin spec ships. These tests run the SAME manifest
 * and contribution validation the installer runs, so a green run here means
 * the plugin would install: schema conformance, permission linkage, skill
 * contract, view icon tokens and the agent-tool namespace rules.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  pluginToolName,
  resolvePluginLocalizedString,
  validateContributions,
  validateManifest,
} from "@pi-desktop/plugin-sdk";

const manifestRaw = JSON.parse(
  readFileSync(resolve("resources/plugins/laboflow.slides/manifest.json"), "utf8"),
);

test("manifest passes the official validator (install-time rules)", () => {
  const verdict = validateManifest(manifestRaw);
  assert.equal(verdict.ok, true, `manifest rejected: ${verdict.error}`);
  assert.equal(manifestRaw.schemaVersion, 1);
  assert.match(manifestRaw.id, /^[a-z0-9]+(\.[a-z0-9_-]+)+$/);
});

test("contributions pass the official validator (permissions + files)", () => {
  const error = validateContributions(manifestRaw.contributes);
  assert.equal(error, undefined, `contribution error: ${error}`);
});

test("agent tool names survive the mandatory plugin namespace", () => {
  for (const tool of manifestRaw.contributes.agentTools) {
    const runtimeName = pluginToolName(manifestRaw.id, tool.name);
    assert.equal(runtimeName, `plugin_laboflow_slides_${tool.name}`);
    assert.match(runtimeName, /^plugin_[a-z0-9_]+_[a-zA-Z][a-zA-Z0-9_]*$/);
    assert.ok(tool.description.length >= 10, `${tool.name} needs a searchable description`);
    assert.ok(["low", "medium", "high"].includes(tool.risk), `${tool.name} risk must be explicit`);
  }
});

test("skills satisfy the Pi contract (frontmatter fields, length caps)", () => {
  for (const skill of manifestRaw.contributes.skills) {
    const path = typeof skill === "string" ? skill : skill.path;
    const source = readFileSync(resolve("resources/plugins/laboflow.slides", path), "utf8");
    const frontmatter = source.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(frontmatter, `${path} needs frontmatter`);
    assert.match(frontmatter[1], /^name:\s*\S+/m, `${path} needs a name`);
    assert.match(frontmatter[1], /^description:/m, `${path} needs a description`);
    assert.ok(Buffer.byteLength(source, "utf8") <= 128 * 1024, `${path} exceeds 128 KiB`);
  }
});

test("panel and view titles localize and the view icon is a host token", () => {
  const title = resolvePluginLocalizedString(manifestRaw.ui.title, "zh-CN");
  assert.ok(title.length > 0);
  const view = manifestRaw.contributes.views[0];
  assert.ok(resolvePluginLocalizedString(view.title, "en").length > 0);
});

test("no settings entry can hold a secret", () => {
  for (const setting of manifestRaw.contributes.settings ?? []) {
    assert.notEqual(setting.secret, true, "settings must never be secret-bearing");
  }
});
