import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OrgStatus } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../ui";

/**
 * Settings → Organization (PRD 4.1.12): login against the LaboFlow Server,
 * first-login forced password change, and the connected-org summary. Uses the
 * standard settings scaffold (settings-stack / settings-card-block /
 * settings-panel / settings-row) so typography and surfaces match the rest of
 * the IA.
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
    return (
      <div className="settings-stack">
        <p className="settings-row-desc">{t("common.loading")}</p>
      </div>
    );
  }

  const connected = status.state === "connected";

  const infoRow = (label: string, value: string) => (
    <div className="settings-row">
      <div className="settings-row-copy">
        <div className="settings-row-title">{label}</div>
      </div>
      <div className="settings-row-control">{value}</div>
    </div>
  );

  const fieldRow = (
    label: string,
    node: React.ReactNode,
    description?: string,
  ) => (
    <div className="settings-row">
      <div className="settings-row-copy">
        <div className="settings-row-title">{label}</div>
        {description ? <div className="settings-row-desc">{description}</div> : null}
      </div>
      <div className="settings-row-control">{node}</div>
    </div>
  );

  return (
    <div className="settings-stack">
      <section className="settings-card-block">
        <h3 className="settings-card-heading">{t("settings.orgTitle")}</h3>
        <div className="settings-panel">
          <div className="settings-row">
            <div className="settings-row-copy">
              <div className="settings-row-title">{t("settings.org.description")}</div>
              {status.state === "expired" ? (
                <div className="settings-row-desc" style={{ color: "var(--ds-warning)" }}>
                  {t("settings.org.expiredHint")}
                </div>
              ) : null}
            </div>
          </div>

          {connected ? (
            <>
              {infoRow(t("settings.org.server"), status.serverUrl ?? "")}
              {infoRow(
                t("settings.org.account"),
                [status.displayName || status.username, status.role]
                  .filter(Boolean)
                  .join(" · "),
              )}
              {status.orgName
                ? infoRow(t("settings.org.orgName"), status.orgName)
                : null}
              {status.teamName
                ? infoRow(t("settings.org.team"), status.teamName)
                : null}
              {infoRow(t("settings.org.workspaces"), String(status.workspaceCount ?? 0))}
              <div className="settings-row">
                <div className="settings-row-copy">
                  <div className="settings-row-title">{t("settings.org.logout")}</div>
                  <div className="settings-row-desc">{t("settings.org.description")}</div>
                </div>
                <div className="settings-row-control">
                  <Button variant="secondary" disabled={busy} onClick={() => void logout()}>
                    {t("settings.org.logout")}
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <>
              {fieldRow(
                t("settings.org.server"),
                <input
                  className="field-input"
                  style={{ minWidth: 220 }}
                  value={serverUrl}
                  placeholder="https://laboflow.example.com"
                  onChange={(event) => setServerUrl(event.target.value)}
                />,
              )}
              {fieldRow(
                t("settings.org.username"),
                <input
                  className="field-input"
                  style={{ minWidth: 220 }}
                  value={username}
                  autoComplete="username"
                  onChange={(event) => setUsername(event.target.value)}
                />,
              )}
              {fieldRow(
                t("settings.org.password"),
                <input
                  className="field-input"
                  style={{ minWidth: 220 }}
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  onChange={(event) => setPassword(event.target.value)}
                />,
              )}
              <div className="settings-row">
                <div className="settings-row-copy">
                  <div className="settings-row-title">{t("settings.org.login")}</div>
                  <div className="settings-row-desc">{t("settings.org.description")}</div>
                </div>
                <div className="settings-row-control">
                  <Button
                    variant="primary"
                    disabled={busy || !serverUrl.trim() || !username.trim() || !password}
                    onClick={() => void login()}
                  >
                    {busy ? t("settings.org.loggingIn") : t("settings.org.login")}
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </section>

      {mustChange ? (
        <section className="settings-card-block">
          <h3 className="settings-card-heading">{t("settings.org.mustChangeHint")}</h3>
          <div className="settings-panel">
            {fieldRow(
              t("settings.org.currentPassword"),
              <input
                className="field-input"
                style={{ minWidth: 220 }}
                type="password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />,
            )}
            {fieldRow(
              t("settings.org.newPassword"),
              <input
                className="field-input"
                style={{ minWidth: 220 }}
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />,
            )}
            <div className="settings-row">
              <div className="settings-row-copy">
                <div className="settings-row-title">{t("settings.org.changePassword")}</div>
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
    </div>
  );
}
