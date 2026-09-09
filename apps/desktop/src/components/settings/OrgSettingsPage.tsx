import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OrgStatus } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../ui";
import { IconShield } from "../icons";

/**
 * Settings → Organization (PRD 4.1.12): login against the LaboFlow Server,
 * first-login forced password change, and the connected-org summary.
 */
export function OrgSettingsPage() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [status, setStatus] = useState<OrgStatus | null>(null);
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
      setMustChange(Boolean(next.mustChangePassword));
      showToast(t("settings.org.loginOk", { name: next.orgName ?? next.serverUrl ?? "" }), {
        variant: "success",
      });
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

  const logout = async () => {
    setBusy(true);
    try {
      setStatus(await api.orgLogout());
      setMustChange(false);
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return <div className="org-page org-loading">{t("common.loading")}</div>;
  }

  const connected = status.state === "connected";

  return (
    <div className="org-page">
      <p className="org-description">{t("settings.org.description")}</p>

      {status.state === "expired" ? (
        <div className="org-expired">{t("settings.org.expiredHint")}</div>
      ) : null}

      {connected ? (
        <section className="org-card">
          <div className="org-row">
            <span className="org-label">{t("settings.org.server")}</span>
            <span className="org-value">{status.serverUrl}</span>
          </div>
          <div className="org-row">
            <span className="org-label">{t("settings.org.account")}</span>
            <span className="org-value">
              {status.displayName || status.username}
              {status.role ? ` · ${status.role}` : ""}
            </span>
          </div>
          {status.orgName ? (
            <div className="org-row">
              <span className="org-label">{t("settings.org.orgName")}</span>
              <span className="org-value">{status.orgName}</span>
            </div>
          ) : null}
          {status.teamName ? (
            <div className="org-row">
              <span className="org-label">{t("settings.org.team")}</span>
              <span className="org-value">{status.teamName}</span>
            </div>
          ) : null}
          <div className="org-row">
            <span className="org-label">{t("settings.org.workspaces")}</span>
            <span className="org-value">{status.workspaceCount ?? 0}</span>
          </div>
          <div className="org-actions">
            <Button variant="secondary" disabled={busy} onClick={() => void logout()}>
              {t("settings.org.logout")}
            </Button>
          </div>
        </section>
      ) : (
        <section className="org-card">
          <label className="org-field">
            <span>{t("settings.org.server")}</span>
            <input
              className="field-input"
              value={serverUrl}
              placeholder="https://laboflow.example.com"
              onChange={(event) => setServerUrl(event.target.value)}
            />
          </label>
          <label className="org-field">
            <span>{t("settings.org.username")}</span>
            <input
              className="field-input"
              value={username}
              autoComplete="username"
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label className="org-field">
            <span>{t("settings.org.password")}</span>
            <input
              className="field-input"
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <div className="org-actions">
            <Button
              variant="primary"
              disabled={busy || !serverUrl.trim() || !username.trim() || !password}
              onClick={() => void login()}
            >
              <IconShield size={14} />
              {busy ? t("settings.org.loggingIn") : t("settings.org.login")}
            </Button>
          </div>
        </section>
      )}

      {mustChange ? (
        <section className="org-card">
          <h3 className="org-card-title">{t("settings.org.mustChangeHint")}</h3>
          <label className="org-field">
            <span>{t("settings.org.currentPassword")}</span>
            <input
              className="field-input"
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </label>
          <label className="org-field">
            <span>{t("settings.org.newPassword")}</span>
            <input
              className="field-input"
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </label>
          <div className="org-actions">
            <Button
              variant="primary"
              disabled={busy || !currentPassword || !newPassword}
              onClick={() => void changePassword()}
            >
              {t("settings.org.changePassword")}
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
