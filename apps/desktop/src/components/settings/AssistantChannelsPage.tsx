import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ChannelAccountView,
  ChannelProvider,
  ChannelState,
  ChannelTestResult,
  DiagInfo,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Badge, Button } from "../ui";
import { CHANNEL_CREDENTIAL_FIELDS, parseCredentialBlob } from "../../lib/channel-credentials";

/**
 * Settings → Assistant (module 04, FR-IM-01/02/03): one card per IM channel.
 * Credentials are paste-in, masked, and never echoed back — empty inputs mean
 * "unchanged" and cannot clobber a stored secret (registry enforces, UI
 * mirrors). Connection states stream in via `IPC.event.channelState`.
 */

const PROVIDERS: ChannelProvider[] = ["feishu", "wecom", "wechat_mp"];

const PROVIDER_LABEL_KEYS: Record<ChannelProvider, string> = {
  feishu: "settings.assistant.feishuTitle",
  wecom: "settings.assistant.wecomTitle",
  wechat_mp: "settings.assistant.wechatTitle",
};

const PROVIDER_HELP_KEYS: Record<ChannelProvider, string> = {
  feishu: "settings.assistant.feishuHelp",
  wecom: "settings.assistant.wecomHelp",
  wechat_mp: "settings.assistant.wechatHelp",
};

const STATE_LABEL_KEYS: Record<ChannelState, string> = {
  disconnected: "settings.assistant.stateDisconnected",
  connecting: "settings.assistant.stateConnecting",
  connected: "settings.assistant.stateConnected",
  error: "settings.assistant.stateError",
};

const DIAG_KIND_KEYS: Record<DiagInfo["kind"], string> = {
  network: "settings.assistant.diagNetwork",
  credential: "settings.assistant.diagCredential",
  permission: "settings.assistant.diagPermission",
  publish: "settings.assistant.diagPublish",
  unknown: "settings.assistant.diagUnknown",
};

type Draft = {
  name: string;
  scope: "p2p" | "group" | "both";
  allowlist: string;
  credentials: Record<string, string>;
};

function emptyDraft(): Draft {
  return { name: "", scope: "both", allowlist: "", credentials: {} };
}

