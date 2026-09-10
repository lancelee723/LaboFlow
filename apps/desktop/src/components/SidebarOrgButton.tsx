import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { OrgStatus } from "@pi-desktop/shared";
import { api } from "../lib/api";
import { useAppStore } from "../stores/app-store";
import { Button } from "./ui";
import { IconCheck, IconLogOut, IconSettings, IconUser } from "./icons";

/**
 * Sidebar footer org entry (Phase 2/3): avatar button opening a compact
 * sign-in popover. Full management (forced password change, quota) lives in
 * Settings → Organization.
 */
export function SidebarOrgButton({
  onOpenSettings,
  onBeforeOpen,
}: {
  onOpenSettings: () => void;
  onBeforeOpen?: () => void;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<OrgStatus | null>(null);
  const [serverUrl, setServerUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [popoverPos, setPopoverPos] = useState<{ bottom: number; left: number } | null>(
    null,
  );

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.orgStatus());
    } catch {
      setStatus({ connected: false, state: "disconnected" });
    }
  }, []);

  const openPopover = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setPopoverPos({
        bottom: window.innerHeight - rect.top + 8,
        left: Math.min(rect.left, Math.max(0, window.innerWidth - 320)),
      });
    }
    setError(null);
    onBeforeOpen?.();
    setOpen(true);
    void refreshStatus();
  };

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || popoverRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const login = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.orgLogin({ serverUrl, username, password });
      setStatus(next);
      setPassword("");
      showToast(
        t("settings.org.loginOk", { name: next.orgName ?? next.serverUrl ?? "" }),
        { variant: "success" },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    try {
      setStatus(await api.orgLogout());
    } finally {
      setBusy(false);
    }
  };

  const switchOrg = async (key: string) => {
    if (busy || key === status?.currentKey) return;
    setBusy(true);
    try {
      setStatus(await api.orgSetCurrent(key));
      showToast(t("settings.org.loginOk", { name: status?.orgName ?? key }), {
        variant: "success",
      });
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const title = t("settings.nav.org");

  return (
    <div className="org-footer-root" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`footer-action ${open ? "active" : ""} ${
          status?.state === "connected" ? "org-connected" : ""
        }`}
        data-nav="org"
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openPopover())}
      >
        <IconUser size={14} aria-hidden />
      </button>

      {open && popoverPos && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={popoverRef}
              className="notification-popover notification-popover-portaled org-popover"
              role="dialog"
              aria-label={title}
              style={{ bottom: popoverPos.bottom, left: popoverPos.left }}
            >
              <header className="notification-header">
                <h2 className="org-popover-title">{title}</h2>
              </header>

              {!status ? (
                <div className="org-popover-loading">{t("common.loading")}</div>
              ) : status.state === "expired" ? (
                <div className="org-popover-hint">{t("settings.org.expiredHint")}</div>
              ) : null}

              {status?.state === "connected" ? (
                <>
                  {(status.orgs?.length ?? 0) > 1 ? (
                    <div className="org-popover-orgs" role="listbox" aria-label={t("settings.org.signedInOrgs")}>
                      {(status.orgs ?? []).map((org) => {
                        const isCurrent = org.key === status.currentKey;
                        return (
                          <button
                            key={org.key}
                            type="button"
                            role="option"
                            aria-selected={isCurrent}
                            className={`org-popover-org ${isCurrent ? "is-current" : ""}`}
                            disabled={busy}
                            title={org.serverUrl}
                            onClick={() => void switchOrg(org.key)}
                          >
                            <span>{org.orgName || org.serverUrl}</span>
                            {isCurrent ? <IconCheck size={12} aria-hidden /> : null}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                  <div className="org-popover-row">
                    <span>{t("settings.org.account")}</span>
                    <span className="org-popover-value">
                      {status.displayName || status.username}
                    </span>
                  </div>
                  {status.orgName ? (
                    <div className="org-popover-row">
                      <span>{t("settings.org.orgName")}</span>
                      <span className="org-popover-value">{status.orgName}</span>
                    </div>
                  ) : null}
                  {status.role ? (
                    <div className="org-popover-row">
                      <span>{t("settings.org.role")}</span>
                      <span className="org-popover-value">{status.role}</span>
                    </div>
                  ) : null}
                  <div className="org-popover-actions">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => void logout()}
                    >
                      <IconLogOut size={13} />
                      {t("settings.org.logout")}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={onOpenSettings}>
                      <IconSettings size={13} />
                      {t("settings.nav.org")}
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <label className="org-popover-field">
                    <span>{t("settings.org.server")}</span>
                    <input
                      className="field-input"
                      value={serverUrl}
                      placeholder="https://laboflow.example.com"
                      onChange={(event) => setServerUrl(event.target.value)}
                    />
                  </label>
                  <label className="org-popover-field">
                    <span>{t("settings.org.username")}</span>
                    <input
                      className="field-input"
                      value={username}
                      autoComplete="username"
                      onChange={(event) => setUsername(event.target.value)}
                    />
                  </label>
                  <label className="org-popover-field">
                    <span>{t("settings.org.password")}</span>
                    <input
                      className="field-input"
                      type="password"
                      value={password}
                      autoComplete="current-password"
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </label>
                  {error ? <div className="org-popover-error">{error}</div> : null}
                  <div className="org-popover-actions">
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busy || !serverUrl.trim() || !username.trim() || !password}
                      onClick={() => void login()}
                    >
                      {busy ? t("settings.org.loggingIn") : t("settings.org.login")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setOpen(false);
                        onOpenSettings();
                      }}
                    >
                      <IconSettings size={13} />
                      {t("settings.nav.org")}
                    </Button>
                  </div>
                </>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
