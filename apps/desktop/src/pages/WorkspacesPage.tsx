import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  OrgDeliverable,
  OrgSharedEntry,
  OrgSharedSession,
  OrgStatus,
  OrgWorkspaceInfo,
} from "@pi-desktop/shared";
import { api } from "../lib/api";
import { useAppStore } from "../stores/app-store";
import { Badge, Button } from "../components/ui";
import {
  IconArrowUp,
  IconPlus,
  IconUser,
} from "../components/icons";

type Tab = "sessions" | "deliverables";

/**
 * Phase 4 shared workspaces (PRD 4.1.13): live WS viewer, round-based
 * speaking (lock → say → release), and the deliverable library, gated by the
 * workspace perm (viewer / contributor / manager).
 */
export function WorkspacesPage() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [status, setStatus] = useState<OrgStatus | null>(null);
  const [wid, setWid] = useState<string | null>(null);
  const [sessions, setSessions] = useState<OrgSharedSession[]>([]);
  const [sid, setSid] = useState<string | null>(null);
  const [entries, setEntries] = useState<OrgSharedEntry[]>([]);
  const [tab, setTab] = useState<Tab>("sessions");
  const [deliverables, setDeliverables] = useState<OrgDeliverable[]>([]);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [lockHolder, setLockHolder] = useState<string | null>(null);
  const [speakText, setSpeakText] = useState("");
  const [newSessionTitle, setNewSessionTitle] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<{ wid: string; sid: string } | null>(null);

  const workspaces = useMemo<OrgWorkspaceInfo[]>(
    () => (status?.workspaces ?? []) as unknown as OrgWorkspaceInfo[],
    [status],
  );
  const workspace = workspaces.find((w) => w.id === wid) ?? null;
  const canSpeak =
    workspace?.perm === "contributor" || workspace?.perm === "manager";
  const canUpload = canSpeak;

  const loadSessions = useCallback(async (workspaceId: string) => {
    const rows = await api.orgWsSessions(workspaceId);
    setSessions(
      (rows as unknown as OrgSharedSession[])
        .slice()
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")),
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .orgStatus()
      .then((next) => {
        if (cancelled) return;
        setStatus(next);
        const first = (next.workspaces ?? [])[0] as
          | { id?: string }
          | undefined;
        if (first?.id) setWid(first.id);
      })
      .catch(() => {
        if (!cancelled) setStatus({ connected: false, state: "disconnected" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!wid) return;
    void loadSessions(wid).catch(() => setSessions([]));
  }, [wid, loadSessions]);

  // Live frames for the open shared session.
  useEffect(() => {
    if (!wid || !sid) return;
    setEntries([]);
    setLocked(false);
    setLockHolder(null);
    streamRef.current = { wid, sid };
    void api
      .orgWsConnect(wid, sid)
      .catch(() => showToast(t("workspaces.connectFailed"), { variant: "error" }));
    const off = api.onOrgWsFrame((frame) => {
      if (frame.sessionId !== sid) return;
      if (frame.type === "entry.appended" && frame.entry) {
        setEntries((prev) =>
          prev.some((entry) => entry.seq === frame.seq)
            ? prev
            : [
                ...prev,
                {
                  seq: frame.seq as number,
                  entry: frame.entry as OrgSharedEntry["entry"],
                  authorId: null,
                },
              ],
        );
      } else if (frame.type === "lock.acquired") {
        setLocked(frame.mine === true);
        setLockHolder(frame.mine ? t("workspaces.you") : frame.userId ?? null);
      } else if (frame.type === "lock.released") {
        setLocked(false);
        setLockHolder(null);
      }
    });
    return () => {
      off();
      void api.orgWsDisconnect(sid);
      streamRef.current = null;
    };
  }, [wid, sid, t, showToast]);

  const openSession = (session: OrgSharedSession) => {
    setTab("sessions");
    setSid(session.id);
  };

  const acquire = async () => {
    if (!wid || !sid || busy) return;
    setBusy(true);
    try {
      const result = await api.orgWsLock(wid, sid);
      if (result.granted === true) {
        setLocked(true);
      } else {
        showToast(t("workspaces.speakingOther"), { variant: "info" });
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const release = async () => {
    if (!sid || busy) return;
    setBusy(true);
    try {
      await api.orgWsRelease(sid);
      setLocked(false);
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    const text = speakText.trim();
    if (!wid || !sid || !text || busy) return;
    setBusy(true);
    try {
      await api.orgWsSay(wid, sid, text);
      setSpeakText("");
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const createSession = async () => {
    const title = newSessionTitle.trim();
    if (!wid || !title || busy) return;
    setBusy(true);
    try {
      const created = await api.orgWsCreateSession(wid, title);
      setNewSessionTitle("");
      await loadSessions(wid);
      setSid(created.id);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const loadDeliverables = useCallback(async (workspaceId: string) => {
    const rows = await api.orgWsDeliverables(workspaceId);
    setDeliverables(
      (rows as unknown as OrgDeliverable[]).slice().sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")),
    );
  }, []);

  useEffect(() => {
    if (tab !== "deliverables" || !wid) return;
    void loadDeliverables(wid).catch(() => setDeliverables([]));
  }, [tab, wid, loadDeliverables]);

  const uploadDeliverable = async (file: File) => {
    if (!wid || busy) return;
    setBusy(true);
    try {
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () =>
          resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
        reader.onerror = () => reject(new Error("read failed"));
        reader.readAsDataURL(file);
      });
      await api.orgWsDeliverableUpload({
        wid,
        path: file.name,
        title: file.name,
        contentBase64,
        sessionId: sid ?? undefined,
      });
      await loadDeliverables(wid);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const downloadDeliverable = async (d: OrgDeliverable) => {
    try {
      const result = await api.orgWsDeliverableDownload(d.id);
      const bytes = Uint8Array.from(atob(result.contentBase64), (ch) =>
        ch.charCodeAt(0),
      );
      const blob = new Blob([bytes]);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = d.title || d.path;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    }
  };

  if (status && status.state !== "connected") {
    return (
      <div className="settings-stack">
        <section className="settings-card-block">
          <h3 className="settings-card-heading">{t("workspaces.title")}</h3>
          <div className="settings-panel">
            <div className="model-provider-empty">
              <div className="model-provider-empty-icon" aria-hidden>
                <IconUser size={18} />
              </div>
              <div className="model-provider-empty-title">
                {t("workspaces.signInFirst")}
              </div>
              <div className="model-provider-empty-desc">
                {t("workspaces.signInHint")}
              </div>
              <Button
                variant="primary"
                onClick={() => {
                  const setSettingsTab = useAppStore.getState().setSettingsTab;
                  useAppStore.getState().setPage("settings");
                  setSettingsTab("org");
                }}
              >
                {t("settings.nav.org")}
              </Button>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="settings-stack workspaces-page">
      <section className="settings-card-block">
        <div className="model-config-section-head">
          <div className="settings-card-heading-line">
            <h3 className="settings-card-heading">{t("workspaces.title")}</h3>
            {workspaces.length > 0 ? (
              <span className="provider-section-count">{workspaces.length}</span>
            ) : null}
          </div>
        </div>
        <div className="settings-panel model-provider-panel">
          {workspaces.length === 0 ? (
            <div className="model-provider-empty">
              <div className="model-provider-empty-title">
                {t("workspaces.emptyTitle")}
              </div>
              <div className="model-provider-empty-desc">
                {t("workspaces.emptyDesc")}
              </div>
            </div>
          ) : (
            <ul className="model-provider-list">
              {workspaces.map((workspace) => (
                <li
                  key={workspace.id}
                  className={`model-provider-row ${workspace.id === wid ? "" : "is-disabled"}`}
                >
                  <div className="model-provider-row-copy">
                    <div className="model-provider-row-title">
                      <span className="model-provider-row-name">{workspace.name}</span>
                      <Badge tone={workspace.perm === "manager" ? "success" : "neutral"}>
                        {t(`workspaces.perm.${workspace.perm}`, {
                          defaultValue: workspace.perm,
                        })}
                      </Badge>
                    </div>
                    <div className="model-provider-row-meta">
                      <span>{workspace.teamId ?? ""}</span>
                    </div>
                  </div>
                  <div className="model-provider-row-actions">
                    <Button
                      size="sm"
                      variant={workspace.id === wid ? "secondary" : "ghost"}
                      onClick={() => setWid(workspace.id)}
                    >
                      {workspace.id === wid ? t("workspaces.current") : t("workspaces.open")}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {wid ? (
        <section className="settings-card-block">
          <div className="model-config-section-head">
            <div className="settings-card-heading-line">
              <h3 className="settings-card-heading">{t("workspaces.sessions")}</h3>
            </div>
            {canSpeak ? (
              <div className="workspaces-new-session">
                <input
                  className="field-input"
                  value={newSessionTitle}
                  placeholder={t("workspaces.newSession")}
                  onChange={(event) => setNewSessionTitle(event.target.value)}
                />
                <Button
                  variant="primary"
                  disabled={busy || !newSessionTitle.trim()}
                  onClick={() => void createSession()}
                >
                  <IconPlus size={14} />
                  {t("workspaces.create")}
                </Button>
              </div>
            ) : null}
          </div>
          <div className="settings-panel model-provider-panel">
            {sessions.length === 0 ? (
              <div className="model-provider-empty">
                <div className="model-provider-empty-title">
                  {t("workspaces.noSessions")}
                </div>
              </div>
            ) : (
              <ul className="model-provider-list">
                {sessions.map((session) => (
                  <li key={session.id} className="model-provider-row">
                    <div className="model-provider-row-copy">
                      <div className="model-provider-row-title">
                        <span className="model-provider-row-name">{session.title}</span>
                        {session.lockHolderName ? (
                          <Badge tone="warning">
                            {t("workspaces.speaking", {
                              name: session.lockHolderName,
                            })}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="model-provider-row-meta">
                        <span>
                          {t("workspaces.entryCount", { count: session.lastSeq + 1 })}
                        </span>
                      </div>
                    </div>
                    <div className="model-provider-row-actions">
                      <Button
                        size="sm"
                        variant={sid === session.id ? "secondary" : "ghost"}
                        onClick={() => setSid(session.id)}
                      >
                        {sid === session.id ? t("workspaces.opened") : t("workspaces.open")}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      ) : null}

      {sid ? (
        <section className="settings-card-block">
          <div className="workspaces-session-head">
            <div className="workspaces-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "sessions"}
                className={tab === "sessions" ? "is-active" : ""}
                onClick={() => setTab("sessions")}
              >
                {t("workspaces.tabTranscript")}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "deliverables"}
                className={tab === "deliverables" ? "is-active" : ""}
                onClick={() => setTab("deliverables")}
              >
                {t("workspaces.tabDeliverables")}
              </button>
            </div>
          </div>

          {tab === "sessions" ? (
            <div className="workspaces-transcript">
              <div className="workspaces-lockbar">
                {lockHolder ? (
                  <span>
                    {t("workspaces.speaking", { name: lockHolder })}
                    {locked ? ` · ${t("workspaces.you")}` : ""}
                  </span>
                ) : (
                  <span>{t("workspaces.idle")}</span>
                )}
                {locked ? (
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => void release()}>
                    {t("workspaces.release")}
                  </Button>
                ) : null}
              </div>
              <div className="workspaces-entries">
                {entries.length === 0 ? (
                  <div className="usage-quota-none">{t("workspaces.noEntries")}</div>
                ) : (
                  entries.map((entry) => {
                    const text = String(entry.entry?.text ?? "");
                    const kind = String(entry.entry?.kind ?? "say");
                    return (
                      <div
                        key={entry.seq}
                        className={`workspaces-entry is-${kind} is-mine-${Boolean(
                          locked && false,
                        )}`}
                      >
                        <span className="workspaces-entry-seq">#{entry.seq}</span>
                        <span className="workspaces-entry-text">{text || kind}</span>
                      </div>
                    );
                  })
                )}
              </div>
              {canSpeak ? (
                locked ? (
                  <div className="workspaces-speak">
                    <input
                      className="field-input"
                      value={speakText}
                      placeholder={t("workspaces.speakPlaceholder")}
                      onChange={(event) => setSpeakText(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          void send();
                        }
                      }}
                    />
                    <Button variant="primary" disabled={busy || !speakText.trim()} onClick={() => void send()}>
                      {t("workspaces.send")}
                    </Button>
                  </div>
                ) : (
                  <div className="workspaces-speak">
                    <Button variant="primary" disabled={busy} onClick={() => void acquire()}>
                      {t("workspaces.acquire")}
                    </Button>
                  </div>
                )
              ) : (
                <div className="workspaces-speak">
                  <span className="settings-row-desc">{t("workspaces.viewerHint")}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="workspaces-deliverables">
              <div className="workspaces-speak">
                {canUpload ? (
                  <>
                    <input
                      ref={fileInputRef}
                      type="file"
                      className="sr-only"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file) void uploadDeliverable(file);
                      }}
                    />
                    <Button
                      variant="primary"
                      disabled={busy}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <IconArrowUp size={14} />
                      {t("workspaces.upload")}
                    </Button>
                  </>
                ) : null}
              </div>
              {deliverables.length === 0 ? (
                <div className="usage-quota-none">{t("workspaces.noDeliverables")}</div>
              ) : (
                <table className="usage-table">
                  <thead>
                    <tr>
                      <th>{t("workspaces.colTitle")}</th>
                      <th>{t("workspaces.colPath")}</th>
                      <th>{t("workspaces.colVersion")}</th>
                      <th>{t("workspaces.colActions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deliverables.map((d) => (
                      <tr key={d.id}>
                        <td>{d.title}</td>
                        <td>{d.path}</td>
                        <td>v{d.currentVersion}</td>
                        <td>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void downloadDeliverable(d)}
                          >
                            {t("workspaces.download")}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
