import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectRecord, ScheduledTask, ScheduledTaskRun } from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { api } from "../lib/api";
import { Badge, Button, Panel } from "../components/ui";
import { IconClock } from "../components/icons";
import { ScheduledEditor, type ScheduledDraft } from "../features/scheduled/ScheduledEditor";

export function ScheduledPage() {
  const { t, i18n } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const selectSession = useAppStore((s) => s.selectSession);
  const setPage = useAppStore((s) => s.setPage);
  const currentWorkspacePath = useAppStore((s) => s.workspace?.path ?? "");
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [runs, setRuns] = useState<ScheduledTaskRun[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [tab, setTab] = useState<"tasks" | "runs">("tasks");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelected = (id: string) =>
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const bulkRun = async (enabled: boolean) => {
    for (const id of selectedIds) {
      await api.updateScheduled({ id, enabled });
    }
    setSelectedIds(new Set());
    await refresh();
  };
  const bulkDelete = async () => {
    for (const id of selectedIds) {
      await api.deleteScheduled(id);
    }
    setSelectedIds(new Set());
    await refresh();
  };
  const applyTemplate = (template: { title: string; prompt: string; cadence: string; schedule?: unknown }) => {
    setEditor("new");
    setTemplatePrefill(template);
  };
  const [templatePrefill, setTemplatePrefill] = useState<
    { title: string; prompt: string; cadence: string; schedule?: unknown } | undefined
  >(undefined);
  const [editor, setEditor] = useState<ScheduledTask | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    try {
      const [taskResult, runResult, projectResult] = await Promise.all([
        api.listScheduled(),
        api.listScheduledRuns(),
        api.listProjects().catch(() => ({ projects: [] as ProjectRecord[] })),
      ]);
      if (!mounted.current || request !== revision.current) return;
      setTasks(taskResult.tasks);
      setRuns(runResult.runs);
      setProjects(projectResult.projects);
      setError("");
      setLoaded(true);
    } catch (failure) {
      if (mounted.current && request === revision.current)
        setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => {
      mounted.current = false;
      revision.current++;
      clearInterval(timer);
    };
  }, [refresh]);
  const action = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
      if (mounted.current) await refresh();
    } catch (failure) {
      showToast(failure instanceof Error ? failure.message : String(failure), { variant: "error" });
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const save = (draft: ScheduledDraft) =>
    action(async () => {
      if (editor && editor !== "new") await api.updateScheduled({ id: editor.id, ...draft });
      else await api.createScheduled(draft);
      if (mounted.current) setEditor(null);
    });
  const openSession = async (id: string) => {
    await selectSession(id);
    if (mounted.current) setPage("chat");
  };
  const date = (value: string) =>
    new Date(value).toLocaleString(i18n.resolvedLanguage ?? i18n.language);
  const cadenceKey = {
    manual: "scheduled.cadenceManual",
    interval: "scheduled.cadenceInterval",
    cron: "scheduled.cadenceCron",
    hourly: "scheduled.cadenceHourly",
    daily: "scheduled.cadenceDaily",
    weekly: "scheduled.cadenceWeekly",
  } as const;
  const statusKey = {
    running: "scheduled.statusRunning",
    completed: "scheduled.statusCompleted",
    aborted: "scheduled.statusAborted",
    error: "scheduled.statusError",
  } as const;
  return (
    <div className="route-scroll">
      <div className="page-frame">
        <div className="page-header">
          <div>
            <h1 className="page-title">{t("scheduled.title")}</h1>
            <p className="dest-row-meta">{t("scheduled.description")}</p>
          </div>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              setTab("tasks");
              setEditor("new");
            }}
          >
            {t("scheduled.create")}
          </Button>
        </div>
        <div className="mb-4 flex gap-2" role="group" aria-label={t("scheduled.title")}>
          <Button
            aria-pressed={tab === "tasks"}
            variant={tab === "tasks" ? "secondary" : "ghost"}
            onClick={() => setTab("tasks")}
          >
            {t("scheduled.tasks")} ({tasks.length})
          </Button>
          <Button
            aria-pressed={tab === "runs"}
            variant={tab === "runs" ? "secondary" : "ghost"}
            onClick={() => setTab("runs")}
          >
            {t("scheduled.runs")}
          </Button>
        </div>
        {error && (
          <Panel>
            <p role="alert">{error}</p>
            <Button onClick={() => void refresh()}>{t("scheduled.retry")}</Button>
          </Panel>
        )}
        {!loaded && !error && <p role="status">{t("common.loading")}</p>}
        {tab === "tasks" && (
          <>
            {editor && (
              <ScheduledEditor
                key={editor === "new" ? "new" : editor.id}
                task={editor === "new" ? undefined : editor}
                prefill={editor === "new" ? templatePrefill : undefined}
                projects={projects}
                currentWorkspacePath={currentWorkspacePath}
                busy={busy}
                save={save}
                cancel={() => setEditor(null)}
              />
            )}
            {loaded && !tasks.length && !editor && (
              <Panel className="page-card page-empty">
                <div className="page-empty-icon">
                  <IconClock size={20} />
                </div>
                <h2>{t("scheduled.emptyTitle")}</h2>
                <p className="dest-row-meta">{t("scheduled.description")}</p>
              </Panel>
            )}
            {!editor && (
              <div className="flex flex-wrap items-center gap-2 pb-2" data-testid="scheduled-templates">
                <span className="text-xs opacity-60">{t("scheduled.templates")}:</span>
                {[
                  { key: "morning", prompt: "抓取今日 AI 行业要闻，整理成一页晨报（要点+来源链接）。", title: t("scheduled.templateMorning"), cadence: "daily", schedule: { hour: 9, minute: 0, weekday: null } },
                  { key: "weekly", prompt: "汇总本周工作进展，生成周报初稿（本周完成/下周计划/风险）。", title: t("scheduled.templateWeekly"), cadence: "weekly", schedule: { hour: 17, minute: 0, weekday: 5 } },
                  { key: "scan", prompt: "扫描本周行业动态与竞对公开信息，输出结构化行业简报。", title: t("scheduled.templateScan"), cadence: "weekly", schedule: { hour: 8, minute: 30, weekday: 1 } },
                  { key: "monthly", prompt: "刷新本月项目数据面板，输出月度数据快照与变化摘要。", title: t("scheduled.templateMonthly"), cadence: "monthly", schedule: { hour: 10, minute: 0, day: 1, weekday: null } },
                ].map((template) => (
                  <Button key={template.key} size="sm" variant="ghost" onClick={() => applyTemplate(template)}>
                    {template.title}
                  </Button>
                ))}
              </div>
            )}
            {selectedIds.size > 0 && (
              <div className="flex items-center gap-2 pb-2" data-testid="scheduled-bulk-bar">
                <span className="text-xs opacity-70">{t("scheduled.selected", { count: selectedIds.size })}</span>
                <Button size="sm" disabled={busy} onClick={() => void action(() => bulkRun(true))}>
                  {t("scheduled.bulkEnable")}
                </Button>
                <Button size="sm" disabled={busy} onClick={() => void action(() => bulkRun(false))}>
                  {t("scheduled.bulkDisable")}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void action(() => bulkDelete())}>
                  {t("scheduled.bulkDelete")}
                </Button>
              </div>
            )}
            <div className="dest-list">
              {tasks.map((task) => {
                const running = runs.some(
                  (run) => run.taskId === task.id && run.status === "running",
                );
                return (
                  <div className="dest-row" key={task.id}>
                    <input
                      type="checkbox"
                      className="mt-1"
                      aria-label={t("scheduled.selectOne", { title: task.title })}
                      checked={selectedIds.has(task.id)}
                      onChange={() => toggleSelected(task.id)}
                    />
                    <div className="dest-row-icon">
                      <IconClock size={16} />
                    </div>
                    <div className="dest-row-body">
                      <div className="dest-row-title">
                        <span>{task.title}</span>
                        <Badge tone={task.enabled ? "success" : "neutral"}>
                          {t(task.enabled ? "scheduled.enabled" : "scheduled.disabled")}
                        </Badge>
                        <Badge tone="neutral">{t(cadenceKey[task.cadence])}</Badge>
                      </div>
                      <p className="dest-row-meta line-clamp-2">{task.prompt}</p>
                      <p className="dest-row-meta">
                        {task.schedule && task.enabled && task.nextRunAt
                          ? `${t("scheduled.nextRun")}: ${date(task.nextRunAt)}`
                          : t(
                              task.enabled && task.cadence !== "manual" && !task.schedule
                                ? "scheduled.legacyHint"
                                : "scheduled.noNextRun",
                            )}
                      </p>
                      {task.workspacePath && (
                        <p className="dest-row-meta truncate">{task.workspacePath}</p>
                      )}
                    </div>
                    <div className="dest-row-actions flex-wrap">
                      <Button
                        size="sm"
                        disabled={busy || running}
                        onClick={() =>
                          void action(async () => {
                            await api.executeScheduled(task.id);
                            if (mounted.current) setTab("runs");
                          })
                        }
                      >
                        {t(running ? "scheduled.statusRunning" : "scheduled.runNow")}
                      </Button>
                      <Button size="sm" disabled={busy} onClick={() => setEditor(task)}>
                        {t("scheduled.edit")}
                      </Button>
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            await api.updateScheduled({ id: task.id, enabled: !task.enabled });
                          })
                        }
                      >
                        {t(task.enabled ? "scheduled.pause" : "scheduled.resume")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || running}
                        onClick={() => {
                          if (window.confirm(t("scheduled.deleteConfirm", { title: task.title })))
                            void action(async () => {
                              await api.deleteScheduled(task.id);
                            });
                        }}
                      >
                        {t("scheduled.delete")}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
        {tab === "runs" && (
          <>
            <p className="dest-row-meta mb-3">{t("scheduled.historyHint")}</p>
            {!runs.length && loaded && (
              <Panel className="page-card page-empty">{t("scheduled.emptyRuns")}</Panel>
            )}
            <div className="dest-list">
              {runs.map((run) => (
                <div className="dest-row" key={run.id}>
                  <div className="dest-row-body">
                    <div className="dest-row-title">
                      <span>
                        {tasks.find((task) => task.id === run.taskId)?.title ??
                          t("scheduled.title")}
                      </span>
                      <Badge tone={run.status === "completed" ? "success" : "neutral"}>
                        {t(statusKey[run.status])}
                      </Badge>
                    </div>
                    <p className="dest-row-meta">{date(run.startedAt)}</p>
                    {run.errorCode && (
                      <p className="dest-row-meta">
                        {t("scheduled.runError")} ({run.errorCode})
                      </p>
                    )}
                  </div>
                  {run.sessionId && (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => void action(() => openSession(run.sessionId!))}
                    >
                      {t("scheduled.openResult")}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
