/**
 * 「粘贴一段自动识别」(FR-IM-02): users copy whole credential blocks from the
 * platform consoles; split field labels from values here so the channel card
 * can fill its inputs without manual copying. Pure functions — no Electron.
 */

import type { ChannelProvider } from "@pi-desktop/shared";

/** One credential field of a channel card, with every label it may carry in
 * a pasted console block (en/zh variants, snake/camel both accepted). */
export interface ChannelCredentialField {
  key: string;
  labelKey: string;
  /** True for secret inputs (masked, never echoed back after save). */
  secret?: boolean;
  /** Label matchers, case-insensitive, matched against each pasted line. */
  patterns: RegExp[];
}

export const CHANNEL_CREDENTIAL_FIELDS: Record<
  ChannelProvider,
  ChannelCredentialField[]
> = {
  feishu: [
    {
      key: "appId",
      labelKey: "settings.assistant.feishuAppId",
      patterns: [/^app\s*id$/, /^app_id$/, /^应用ID$/, /^应用 id$/],
    },
    {
      key: "appSecret",
      labelKey: "settings.assistant.feishuAppSecret",
      secret: true,
      patterns: [/^app\s*secret$/, /^app_secret$/, /^应用密钥$/, /^应用凭证$/],
    },
    {
      key: "verificationToken",
      labelKey: "settings.assistant.feishuVerificationToken",
      secret: true,
      patterns: [/^verification\s*token$/, /^verification_token$/, /^验证令牌$/],
    },
    {
      key: "encryptKey",
      labelKey: "settings.assistant.feishuEncryptKey",
      secret: true,
      patterns: [/^encrypt\s*key$/, /^encrypt_key$/, /^加密密钥$/, /^encryptkey$/],
    },
  ],
  wecom: [
    {
      key: "botId",
      labelKey: "settings.assistant.wecomBotId",
      patterns: [/^bot\s*id$/, /^bot_id$/, /^机器人ID$/, /^机器人 id$/],
    },
    {
      key: "secret",
      labelKey: "settings.assistant.wecomSecret",
      secret: true,
      patterns: [/^secret$/, /^bot\s*secret$/, /^密钥$/, /^token$/],
    },
  ],
  wechat_mp: [
    {
      key: "serverUrl",
      labelKey: "settings.assistant.wechatServerUrl",
      patterns: [/^server\s*url$/, /^server_url$/, /^中继地址$/, /^服务地址$/, /^relay/],
    },
    {
      key: "botId",
      labelKey: "settings.assistant.wechatBotId",
      patterns: [/^bot\s*id$/, /^bot_id$/, /^机器人ID$/],
    },
  ],
};

/** Strip list bullets, quotes and trailing punctuation from a pasted value. */
function cleanValue(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`「『]+|["'`」』]+$/g, "")
    .replace(/[,;，；。]+$/, "")
    .trim();
}

function splitLabelValue(line: string): { label: string; value: string } | null {
  // "label: value" / "label：value" / "label value"
  const match = line.match(/^([^:：]+)[:：]\s*(.+)$/);
  if (match) return { label: match[1].trim(), value: match[2].trim() };
  const loose = line.match(/^(\S+)\s{2,}(\S+)$/);
  if (loose) return { label: loose[1].trim(), value: loose[2].trim() };
  return null;
}

/**
 * Parse a pasted credential block into `{fieldKey: value}` for one provider.
 * Unknown labels are ignored (console pages carry prose); values already
 * present in the blob win nothing — first match per field wins. Only
 * non-empty values are returned so "empty means unchanged" survives.
 */
export function parseCredentialBlob(
  provider: ChannelProvider,
  blob: string,
): Record<string, string> {
  const fields = CHANNEL_CREDENTIAL_FIELDS[provider] ?? [];
  const parsed: Record<string, string> = {};
  for (const rawLine of blob.split(/\r?\n/)) {
    const line = rawLine
      .trim()
      .replace(/^[-*•·\d.)\]\s]+/, "")
      .trim();
    if (!line) continue;
    const pair = splitLabelValue(line);
    if (!pair) continue;
    const label = pair.label.toLowerCase().replace(/[\s_]+/g, " ").trim();
    for (const field of fields) {
      if (parsed[field.key]) continue;
      if (field.patterns.some((pattern) => pattern.test(label))) {
        const value = cleanValue(pair.value);
        if (value) parsed[field.key] = value;
        break;
      }
    }
  }
  return parsed;
}
