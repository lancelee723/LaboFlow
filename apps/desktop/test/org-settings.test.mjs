import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const orgService = await readFile(
  new URL("../electron/main/org-service.ts", import.meta.url),
  "utf8",
);
const orgPage = await readFile(
  new URL("../src/components/settings/OrgSettingsPage.tsx", import.meta.url),
  "utf8",
);
const search = await readFile(
  new URL("../src/lib/settings-search.ts", import.meta.url),
  "utf8",
);
const settingsPage = await readFile(
  new URL("../src/pages/SettingsPage.tsx", import.meta.url),
  "utf8",
);
const protocol = await readFile(
  new URL("../../../packages/shared/src/protocol.ts", import.meta.url),
  "utf8",
);
const serverController = await readFile(
  new URL("../../../apps/server/src/app.controller.ts", import.meta.url),
  "utf8",
);

test("org service talks to the server auth/org API and stores the session in host secrets", () => {
  assert.match(orgService, /\/auth\/login/);
  assert.match(orgService, /\/auth\/change-password/);
  assert.match(orgService, /\/org\/bootstrap/);
  assert.match(orgService, /ORG_SECRET_REF = "org\/session"/);
  assert.match(orgService, /secrets\.set/);
  assert.match(orgService, /secrets\.getForRuntime/);
  // Multi-org book: signing out rewrites the book instead of deleting the ref.
  assert.match(orgService, /sessions\.filter/);
  assert.match(orgService, /setCurrent\(/);
  // 401 maps to the expired state instead of surfacing a raw error.
  assert.match(orgService, /state: "expired"/);
});

test("org settings page renders login, forced password change, and connected views", () => {
  assert.match(orgPage, /api\s*\n?\s*\.orgLogin|api\.orgLogin/);
  assert.match(orgPage, /orgLogout/);
  assert.match(orgPage, /orgStatus\(\)/);
  assert.match(orgPage, /orgChangePassword/);
  assert.match(orgPage, /mustChangePassword/);
  assert.match(orgPage, /type="password"/);
});

test("settings exposes the organization destination end to end", () => {
  assert.match(search, /id: "org"/);
  assert.match(search, /settings\.nav\.org/);
  assert.match(settingsPage, /OrgSettingsPage/);
  assert.match(settingsPage, /tab === "org"/);
  assert.match(protocol, /orgLogin: "pi-desktop\/org\/login"/);
  assert.match(protocol, /orgChangePassword: "pi-desktop\/org\/changePassword"/);
  // The client speaks the migrated server's real contract.
  assert.match(serverController, /@Post\('auth\/login'\)/);
  assert.match(serverController, /@Get\('org\/bootstrap'\)/);
});

test("phase 3: org provider sync and live quota panel", async () => {
  const main = await readFile(
    new URL("../electron/main/index.ts", import.meta.url),
    "utf8",
  );
  const orgService = await readFile(
    new URL("../electron/main/org-service.ts", import.meta.url),
    "utf8",
  );
  const usagePage = await readFile(
    new URL("../src/components/settings/TokenUsagePage.tsx", import.meta.url),
    "utf8",
  );
  // Provider sync: gateway URL + virtual key become an org-gateway provider.
  assert.match(main, /vendorKey: "org-gateway"/);
  assert.match(main, /providers\.create/);
  assert.match(main, /providers\.update/);
  assert.match(main, /providers\.delete/);
  assert.match(main, /syncOrgProvider/);
  assert.match(orgService, /getBootstrap/);
  assert.match(orgService, /quotaRemaining/);
  // Quota panel reads the live remaining API (server computes limits × counters).
  assert.match(usagePage, /orgQuotaRemaining/);
  assert.match(usagePage, /usage-quota-card/);
  assert.match(serverController, /@Get\('quota\/remaining'\)/);
  assert.match(serverController, /quotaCounters/);
  // Threshold colors per PRD 4.2.4: exhausted → error, near → warning.
  // Threshold colors per PRD 4.2.4: exhausted → error, near → warning.
  assert.match(usagePage, /is-\$\{tone\}/);
  assert.match(usagePage, /worst >= 1 \? "error" : worst >= 0\.8 \? "warning"/);
});
