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
import { Button, HelpIcon, Input, Select, Textarea } from "../ui";
import { CHANNEL_CREDENTIAL_FIELDS, parseCredentialBlob } from "../../lib/channel-credentials";

/**
 * Settings → Assistant (module 04, FR-IM-01/02/03): one card per IM channel.
 * Credentials are paste-in, masked, and never echoed back — empty inputs mean
 * "unchanged" and cannot clobber a stored secret (registry enforces, UI
 * mirrors). Connection states stream in via `IPC.event.channelState`.
 *
 * Layout rides the standard settings scaffolding (settings-card-block /
 * model-config-section-head / settings-row + field-input controls), the same
 * geometry every other settings tab uses.
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

/** FR-IM-13: providers with a test-account path get an explicit dev-use
 * guidance block (callback tunneling, non-production scope). */
const PROVIDER_TEST_GUIDE_KEYS: Partial<Record<ChannelProvider, string>> = {
  feishu: "settings.assistant.feishuTestGuide",
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

/** Connection state → the shared capability badge tone (dot + label). */
function stateBadgeClass(state: ChannelState | undefined): string {
  switch (state) {
    case "connected":
      return "agent-capability-badge is-ready";
    case "connecting":
      return "agent-capability-badge is-connecting";
    case "error":
      return "agent-capability-badge is-failed";
    default:
      return "agent-capability-badge";
  }
}

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
    <div className="settings-stack">
      <p className="settings-lead">{t("settings.assistant.description")}</p>

      <section className="settings-card-block" data-webhook-card="">
        <div className="model-config-section-head">
          <div className="settings-card-heading-line">
            <h3 className="settings-card-heading">{t("settings.assistant.webhookTitle")}</h3>
            <HelpIcon label={t("settings.assistant.webhookHelp")} />
            {webhook ? (
              <span
                className={`agent-capability-badge ${webhook.running ? "is-ready" : ""}`}
              >
                <span className="agent-capability-status-dot" aria-hidden="true" />
                {t(
                  webhook.running
                    ? "settings.assistant.webhookRunning"
                    : "settings.assistant.webhookStopped",
                )}
              </span>
            ) : null}
          </div>
        </div>
        <div className="settings-panel">
          {webhook ? (
            <>
              <div className="settings-row">
                <div className="settings-row-copy">
                  <div className="settings-row-title">
                    {t("settings.assistant.webhookPort")}
                    <HelpIcon label={t("settings.assistant.webhookHelp")} />
                  </div>
                </div>
                <div className="settings-row-control">
                  <Input
                    type="number"
                    className="settings-webhook-port"
                    value={webhookPort}
                    aria-label={t("settings.assistant.webhookPort")}
                    onChange={(event) => setWebhookPort(event.target.value)}
                  />
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={saveWebhook}
                  >
                    {t("settings.assistant.webhookApply")}
                  </Button>
                </div>
              </div>
              <div className="settings-row">
                <div className="settings-row-copy">
                  <div className="settings-row-title">
                    {t("settings.assistant.webhookLan")}
                  </div>
                </div>
                <div className="settings-row-control">
                  <input
                    type="checkbox"
                    checked={webhook.lanOpen}
                    aria-label={t("settings.assistant.webhookLan")}
                    onChange={(event) =>
                      setWebhook({ ...webhook, lanOpen: event.target.checked })
                    }
                  />
                </div>
              </div>
              <div className="settings-row">
                <div className="settings-row-copy">
                  <div className="settings-row-title">
                    {t("settings.assistant.webhookSecret")}
                  </div>
                </div>
                <div className="settings-row-control">
                  <code className="settings-secret-preview">
                    {webhook.secretPreview || "—"}
                  </code>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </section>

      {PROVIDERS.map((provider) => {
        const account = accountFor(provider);
        const draft = draftFor[provider];
        return (
          <section
            key={provider}
            className="settings-card-block"
            data-channel-card={provider}
          >
            <div className="model-config-section-head">
              <div className="settings-card-heading-line">
                <h3 className="settings-card-heading">
                  {t(PROVIDER_LABEL_KEYS[provider])}
                </h3>
                <HelpIcon label={t(PROVIDER_HELP_KEYS[provider])} />
                <span className={stateBadgeClass(account?.state)}>
                  <span className="agent-capability-status-dot" aria-hidden="true" />
                  {account
                    ? t(STATE_LABEL_KEYS[account.state])
                    : t("settings.assistant.notConfigured")}
                </span>
              </div>
              {account ? (
                <div className="settings-head-actions">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void test(account)}
                  >
                    {t("settings.assistant.test")}
                  </Button>
                  {account.state === "disconnected" || account.state === "error" ? (
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy}
                      onClick={() => void connect(account)}
                    >
                      {t("settings.assistant.connect")}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void disconnect(account)}
                    >
                      {t("settings.assistant.disconnect")}
                    </Button>
                  )}
                </div>
              ) : null}
            </div>
            <div className="settings-panel">
              {account?.diag ? (
                <div className="settings-row" data-channel-diag={account.diag.kind}>
                  <div className="settings-row-copy">
                    <div className="settings-row-title">
                      <span className="agent-capability-badge is-failed">
                        <span className="agent-capability-status-dot" aria-hidden="true" />
                        {t(DIAG_KIND_KEYS[account.diag.kind])}
                      </span>
                    </div>
                    {account.diag.message ? (
                      <div className="settings-row-detail">{account.diag.message}</div>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <div className="settings-row">
                <div className="settings-row-copy">
                  <div className="settings-row-title">
                    {t("settings.assistant.accountName")}
                  </div>
                </div>
                <div className="settings-row-control">
                  <Input
                    className="settings-field-wide"
                    value={draft.name}
                    placeholder={t(PROVIDER_LABEL_KEYS[provider])}
                    onChange={(event) => setDraft(provider, { name: event.target.value })}
                  />
                </div>
              </div>
              <div className="settings-row">
                <div className="settings-row-copy">
                  <div className="settings-row-title">
                    {t("settings.assistant.scope")}
                  </div>
                </div>
                <div className="settings-row-control">
                  <Select
                    className="settings-field-wide"
                    value={draft.scope}
                    aria-label={t("settings.assistant.scope")}
                    onChange={(event) =>
                      setDraft(provider, {
                        scope: event.target.value as Draft["scope"],
                      })
                    }
                  >
                    <option value="both">{t("settings.assistant.scopeBoth")}</option>
                    <option value="p2p">{t("settings.assistant.scopeP2p")}</option>
                    <option value="group">{t("settings.assistant.scopeGroup")}</option>
                  </Select>
                </div>
              </div>
              {CHANNEL_CREDENTIAL_FIELDS[provider].map((field) => (
                <div className="settings-row" key={field.key}>
                  <div className="settings-row-copy">
                    <div className="settings-row-title">{t(field.labelKey)}</div>
                  </div>
                  <div className="settings-row-control">
                    <Input
                      className="settings-field-wide"
                      type={field.secret ? "password" : "text"}
                      autoComplete="off"
                      value={draft.credentials[field.key] ?? ""}
                      placeholder={
                        account?.hasCredentials
                          ? t("settings.assistant.credentialUnchanged")
                          : ""
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
                  </div>
                </div>
              ))}
              <div className="settings-row">
                <div className="settings-row-copy">
                  <div className="settings-row-title">
                    {t("settings.assistant.allowlist")}
                  </div>
                </div>
                <div className="settings-row-control">
                  <Input
                    className="settings-field-wide"
                    value={draft.allowlist}
                    placeholder={t("settings.assistant.allowlistHint")}
                    onChange={(event) => setDraft(provider, { allowlist: event.target.value })}
                  />
                </div>
              </div>
              <div className="settings-row">
                <div className="settings-row-copy">
                  <div className="settings-row-title">
                    {t("settings.assistant.actions")}
                  </div>
                </div>
                <div className="settings-row-control">
                  <Button variant="primary" disabled={busy} onClick={() => void save(provider)}>
                    {t("settings.assistant.save")}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      setPasteText("");
                      setPasteOpen(pasteOpen === provider ? null : provider);
                    }}
                  >
                    {t("settings.assistant.pasteParse")}
                  </Button>
                  {account ? (
                    <Button variant="ghost" disabled={busy} onClick={() => void remove(account)}>
                      {t("settings.assistant.delete")}
                    </Button>
                  ) : null}
                </div>
              </div>
              {pasteOpen === provider ? (
                <div className="settings-paste" data-channel-paste={provider}>
                  <Textarea
                    className="font-mono"
                    rows={4}
                    placeholder={t("settings.assistant.pastePlaceholder")}
                    value={pasteText}
                    onChange={(event) => setPasteText(event.target.value)}
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy || !pasteText.trim()}
                      onClick={() => applyPaste(provider)}
                    >
                      {t("settings.assistant.pasteApply")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setPasteOpen(null)}>
                      {t("common.cancel")}
                    </Button>
                  </div>
                </div>
              ) : null}
              {PROVIDER_TEST_GUIDE_KEYS[provider] ? (
                <details className="settings-test-guide" data-test-guide={provider}>
                  <summary>{t("settings.assistant.testAccountTitle")}</summary>
                  <p className="whitespace-pre-line">
                    {t(PROVIDER_TEST_GUIDE_KEYS[provider] as string)}
                  </p>
                </details>
              ) : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}
