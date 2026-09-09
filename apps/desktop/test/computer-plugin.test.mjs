import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(
  await readFile(
    new URL("../resources/plugins/pi.computer/manifest.json", import.meta.url),
    "utf8",
  ),
);
const main = await readFile(
  new URL("../resources/plugins/pi.computer/main.js", import.meta.url),
  "utf8",
);

test("pi.computer manifest declares a high-risk computer tool behind an enable switch", () => {
  assert.equal(manifest.id, "pi.computer");
  assert.equal(manifest.permissions.includes("agent.tool.register"), true);
  const tool = manifest.contributes.agentTools[0];
  assert.equal(tool.name, "computer");
  assert.equal(tool.risk, "high");
  assert.deepEqual(tool.schema.required, ["action"]);
  const enabled = manifest.contributes.settings.find(
    (setting) => setting.key === "enabled",
  );
  assert.equal(enabled.default, false, "computer use must ship disabled");
});

test("pi.computer main gates on settings, platform, accessibility, and emergency stop", () => {
  assert.match(main, /process\.platform !== "darwin"/);
  assert.match(main, /setToolRegistered\(Boolean\(settings\.enabled\)\)/);
  assert.match(main, /unregisterTool\("computer"\)/);
  assert.match(main, /osascript/);
  assert.match(main, /screencapture/);
  assert.match(main, /accessibilityGranted/);
  assert.match(main, /emergency-stopped/i);
  assert.match(main, /key code \$\{key\}/);
});
