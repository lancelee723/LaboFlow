import assert from "node:assert/strict";
import test from "node:test";

import { SETTINGS_NAV } from "../src/lib/settings-search.ts";

const LOCALES = [
  "en",
  "zh-CN",
  "zh-TW",
  "tr",
  "de",
  "es",
  "fr",
  "ko",
  "pt-BR",
];

const catalogs = Object.fromEntries(
  LOCALES.map((locale) => [
    locale,
    import(`../../../packages/i18n/dist/locales/${locale}/index.js`).then(
      (mod) => mod.default ?? mod[Object.keys(mod).find((key) => key !== "default")],
    ),
  ]),
);

test("settings nav hosts an extensions destination in the agent group", () => {
  const entry = SETTINGS_NAV.find((item) => item.id === "extensions");
  assert.ok(entry, "SETTINGS_NAV is missing the extensions destination");
  assert.equal(entry.group, "agent");
  assert.equal(entry.labelKey, "settings.nav.extensions");
});

test("the extensions destination sits between Skills and MCP", () => {
  const ids = SETTINGS_NAV.map((item) => item.id);
  const skills = ids.indexOf("skills");
  const extensions = ids.indexOf("extensions");
  const mcp = ids.indexOf("mcp");
  assert.ok(skills >= 0, "skills destination missing");
  assert.ok(mcp >= 0, "mcp destination missing");
  assert.ok(
    skills < extensions && extensions < mcp,
    `expected skills < extensions < mcp, got ${skills} < ${extensions} < ${mcp}`,
  );
});

test("every locale names the destination and its page title", async () => {
  for (const locale of LOCALES) {
    const catalog = await catalogs[locale];
    const nav = catalog.settings?.nav;
    assert.ok(nav, `${locale}: settings.nav missing`);
    assert.ok(
      typeof nav.extensions === "string" && nav.extensions.length > 0,
      `${locale}: settings.nav.extensions missing`,
    );
    assert.ok(
      typeof catalog.settings?.extensions === "string",
      `${locale}: settings.extensions page title missing`,
    );
  }
});

test("the settings page mounts the shared plugins workbench for the tab", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const pageSource = await readFile(
    join(here, "../src/features/settings/SettingsPage.tsx"),
    "utf8",
  );
  assert.match(pageSource, /tab === "extensions" && <AgentExtensionsPage/);
  assert.match(pageSource, /extensions: <IconPlug size=\{14\} \/>/);

  const componentSource = await readFile(
    join(here, "../src/components/settings/AgentExtensionsPage.tsx"),
    "utf8",
  );
  assert.match(componentSource, /usePluginsPage\(\)/);
  assert.match(componentSource, /InstalledPluginsPanel/);
  assert.match(componentSource, /MarketplacePanel/);
  assert.match(componentSource, /PluginDetailSheet/);
  assert.match(componentSource, /PluginDialogs/);
});