export function AssistantChannelsPage() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [accounts, setAccounts] = useState<ChannelAccountView[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [pasteOpen, setPasteOpen] = useState<ChannelProvider | null>(null);
  const [pasteText, setPasteText] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .channelsList()
      .then((rows) => {
        if (!cancelled) setAccounts(rows ?? []);
      })
      .catch(() => {
        if (!cancelled) setAccounts([]);
      });
    const off = api.onChannelState((event) => {
      setAccounts((current) =>
        (current ?? []).map((account) =>
          account.id === event.accountId
            ? {
                ...account,
                state: event.state,
                diag: event.diag,
                lastConnectedAt: event.lastConnectedAt ?? account.lastConnectedAt,
              }
            : account,
        ),
      );
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const accountFor = (provider: ChannelProvider): ChannelAccountView | undefined =>
    (accounts ?? []).find((account) => account.provider === provider);

  const draftFor = useMemo(() => {
    const map: Record<string, Draft> = {};
    for (const provider of PROVIDERS) {
      const account = (accounts ?? []).find((row) => row.provider === provider);
      map[provider] = drafts[provider] ?? {
        name: account?.name ?? "",
        scope: account?.scope ?? "both",
        allowlist: (account?.allowlist ?? []).join(", "),
        credentials: {},
      };
    }
    return map;
  }, [accounts, drafts]);

  const setDraft = (provider: ChannelProvider, patch: Partial<Draft>) => {
    setDrafts((current) => ({
      ...current,
      [provider]: { ...draftFor[provider], ...patch },
    }));
  };

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => setAccounts((await api.channelsList()) ?? []);

  const save = (provider: ChannelProvider) => {
    const account = accountFor(provider);
    const draft = draftFor[provider];
    const credentials: Record<string, string> = {};
    for (const field of CHANNEL_CREDENTIAL_FIELDS[provider]) {
      const value = (draft.credentials[field.key] ?? "").trim();
      // Empty means unchanged (FR-IM-02) — never send a clobbering blank.
      if (value) credentials[field.key] = value;
    }
    return run(async () => {
      await api.channelsSave({
        id: account?.id,
        provider,
        name: draft.name.trim() || undefined,
        scope: draft.scope,
        allowlist: draft.allowlist
          .split(/[,，;；\s]+/)
          .map((item) => item.trim())
          .filter(Boolean),
        credentials,
      });
      setDrafts((current) => ({ ...current, [provider]: { ...emptyDraft(), name: draft.name, scope: draft.scope, allowlist: draft.allowlist } }));
      await refresh();
      showToast(t("settings.assistant.saveOk"), { variant: "success" });
    });
  };

  const connect = (account: ChannelAccountView) =>
    run(async () => {
      await api.channelsConnect(account.id);
      await refresh();
    });

  const disconnect = (account: ChannelAccountView) =>
    run(async () => {
      await api.channelsDisconnect(account.id);
      await refresh();
    });

  const test = (account: ChannelAccountView) =>
    run(async () => {
      const result: ChannelTestResult = await api.channelsTest(account.id);
      await refresh();
      showToast(
        result.ok
          ? t("settings.assistant.testOk")
          : t("settings.assistant.testFail", {
              reason: t(DIAG_KIND_KEYS[result.diag?.kind ?? "unknown"]),
            }),
        { variant: result.ok ? "success" : "error" },
      );
    });

  const remove = (account: ChannelAccountView) =>
    run(async () => {
      await api.channelsDelete(account.id);
      await refresh();
      showToast(t("settings.assistant.deleteOk"), { variant: "success" });
    });

  const applyPaste = (provider: ChannelProvider) => {
    const parsed = parseCredentialBlob(provider, pasteText);
    const fieldCount = Object.keys(parsed).length;
    setDraft(provider, {
      credentials: { ...draftFor[provider].credentials, ...parsed },
    });
    setPasteText("");
    setPasteOpen(null);
    showToast(
      fieldCount
        ? t("settings.assistant.pasteParsed", { count: fieldCount })
        : t("settings.assistant.pasteNone"),
      { variant: fieldCount ? "success" : "error" },
    );
  };

  // T53.3 webhook server card state
  const [webhook, setWebhook] = useState<{
    running: boolean;
    port: number | null;
    lanOpen: boolean;
    secretSet: boolean;
    secretPreview: string;
  } | null>(null);
  const [webhookPort, setWebhookPort] = useState("3800");
  useEffect(() => {
    api
      .assistantWebhookGet()
      .then((status) => {
        setWebhook(status);
        if (status?.port) setWebhookPort(String(status.port));
      })
      .catch(() => undefined);
  }, []);

  const saveWebhook = () => {
    if (!webhook) return;
    setBusy(true);
    api
      .assistantWebhookSet({ port: Number(webhookPort), lanOpen: webhook.lanOpen })
      .then((next) => {
        setWebhook(next);
        showToast(t("settings.assistant.webhookSaveOk"), { variant: "success" });
      })
      .catch((error) =>
        showToast(error instanceof Error ? error.message : String(error), { variant: "error" }),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="settings-section flex flex-col gap-4">
      <p className="text-sm opacity-70">{t("settings.assistant.description")}</p>
      <div
        className="rounded-lg border p-4"
        style={{ borderColor: "var(--ds-border)" }}
        data-webhook-card=""
      >
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-2 w-2 rounded-full ${webhook?.running ? "bg-emerald-500" : "bg-neutral-400"}`}
            aria-hidden
          />
          <span className="font-medium">{t("settings.assistant.webhookTitle")}</span>
          {webhook?.running ? (
            <Badge tone="success">{t("settings.assistant.webhookRunning")}</Badge>
          ) : (
            <Badge tone="neutral">{t("settings.assistant.webhookStopped")}</Badge>
          )}
        </div>
        <p className="mt-2 text-xs opacity-60">{t("settings.assistant.webhookHelp")}</p>
        {webhook ? (
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs">
              <span>{t("settings.assistant.webhookPort")}</span>
              <input
                className="w-24 rounded-md border px-2 py-1.5 text-sm"
                style={{ borderColor: "var(--ds-border)" }}
                value={webhookPort}
                onChange={(event) => setWebhookPort(event.target.value)}
              />
            </label>
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={webhook.lanOpen}
                onChange={(event) => setWebhook({ ...webhook, lanOpen: event.target.checked })}
              />
              <span>{t("settings.assistant.webhookLan")}</span>
            </label>
            <span className="text-xs opacity-60">
              {t("settings.assistant.webhookSecret")}: <code>{webhook.secretPreview || "—"}</code>
            </span>
            <Button size="sm" disabled={busy} onClick={saveWebhook}>
              {t("settings.assistant.webhookApply")}
            </Button>
          </div>
        ) : null}
      </div>
      {PROVIDERS.map((provider) => {
        const account = accountFor(provider);
        const draft = draftFor[provider];
        return (
          <div
            key={provider}
            className="rounded-lg border p-4"
            style={{ borderColor: "var(--ds-border)" }}
            data-channel-card={provider}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    account?.state === "connected"
                      ? "bg-emerald-500"
                      : account?.state === "connecting"
                        ? "bg-amber-500"
                        : account?.state === "error"
                          ? "bg-red-500"
                          : "bg-neutral-400"
                  }`}
                  aria-hidden
                />
                <span className="font-medium">{t(PROVIDER_LABEL_KEYS[provider])}</span>
                {account ? (
                  <Badge tone={account.state === "connected" ? "success" : "neutral"}>
                    {t(STATE_LABEL_KEYS[account.state])}
                  </Badge>
                ) : (
                  <Badge tone="neutral">{t("settings.assistant.notConfigured")}</Badge>
                )}
              </div>
              {account ? (
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void test(account)}>
                    {t("settings.assistant.test")}
                  </Button>
                  {account.state === "disconnected" || account.state === "error" ? (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => void connect(account)}>
                      {t("settings.assistant.connect")}
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void disconnect(account)}>
                      {t("settings.assistant.disconnect")}
                    </Button>
                  )}
                </div>
              ) : null}
            </div>
            {account?.diag ? (
              <p className="mt-2 text-xs text-red-500" data-channel-diag={account.diag.kind}>
                {t(DIAG_KIND_KEYS[account.diag.kind])}
                {account.diag.message ? `: ${account.diag.message}` : ""}
              </p>
            ) : null}
            <p className="mt-2 text-xs opacity-60">{t(PROVIDER_HELP_KEYS[provider])}</p>

            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-xs">
                <span>{t("settings.assistant.accountName")}</span>
                <input
                  className="rounded-md border px-2 py-1.5 text-sm"
                  style={{ borderColor: "var(--ds-border)" }}
                  value={draft.name}
                  placeholder={t(PROVIDER_LABEL_KEYS[provider])}
                  onChange={(event) => setDraft(provider, { name: event.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span>{t("settings.assistant.scope")}</span>
                <select
                  className="rounded-md border px-2 py-1.5 text-sm"
                  style={{ borderColor: "var(--ds-border)" }}
                  value={draft.scope}
                  onChange={(event) =>
                    setDraft(provider, {
                      scope: event.target.value as Draft["scope"],
                    })
                  }
                >
                  <option value="both">{t("settings.assistant.scopeBoth")}</option>
                  <option value="p2p">{t("settings.assistant.scopeP2p")}</option>
                  <option value="group">{t("settings.assistant.scopeGroup")}</option>
                </select>
              </label>
              {CHANNEL_CREDENTIAL_FIELDS[provider].map((field) => (
                <label key={field.key} className="flex flex-col gap-1 text-xs">
                  <span>{t(field.labelKey)}</span>
                  <input
                    type={field.secret ? "password" : "text"}
                    className="rounded-md border px-2 py-1.5 text-sm"
                    style={{ borderColor: "var(--ds-border)" }}
                    autoComplete="off"
                    value={draft.credentials[field.key] ?? ""}
                    placeholder={
                      account?.hasCredentials ? t("settings.assistant.credentialUnchanged") : ""
                    }
                    onChange={(event) =>
                      setDraft(provider, {
                        credentials: {
                          ...draft.credentials,
                          [field.key]: event.target.value,
                        },
                      })
                    }
                  />
                </label>
              ))}
              <label className="col-span-2 flex flex-col gap-1 text-xs">
                <span>{t("settings.assistant.allowlist")}</span>
                <input
                  className="rounded-md border px-2 py-1.5 text-sm"
                  style={{ borderColor: "var(--ds-border)" }}
                  value={draft.allowlist}
                  placeholder={t("settings.assistant.allowlistHint")}
                  onChange={(event) => setDraft(provider, { allowlist: event.target.value })}
                />
              </label>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={busy} onClick={() => void save(provider)}>
                {t("settings.assistant.save")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setPasteText("");
                  setPasteOpen(pasteOpen === provider ? null : provider);
                }}
              >
                {t("settings.assistant.pasteParse")}
              </Button>
              {account ? (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove(account)}>
                  {t("settings.assistant.delete")}
                </Button>
              ) : null}
            </div>
            {pasteOpen === provider ? (
              <div className="mt-3 flex flex-col gap-2" data-channel-paste={provider}>
                <textarea
                  className="h-24 rounded-md border px-2 py-1.5 font-mono text-xs"
                  style={{ borderColor: "var(--ds-border)" }}
                  placeholder={t("settings.assistant.pastePlaceholder")}
                  value={pasteText}
                  onChange={(event) => setPasteText(event.target.value)}
                />
                <div className="flex gap-2">
                  <Button size="sm" disabled={busy || !pasteText.trim()} onClick={() => applyPaste(provider)}>
                    {t("settings.assistant.pasteApply")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setPasteOpen(null)}>
                    {t("common.cancel")}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
