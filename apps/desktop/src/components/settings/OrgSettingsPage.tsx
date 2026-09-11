import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OrgSessionInfo, OrgStatus } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { AnchoredMenu } from "./AnchoredMenu";
import { CapabilityToggle } from "./AgentCapabilityLayout";
import { Badge, Button } from "../ui";
import {
  IconCheck,
  IconChevronDown,
  IconPencil,
  IconPlus,
  IconTrash,
  IconUser,
} from "../icons";

/**
 * Settings → Organization (PRD 4.1.12), mirroring the model-config IA:
 * 默认项 — the default organization row with a 更改 picker; 账户管理 — the
 * signed-in org accounts (edit login info, remove, enable toggle) with the
 * "登录组织" primary action top-right.
 */
export function OrgSettingsPage() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [status, setStatus] = useState<OrgStatus | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [mustChange, setMustChange] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [changingOrg, setChangingOrg] = useState(false);
  const [armedRemove, setArmedRemove] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .orgStatus()
      .then((next) => {
        if (!cancelled) {
          setStatus(next);
          if (next.mustChangePassword) setMustChange(true);
        }
      })
      .catch(() => {
        if (!cancelled) setStatus({ connected: false, state: "disconnected" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const submitLogin = async () => {
    await run(async () => {
      const next = await api.orgLogin({ serverUrl, username, password });
      setStatus(next);
      setPassword("");
      setLoginOpen(false);
      setEditingKey(null);
      setMustChange(Boolean(next.mustChangePassword));
      showToast(
        t("settings.org.loginOk", { name: next.orgName ?? next.serverUrl ?? "" }),
        { variant: "success" },
      );
    });
  };

  /** Sign out of the current org session (row action on the current account). */
  const signOut = async () => {
    await run(async () => {
      setStatus(await api.orgLogout());
      setMustChange(false);
    });
  };

  const changePassword = async () => {
    await run(async () => {
      const next = await api.orgChangePassword({ currentPassword, newPassword });
      setStatus(next);
      setMustChange(false);
      setCurrentPassword("");
      setNewPassword("");
      showToast(t("settings.org.passwordChanged"), { variant: "success" });
    });
  };

  const orgs = status?.orgs ?? [];
  const currentKey = status?.currentKey;
  const currentEntry = orgs.find((org) => org.key === currentKey) ?? null;

  const openLogin = () => {
    setEditingKey(null);
    setServerUrl("");
    setUsername("");
    setPassword("");
    setLoginOpen(true);
  };

  const openEdit = (org: OrgSessionInfo) => {
    setEditingKey(org.key);
    setServerUrl(org.serverUrl);
    setUsername(org.username);
    setPassword("");
    setLoginOpen(true);
  };

  if (!status) {
    return (
      <div className="settings-stack">
        <p className="settings-row-desc">{t("common.loading")}</p>
      </div>
    );
  }

  const connected = status.state === "connected";
  const currentOrgLabel =
    currentEntry?.orgName || currentEntry?.serverUrl || "";

  const accountRow = (org: OrgSessionInfo) => {
    const isCurrent = org.key === currentKey && org.enabled !== false;
    const isArmed = armedRemove === org.key;
    return (
      <li
        key={org.key}
        className={`model-provider-row ${org.enabled === false ? "is-disabled" : ""}`}
      >
        <div className="model-provider-row-copy">
          <div className="model-provider-row-title">
            <span className="model-provider-row-name">
              {org.orgName || org.serverUrl}
            </span>
            {isCurrent ? (
              <Badge tone="success">{t("settings.org.badgeCurrent")}</Badge>
            ) : null}
            {org.enabled === false ? (
              <Badge tone="neutral">{t("settings.org.disabledBadge")}</Badge>
            ) : null}
          </div>
          <div className="model-provider-row-meta">
            <span>{org.serverUrl}</span>
            <span className="model-provider-meta-dot" aria-hidden>
              ·
            </span>
            <span>{org.username}</span>
            {org.role ? (
              <>
                <span className="model-provider-meta-dot" aria-hidden>
                  ·
                </span>
                <span>{org.role}</span>
              </>
            ) : null}
          </div>
        </div>
        <div className="model-provider-row-actions">
          <button
            type="button"
            className="icon-btn model-provider-icon-btn"
            title={t("settings.org.editLogin")}
            aria-label={t("settings.org.editLogin")}
            onClick={() => openEdit(org)}
          >
            <IconPencil size={14} />
          </button>
          <button
            type="button"
            className="icon-btn model-provider-icon-btn"
            title={
              isArmed ? t("settings.org.removeArmed") : t("settings.org.removeAccount")
            }
            aria-label={t("settings.org.removeAccount")}
            disabled={busy}
            onClick={() => {
              if (isArmed) {
                setArmedRemove(null);
                void run(async () => {
                  setStatus(await api.orgRemoveSession(org.key));
                });
              } else {
                setArmedRemove(org.key);
              }
            }}
          >
            <IconTrash size={14} />
          </button>
          {isCurrent ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void signOut()}
            >
              {t("settings.org.logout")}
            </Button>
          ) : null}
          <CapabilityToggle
            checked={org.enabled !== false}
            busy={busy}
            label={t("settings.org.toggleAccount", { name: org.username })}
            onChange={() =>
              void run(async () => {
                setStatus(
                  await api.orgSetSessionEnabled({
                    key: org.key,
                    enabled: !(org.enabled !== false),
                  }),
                );
              })
            }
          />
        </div>
      </li>
    );
  };

  return (
    <div className="settings-stack">
      <section className="settings-card-block">
        <div className="model-config-section-head">
          <h3 className="settings-card-heading">{t("settings.org.defaultsTitle")}</h3>
        </div>
        <div className="settings-panel model-default-panel">
          <div className="settings-row model-default-row">
            <div className="settings-row-copy model-default-copy">
              <div className="settings-row-title model-default-label">
                {t("settings.org.defaultOrg")}
              </div>
              {currentEntry && connected ? (
                <div className="settings-row-desc model-default-value">
                  <span className="model-default-provider">
                    {currentOrgLabel}
                  </span>
                  <span className="model-default-sep" aria-hidden>
                    ·
                  </span>
                  <span className="model-default-model font-mono">
                    {currentEntry?.username ?? ""}
                  </span>
                </div>
              ) : (
                <div className="settings-row-desc model-default-value">
                  <span className="model-default-empty">
                    {t("settings.org.emptyOrgTitle")}
                  </span>
                </div>
              )}
            </div>
            {orgs.length > 0 ? (
              <AnchoredMenu
                className="model-default-anchor"
                open={changingOrg}
                onClose={() => setChangingOrg(false)}
                menuClassName="model-default-menu"
                label={t("settings.org.changeOrg")}
                align="end"
                trigger={(ref) => (
                  <Button
                    ref={ref}
                    className="settings-text-action model-default-trigger"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setChangingOrg((current) => !current)}
                    aria-haspopup="listbox"
                    aria-expanded={changingOrg}
                  >
                    {t("settings.org.changeOrg")}
                    <IconChevronDown
                      className="model-default-trigger-chevron"
                      size={13}
                      aria-hidden
                    />
                  </Button>
                )}
              >
                <ul className="model-default-list">
                  {orgs
                    .filter((org) => org.enabled !== false)
                    .map((org) => {
                      const isCurrent = org.key === currentKey;
                      return (
                        <li key={org.key}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={isCurrent}
                            className={`model-default-option ${isCurrent ? "is-current" : ""}`}
                            disabled={busy}
                            onClick={() => {
                              setChangingOrg(false);
                              if (!isCurrent) {
                                void run(async () => {
                                  setStatus(await api.orgSetCurrent(org.key));
                                });
                              }
                            }}
                          >
                            <span className="model-default-option-check" aria-hidden>
                              {isCurrent ? <IconCheck size={12} /> : null}
                            </span>
                            <span className="model-default-option-model">
                              {org.orgName || org.serverUrl}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                </ul>
              </AnchoredMenu>
            ) : null}
          </div>
        </div>
      </section>

      <section className="settings-card-block">
        <div className="model-config-section-head">
          <div className="settings-card-heading-line">
            <h3 className="settings-card-heading">{t("settings.org.accountsTitle")}</h3>
            {orgs.length > 0 ? (
              <span className="provider-section-count">{orgs.length}</span>
            ) : null}
          </div>
          <Button variant="primary" onClick={openLogin}>
            <span className="model-config-btn-inner">
              <IconPlus size={14} />
              <span>{t("settings.org.loginOrg")}</span>
            </span>
          </Button>
        </div>
        <div className="settings-panel model-provider-panel">
          {orgs.length === 0 ? (
            <div className="model-provider-empty">
              <div className="model-provider-empty-icon" aria-hidden>
                <IconUser size={18} />
              </div>
              <div className="model-provider-empty-title">
                {t("settings.org.emptyOrgTitle")}
              </div>
              <div className="model-provider-empty-desc">
                {t("settings.org.emptyOrgDesc")}
              </div>
              <Button variant="primary" onClick={openLogin}>
                <span className="model-config-btn-inner">
                  <IconPlus size={14} />
                  <span>{t("settings.org.loginOrg")}</span>
                </span>
              </Button>
            </div>
          ) : (
            <ul className="model-provider-list">{orgs.map((org) => accountRow(org))}</ul>
          )}
        </div>
      </section>

      {mustChange && connected ? (
        <section className="settings-card-block">
          <h3 className="settings-card-heading">{t("settings.org.mustChangeHint")}</h3>
          <div className="settings-panel">
            <div className="settings-row">
              <div className="settings-row-copy">
                <div className="settings-row-title">
                  {t("settings.org.currentPassword")}
                </div>
              </div>
              <div className="settings-row-control">
                <input
                  className="field-input"
                  style={{ minWidth: 220 }}
                  type="password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row-copy">
                <div className="settings-row-title">{t("settings.org.newPassword")}</div>
              </div>
              <div className="settings-row-control">
                <input
                  className="field-input"
                  style={{ minWidth: 220 }}
                  type="password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row-copy">
                <div className="settings-row-title">
                  {t("settings.org.changePassword")}
                </div>
              </div>
              <div className="settings-row-control">
                <Button
                  variant="primary"
                  disabled={busy || !currentPassword || !newPassword}
                  onClick={() => void changePassword()}
                >
                  {t("settings.org.changePassword")}
                </Button>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {loginOpen ? (
        <div
          className="overlay org-login-overlay"
          role="presentation"
          onClick={() => {
            if (!busy) setLoginOpen(false);
          }}
        >
          <div
            className="dialog org-login-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="org-login-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="org-login-head">
              <h3 id="org-login-title" className="settings-card-heading">
                {editingKey ? t("settings.org.editLoginTitle") : t("settings.org.loginOrg")}
              </h3>
            </div>
            <div className="org-login-body">
              <label className="org-login-field">
                <span>{t("settings.org.server")}</span>
                <input
                  className="field-input"
                  value={serverUrl}
                  placeholder="https://laboflow.example.com"
                  onChange={(event) => setServerUrl(event.target.value)}
                />
              </label>
              <label className="org-login-field">
                <span>{t("settings.org.username")}</span>
                <input
                  className="field-input"
                  value={username}
                  autoComplete="username"
                  onChange={(event) => setUsername(event.target.value)}
                />
              </label>
              <label className="org-login-field">
                <span>{t("settings.org.password")}</span>
                <input
                  className="field-input"
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <div className="settings-row-desc">{t("settings.org.description")}</div>
            </div>
            <div className="org-login-actions">
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setLoginOpen(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                disabled={busy || !serverUrl.trim() || !username.trim() || !password}
                onClick={() => void submitLogin()}
              >
                {busy ? t("settings.org.loggingIn") : t("settings.org.login")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
