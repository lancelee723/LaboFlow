import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OrgSessionInfo, OrgStatus } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Badge, Button } from "../ui";
import { IconPlus, IconUser } from "../icons";

/**
 * Settings → Organization (PRD 4.1.12), mirroring the model-provider IA:
 * "当前组织" (the live connection) at the top, the list of signed-in
 * organizations with a top-right "登录组织" primary action that opens the
 * login dialog. Forced password change (must_change_password) gets its own
 * card, exactly like the add-provider flow.
 */
export function OrgSettingsPage() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [status, setStatus] = useState<OrgStatus | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [serverUrl, setServerUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [mustChange, setMustChange] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");

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

  const login = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await api.orgLogin({ serverUrl, username, password });
      setStatus(next);
      setPassword("");
      setLoginOpen(false);
      setMustChange(Boolean(next.mustChangePassword));
      showToast(
        t("settings.org.loginOk", { name: next.orgName ?? next.serverUrl ?? "" }),
        { variant: "success" },
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await api.orgChangePassword({ currentPassword, newPassword });
      setStatus(next);
      setMustChange(false);
      setCurrentPassword("");
      setNewPassword("");
      showToast(t("settings.org.passwordChanged"), { variant: "success" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const signOut = async (key: string) => {
    setBusy(true);
    try {
      setStatus(await api.orgLogout());
      void key;
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const setCurrent = async (key: string) => {
    if (busy) return;
    setBusy(true);
    try {
      setStatus(await api.orgSetCurrent(key));
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return (
      <div className="settings-stack">
        <p className="settings-row-desc">{t("common.loading")}</p>
      </div>
    );
  }

  const connected = status.state === "connected";
  const currentKey = status.currentKey;
  const orgs = status.orgs ?? [];
  const current =
    orgs.find((entry) => entry.key === currentKey) ??
    (connected
      ? {
          key: currentKey ?? "",
          serverUrl: status.serverUrl ?? "",
          username: status.username ?? "",
          displayName: status.displayName,
          role: status.role,
          orgName: status.orgName,
        }
      : null);

  const currentRow = (label: string, value: string) => (
    <div className="settings-row">
      <div className="settings-row-copy">
        <div className="settings-row-title">{label}</div>
      </div>
      <div className="settings-row-control">{value}</div>
    </div>
  );

  return (
    <div className="settings-stack">
      <section className="settings-card-block">
        <div className="model-config-section-head">
          <div className="settings-card-heading-line">
            <h3 className="settings-card-heading">{t("settings.org.currentOrg")}</h3>
          </div>
          <Button variant="primary" onClick={() => setLoginOpen(true)}>
            <span className="model-config-btn-inner">
              <IconPlus size={14} />
              <span>{t("settings.org.loginOrg")}</span>
            </span>
          </Button>
        </div>
        <div className="settings-panel model-provider-panel">
          {current ? (
            <ul className="model-provider-list">
              <li className="model-provider-row">
                <div className="model-provider-row-copy">
                  <div className="model-provider-row-title">
                    <span className="model-provider-row-name">
                      {status.orgName || current.orgName || current.serverUrl}
                    </span>
                    <Badge tone="success">{t("settings.org.badgeCurrent")}</Badge>
                    {mustChange ? (
                      <Badge tone="warning">{t("settings.org.mustChangeHint")}</Badge>
                    ) : null}
                  </div>
                  <div className="model-provider-row-meta">
                    <span>{status.displayName || current.username}</span>
                    <span className="model-provider-meta-dot" aria-hidden>
                      ·
                    </span>
                    <span>{status.role ?? current.role ?? ""}</span>
                    <span className="model-provider-meta-dot" aria-hidden>
                      ·
                    </span>
                    <span>{status.serverUrl}</span>
                  </div>
                </div>
                <div className="model-provider-row-actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void signOut(current.key)}
                  >
                    {t("settings.org.logout")}
                  </Button>
                </div>
              </li>
            </ul>
          ) : (
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
              <Button variant="primary" onClick={() => setLoginOpen(true)}>
                <span className="model-config-btn-inner">
                  <IconPlus size={14} />
                  <span>{t("settings.org.loginOrg")}</span>
                </span>
              </Button>
            </div>
          )}
        </div>
      </section>

      {orgs.length > 1 ? (
        <section className="settings-card-block">
          <div className="model-config-section-head">
            <div className="settings-card-heading-line">
              <h3 className="settings-card-heading">
                {t("settings.org.signedInOrgs")}
              </h3>
              {orgs.length > 0 ? (
                <span className="provider-section-count">{orgs.length}</span>
              ) : null}
            </div>
          </div>
          <div className="settings-panel model-provider-panel">
            <ul className="model-provider-list">
              {orgs.map((entry: OrgSessionInfo) => {
                const isCurrent = entry.key === currentKey;
                return (
                  <li
                    key={entry.key}
                    className={`model-provider-row ${isCurrent ? "" : "is-disabled"}`}
                  >
                    <div className="model-provider-row-copy">
                      <div className="model-provider-row-title">
                        <span className="model-provider-row-name">
                          {entry.orgName || entry.serverUrl}
                        </span>
                        {isCurrent ? (
                          <Badge tone="success">{t("settings.org.badgeCurrent")}</Badge>
                        ) : null}
                      </div>
                      <div className="model-provider-row-meta">
                        <span>{entry.displayName || entry.username}</span>
                        <span className="model-provider-meta-dot" aria-hidden>
                          ·
                        </span>
                        <span>{entry.serverUrl}</span>
                      </div>
                    </div>
                    <div className="model-provider-row-actions">
                      {!isCurrent ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void setCurrent(entry.key)}
                        >
                          {t("settings.org.setAsCurrent")}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void signOut(entry.key)}
                        >
                          {t("settings.org.logout")}
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      ) : null}

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
                {t("settings.org.loginOrg")}
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
                onClick={() => void login()}
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
