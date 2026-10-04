import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { parseCredentialBlob, CHANNEL_CREDENTIAL_FIELDS } = await import(
  "../src/lib/channel-credentials.ts"
);

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("parses a feishu console block with mixed zh/en labels and bullets", () => {
  const blob = [
    "应用凭证",
    "- App ID: cli_a1b2c3d4e5",
    "  App Secret：s3cr3t-value",
    "Verification Token: vtoken01",
    "Encrypt Key: ek123",
    "（此页面包含敏感信息，请妥善保管）",
  ].join("\n");
  const parsed = parseCredentialBlob("feishu", blob);
  assert.equal(parsed.appId, "cli_a1b2c3d4e5");
  assert.equal(parsed.appSecret, "s3cr3t-value");
  assert.equal(parsed.verificationToken, "vtoken01");
  assert.equal(parsed.encryptKey, "ek123");
});

test("parses wecom bot_id/bot_secret in snake_case", () => {
  const blob = "bot_id: wxbot01\nbot_secret: sec098\n";
  const parsed = parseCredentialBlob("wecom", blob);
  assert.equal(parsed.botId, "wxbot01");
  assert.equal(parsed.secret, "sec098");
});

test("parses wechat_mp relay url and ignores prose labels", () => {
  const blob = [
    "请先在管理台完成公众号配置。",
    "server_url: https://relay.example.com",
    "Bot ID: mpbot7",
  ].join("\n");
  const parsed = parseCredentialBlob("wechat_mp", blob);
  assert.equal(parsed.serverUrl, "https://relay.example.com");
  assert.equal(parsed.botId, "mpbot7");
});

test("empty values stay absent so empty-means-unchanged survives", () => {
  const parsed = parseCredentialBlob("feishu", "App ID: \nApp Secret:\nApp ID : ");
  assert.deepEqual(parsed, {});
});

test("every provider declares at least its primary secret field", () => {
  assert.ok(CHANNEL_CREDENTIAL_FIELDS.feishu.some((f) => f.key === "appSecret" && f.secret));
  assert.ok(CHANNEL_CREDENTIAL_FIELDS.wecom.some((f) => f.key === "secret" && f.secret));
  // wechat_mp holds only the relay URL client-side; real MP secrets live on
  // the server relay (admin console) by design.
  assert.ok(CHANNEL_CREDENTIAL_FIELDS.wechat_mp.some((f) => f.key === "serverUrl"));
  assert.ok(!CHANNEL_CREDENTIAL_FIELDS.wechat_mp.some((f) => f.secret && f.key !== "serverUrl"));
});

test("settings IA declares the assistant tab and mounts the channel page", async () => {
  const [search, page, i18nEn, i18nZh] = await Promise.all([
    read("../src/lib/settings-search.ts"),
    read("../src/features/settings/SettingsPage.tsx"),
    read("../../../packages/i18n/src/locales/en/index.ts"),
    read("../../../packages/i18n/src/locales/zh-CN/index.ts"),
  ]);
  assert.match(search, /\| "assistant"/);
  assert.match(search, /id: "assistant"/);
  assert.match(search, /labelKey: "settings\.nav\.assistant"/);
  assert.match(page, /AssistantChannelsPage/);
  assert.match(page, /tab === "assistant"/);
  assert.match(i18nEn, /assistantTitle: "IM channels"/);
  assert.match(i18nZh, /assistantTitle: "IM通道"/);
  for (const key of ["feishuAppId", "feishuAppSecret", "wecomSecret", "wechatServerUrl", "credentialUnchanged"]) {
    assert.match(i18nEn, new RegExp(`\\b${key}:`), `en missing ${key}`);
  }
});

test("channel card never echoes stored secrets back into inputs", async () => {
  const src = await read("../src/components/settings/AssistantChannelsPage.tsx");
  // Credential inputs are bound to the local draft only — the account view's
  // hasCredentials flag renders the "stored, keep empty" placeholder instead.
  assert.match(src, /type=\{field\.secret \? "password" : "text"\}/);
  assert.match(src, /credentialUnchanged/);
  assert.doesNotMatch(src, /account\.credentials/);
});
