import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ExpertTeamProgress } from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { api, type ExpertListItem, type ExpertTeamListItem } from "../lib/api";
import { Badge, Button, Field, Input, Panel, Select, Textarea } from "../components/ui";
import { IconBot, IconPlus, IconSearch, IconSparkles, IconUser, IconUsers, IconX } from "../components/icons";

type ExpertTab = "center" | "mine" | "teams";

/** Industry filter chips: the fixed catalog first, then anything else in data. */
const FIXED_INDUSTRIES = ["通用", "战略与组织", "金融", "先进制造", "TMT", "医疗健康"];
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const LEADER_STYLES = ["fine", "coarse"] as const;
const INTEGRATION_MODES = ["moderator", "summary", "sections"] as const;
const MAX_TEAM_MEMBERS = 6;

interface ExpertFormState {
  name: string;
  description: string;
  industry: string;
  tags: string;
  examples: string;
  skills: string;
  mcpServers: string;
  model: string;
  thinkingLevel: string;
  budgetTokens: string;
  body: string;
}

interface TeamFormState {
  name: string;
  description: string;
  members: string[];
  leaderStyle: (typeof LEADER_STYLES)[number];
  integration: (typeof INTEGRATION_MODES)[number];
  budgetTokens: string;
  body: string;
}

/** One live/expired team run tracked from the expertTeamRun event stream. */
interface TeamRunView {
  runId: string;
  teamName: string;
  phase: string;
  members: Array<{ expert: string; status: string }>;
  totalTokens: number;
  budgetTokens?: number;
  updatedAt: number;
}

const EMPTY_EXPERT_FORM: ExpertFormState = {
  name: "",
  description: "",
  industry: "",
  tags: "",
  examples: "",
  skills: "",
  mcpServers: "",
  model: "",
  thinkingLevel: "",
  budgetTokens: "200000",
  body: "",
};

const EMPTY_TEAM_FORM: TeamFormState = {
  name: "",
  description: "",
  members: [],
  leaderStyle: "fine",
  integration: "moderator",
  budgetTokens: "",
  body: "",
};

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function ExpertsPage() {
  const { t } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const setPage = useAppStore((s) => s.setPage);
  const selectSession = useAppStore((s) => s.selectSession);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sessions = useAppStore((s) => s.sessions);

  const [tab, setTab] = useState<ExpertTab>("center");
  const [experts, setExperts] = useState<ExpertListItem[]>([]);
  const [teams, setTeams] = useState<ExpertTeamListItem[]>([]);
  const [loading, setLoading] = useState(false);

  // 专家中心 filters
  const [industry, setIndustry] = useState("all");
  const [query, setQuery] = useState("");

  // Expert invoke dialog
  const [invokeTarget, setInvokeTarget] = useState<ExpertListItem | null>(null);
  const [invokeTask, setInvokeTask] = useState("");
  const [invokeSessionId, setInvokeSessionId] = useState("");
  const [invoking, setInvoking] = useState(false);

  // Team invoke dialog
  const [teamTarget, setTeamTarget] = useState<ExpertTeamListItem | null>(null);
  const [teamTask, setTeamTask] = useState("");
  const [teamSessionId, setTeamSessionId] = useState("");
  const [teamInvoking, setTeamInvoking] = useState(false);

  // Expert editor sheet
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingPreset, setEditingPreset] = useState(false);
  const [form, setForm] = useState<ExpertFormState>(EMPTY_EXPERT_FORM);
  const [saving, setSaving] = useState(false);

  // Team editor sheet
  const [teamEditorOpen, setTeamEditorOpen] = useState(false);
  const [teamForm, setTeamForm] = useState<TeamFormState>(EMPTY_TEAM_FORM);
  const [teamSaving, setTeamSaving] = useState(false);

  // Live team runs (专家团 tab)
  const [runs, setRuns] = useState<Record<string, TeamRunView>>({});

  const refresh = async () => {
    setLoading(true);
    try {
      const [expertRes, teamRes] = await Promise.all([
        api.listExperts(),
        api.listExpertTeams(),
      ]);
      setExperts(expertRes ?? []);
      setTeams(teamRes ?? []);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    setInvokeSessionId(activeSessionId ?? "");
    setTeamSessionId(activeSessionId ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live team-run progress: team-runner events carry payload.team; single
  // expert invokes do not and are ignored here.
  useEffect(() => {
    const off = api.onExpertTeamRun((event: ExpertTeamProgress) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      if (!asString(payload.team)) return;
      setRuns((current) => {
        const prev = current[event.runId];
        const members = Array.isArray(payload.members)
          ? (payload.members as Array<Record<string, unknown>>).map((member) => ({
              expert: asString(member.expert) ?? "",
              status: asString(member.status) ?? "pending",
            }))
          : prev?.members ?? [];
        const next: TeamRunView = {
          runId: event.runId,
          teamName: asString(payload.team) ?? prev?.teamName ?? "",
          phase: asString(payload.phase) ?? prev?.phase ?? "planning",
          members,
          totalTokens: asNumber(payload.totalTokens) ?? prev?.totalTokens ?? 0,
          budgetTokens: asNumber(payload.budgetTokens) ?? prev?.budgetTokens,
          updatedAt: Date.now(),
        };
        return { ...current, [event.runId]: next };
      });
    });
    return off;
  }, []);

  const recentRuns = useMemo(
    () =>
      Object.values(runs)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 8),
    [runs],
  );

  const industries = useMemo(() => {
    const present = new Set<string>();
    for (const expert of experts) {
      if (expert.industry) present.add(expert.industry);
    }
    return [...FIXED_INDUSTRIES, ...[...present].filter((item) => !FIXED_INDUSTRIES.includes(item))];
  }, [experts]);

  const centerExperts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return experts.filter((expert) => {
      if (industry !== "all" && (expert.industry ?? "") !== industry) return false;
      if (!needle) return true;
      return (
        expert.name.toLowerCase().includes(needle) ||
        expert.description.toLowerCase().includes(needle) ||
        expert.tags.some((tag) => tag.toLowerCase().includes(needle))
      );
    });
  }, [experts, industry, query]);

  const mineExperts = useMemo(
    () => experts.filter((expert) => expert.source === "user"),
    [experts],
  );

  const sessionOptions = useMemo(
    () =>
      sessions
        .slice()
        .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
        .slice(0, 30),
    [sessions],
  );

  const phaseKey = (phase: string) => {
    if (phase === "executing") return "expert.phaseExecuting";
    if (phase === "integrating") return "expert.phaseIntegrating";
    if (phase === "done") return "expert.phaseDone";
    if (phase === "failed") return "expert.phaseFailed";
    return "expert.phasePlanning";
  };

  const phaseTone = (phase: string): "neutral" | "success" | "error" | "warning" => {
    if (phase === "done") return "success";
    if (phase === "failed") return "error";
    if (phase === "integrating") return "warning";
    return "neutral";
  };

  const memberTone = (status: string): "neutral" | "success" | "error" | "warning" => {
    if (status === "done" || status === "completed") return "success";
    if (status === "failed" || status === "error") return "error";
    if (status === "running") return "warning";
    return "neutral";
  };

  // Org-delivered experts (source "org", FR-E-18) get their own badge label;
  // the badge tone picker below maps them off the personal "success" color.
  const sourceBadge = (source: string) =>
    source === "preset"
      ? t("expert.sourcePreset")
      : source === "org"
        ? t("expert.sourceOrg")
        : t("expert.sourceMine");

  const sourceBadgeTone = (source: string): "neutral" | "success" | "warning" =>
    source === "preset" ? "neutral" : source === "org" ? "warning" : "success";

  const openInvoke = (expert: ExpertListItem) => {
    setInvokeTask(expert.examples[0] ?? "");
    setInvokeSessionId(activeSessionId ?? "");
    setInvokeTarget(expert);
  };

  const submitInvoke = async () => {
    const target = invokeTarget;
    if (!target || !invokeTask.trim()) return;
    setInvoking(true);
    try {
      await api.invokeExpert({
        sessionId: invokeSessionId || undefined,
        expertId: target.id,
        task: invokeTask.trim(),
      });
      showToast(t("expert.dispatched", { expert: target.name }), { variant: "success" });
      setInvokeTarget(null);
      setInvokeTask("");
      if (invokeSessionId) await selectSession(invokeSessionId);
      setPage("chat");
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setInvoking(false);
    }
  };

  const submitTeamInvoke = async () => {
    const target = teamTarget;
    if (!target || !teamTask.trim()) return;
    setTeamInvoking(true);
    try {
      await api.invokeExpertTeam({
        sessionId: teamSessionId || undefined,
        teamId: target.id,
        task: teamTask.trim(),
      });
      showToast(t("expert.teamDispatched", { team: target.name }), { variant: "success" });
      setTeamTarget(null);
      setTeamTask("");
      if (teamSessionId) await selectSession(teamSessionId);
      setPage("chat");
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setTeamInvoking(false);
    }
  };

  const openExpertEditor = async (expert: ExpertListItem | null) => {
    if (!expert) {
      setEditingPreset(false);
      setForm(EMPTY_EXPERT_FORM);
      setEditorOpen(true);
      return;
    }
    try {
      const detail = await api.getExpert(expert.id);
      const record = detail.expert ?? expert;
      setEditingPreset(record.source === "preset");
      setForm({
        name: record.name,
        description: record.description,
        industry: record.industry ?? "",
        tags: record.tags.join(", "),
        examples: record.examples.join("\n"),
        skills: record.skills.join(", "),
        mcpServers: record.mcpServers.join(", "),
        model: record.model ?? "",
        thinkingLevel: record.thinkingLevel ?? "",
        budgetTokens: record.budgetTokens != null ? String(record.budgetTokens) : "200000",
        body: detail.body ?? "",
      });
      setEditorOpen(true);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    }
  };

  const submitExpertForm = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const budget = Number(form.budgetTokens);
      await api.saveExpert({
        name: form.name.trim(),
        description: form.description.trim(),
        ...(form.industry ? { industry: form.industry } : {}),
        tags: splitList(form.tags),
        examples: form.examples
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        skills: splitList(form.skills),
        mcpServers: splitList(form.mcpServers),
        ...(form.model.trim() ? { model: form.model.trim() } : {}),
        ...(form.thinkingLevel ? { thinkingLevel: form.thinkingLevel } : {}),
        ...(Number.isFinite(budget) && budget > 0 ? { budgetTokens: budget } : {}),
        body: form.body,
      });
      setEditorOpen(false);
      await refresh();
      showToast(t("expert.saved"), { variant: "success" });
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  const deleteExpert = async (expert: ExpertListItem) => {
    if (!window.confirm(t("expert.deleteConfirm", { name: expert.name }))) return;
    try {
      await api.deleteExpert(expert.id);
      await refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    }
  };

  const toggleExpert = async (expert: ExpertListItem) => {
    try {
      await api.toggleExpert(expert.id, !expert.enabled);
      await refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    }
  };

  const openTeamEditor = (team: ExpertTeamListItem | null) => {
    if (!team) {
      setTeamForm(EMPTY_TEAM_FORM);
      setTeamEditorOpen(true);
      return;
    }
    void api.getExpertTeam(team.id).then((detail) => {
      const record = detail.team;
      setTeamForm({
        name: record?.name ?? team.name,
        description: record?.description ?? team.description,
        members: record?.members ?? team.members,
        leaderStyle: (record?.leaderStyle ?? team.leaderStyle) === "coarse" ? "coarse" : "fine",
        integration: (INTEGRATION_MODES as readonly string[]).includes(
          record?.integration ?? team.integration,
        )
          ? ((record?.integration ?? team.integration) as TeamFormState["integration"])
          : "moderator",
        budgetTokens:
          record?.budgetTokens != null ? String(record.budgetTokens) : "",
        body: detail.body ?? "",
      });
      setTeamEditorOpen(true);
    });
  };

  const submitTeamForm = async () => {
    if (!teamForm.name.trim()) return;
    setTeamSaving(true);
    try {
      const budget = Number(teamForm.budgetTokens);
      await api.saveExpertTeam({
        name: teamForm.name.trim(),
        description: teamForm.description.trim(),
        members: teamForm.members,
        leaderStyle: teamForm.leaderStyle,
        integration: teamForm.integration,
        ...(Number.isFinite(budget) && budget > 0 ? { budgetTokens: budget } : {}),
        ...(teamForm.body.trim() ? { body: teamForm.body } : {}),
      });
      setTeamEditorOpen(false);
      await refresh();
      showToast(t("expert.saved"), { variant: "success" });
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setTeamSaving(false);
    }
  };

  const deleteTeam = async (team: ExpertTeamListItem) => {
    if (!window.confirm(t("expert.teamDeleteConfirm", { name: team.name }))) return;
    try {
      await api.deleteExpertTeam(team.id);
      await refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    }
  };

  const retryMember = async (run: TeamRunView, index: number) => {
    try {
      await api.retryTeamMember({ runId: run.runId, index });
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    }
  };

  const renderExpertCard = (expert: ExpertListItem) => (
    <Panel key={expert.id} className="page-card flex flex-col space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-hover text-text-secondary">
            <IconBot size={15} />
          </span>
          <span className="min-w-0 truncate text-base-plus font-medium">{expert.name}</span>
        </div>
        <Badge tone={sourceBadgeTone(expert.source)}>
          {sourceBadge(expert.source)}
        </Badge>
      </div>
      <div className="line-clamp-2 text-sm text-text-secondary">{expert.description}</div>
      {expert.tags.length ? (
        <div className="flex flex-wrap gap-1">
          {expert.tags.map((tag) => (
            <Badge key={tag} tone="neutral">
              {tag}
            </Badge>
          ))}
        </div>
      ) : null}
      {expert.examples.length ? (
        <div className="space-y-1">
          {expert.examples.slice(0, 2).map((example) => (
            <button
              key={example}
              type="button"
              className="block w-full truncate rounded-md border border-border-default px-2 py-1 text-left text-xs text-text-secondary hover:bg-bg-hover"
              title={example}
              onClick={() => {
                setInvokeTarget(expert);
                setInvokeTask(example);
                setInvokeSessionId(activeSessionId ?? "");
              }}
            >
              {example}
            </button>
          ))}
        </div>
      ) : null}
      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        <span className="text-xs text-text-muted">{expert.industry}</span>
        <Button
          size="sm"
          variant="primary"
          onClick={() => openInvoke(expert)}
        >
          <IconSparkles size={13} />
          {t("expert.invoke")}
        </Button>
      </div>
    </Panel>
  );

  const renderSessionSelect = (
    value: string,
    onChange: (next: string) => void,
  ) => (
    <Field label={t("expert.targetSession")}>
      <Select value={value} onChange={(event) => onChange(event.target.value)}>
        {activeSessionId ? (
          <option value={activeSessionId}>{t("expert.currentSession")}</option>
        ) : null}
        <option value="">{t("expert.noSession")}</option>
        {sessionOptions
          .filter((session) => session.id !== activeSessionId)
          .map((session) => (
            <option key={session.id} value={session.id}>
              {session.title || t("chat.untitledTask")}
            </option>
          ))}
      </Select>
    </Field>
  );

  const renderInvokeDialog = () => {
    if (!invokeTarget && !teamTarget) return null;
    const isTeam = Boolean(teamTarget);
    const name = invokeTarget?.name ?? teamTarget?.name ?? "";
    const task = invokeTarget ? invokeTask : teamTask;
    const setTask = invokeTarget ? setInvokeTask : setTeamTask;
    const sessionId = invokeTarget ? invokeSessionId : teamSessionId;
    const setSessionId = invokeTarget ? setInvokeSessionId : setTeamSessionId;
    const busy = invoking || teamInvoking;
    const submit = invokeTarget ? submitInvoke : submitTeamInvoke;
    return (
      <div
        className="overlay"
        onClick={() => {
          setInvokeTarget(null);
          setTeamTarget(null);
        }}
      >
        <div
          className="dialog space-y-3"
          role="dialog"
          aria-modal="true"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="text-md-plus font-medium">
              {isTeam
                ? t("expert.invokeTeamTitle", { name })
                : t("expert.invokeTitle", { name })}
            </div>
            <button
              type="button"
              className="icon-btn"
              aria-label={t("common.close")}
              onClick={() => {
                setInvokeTarget(null);
                setTeamTarget(null);
              }}
            >
              <IconX size={15} />
            </button>
          </div>
          <Field label={t("expert.taskLabel")}>
            <Textarea
              rows={4}
              value={task}
              autoFocus
              placeholder={t("expert.taskPlaceholder")}
              onChange={(event) => setTask(event.target.value)}
            />
          </Field>
          {renderSessionSelect(sessionId, setSessionId)}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setInvokeTarget(null);
                setTeamTarget(null);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button variant="primary" disabled={busy || !task.trim()} onClick={() => void submit()}>
              {t("expert.dispatch")}
            </Button>
          </div>
        </div>
      </div>
    );
  };

  const renderExpertEditor = () => {
    if (!editorOpen) return null;
    return (
      <Panel className="page-card space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-md-plus font-medium">{t("expert.editorTitle")}</div>
          <button
            type="button"
            className="icon-btn"
            aria-label={t("common.close")}
            onClick={() => setEditorOpen(false)}
          >
            <IconX size={15} />
          </button>
        </div>
        {editingPreset ? (
          <div className="rounded-md border border-border-default bg-bg-hover px-3 py-2 text-xs text-text-secondary">
            {t("expert.presetShadowNote")}
          </div>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("expert.fieldName")}>
            <Input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </Field>
          <Field label={t("expert.fieldIndustry")}>
            <Select
              value={form.industry}
              onChange={(event) => setForm({ ...form, industry: event.target.value })}
            >
              <option value="">{t("expert.industryNone")}</option>
              {industries.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={t("expert.fieldDescription")}>
          <Input
            value={form.description}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("expert.fieldTags")}>
            <Input
              value={form.tags}
              onChange={(event) => setForm({ ...form, tags: event.target.value })}
            />
          </Field>
          <Field label={t("expert.fieldSkills")}>
            <Input
              value={form.skills}
              onChange={(event) => setForm({ ...form, skills: event.target.value })}
            />
          </Field>
        </div>
        <Field label={t("expert.fieldExamples")}>
          <Textarea
            rows={2}
            value={form.examples}
            onChange={(event) => setForm({ ...form, examples: event.target.value })}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("expert.fieldMcp")}>
            <Input
              value={form.mcpServers}
              onChange={(event) => setForm({ ...form, mcpServers: event.target.value })}
            />
          </Field>
          <Field label={t("expert.fieldModel")}>
            <Input
              value={form.model}
              placeholder={t("expert.fieldModelPlaceholder")}
              onChange={(event) => setForm({ ...form, model: event.target.value })}
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("expert.fieldThinking")}>
            <Select
              value={form.thinkingLevel}
              onChange={(event) => setForm({ ...form, thinkingLevel: event.target.value })}
            >
              <option value="">{t("expert.fieldModelPlaceholder")}</option>
              {THINKING_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {t(`expert.think_${level}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("expert.fieldBudget")}>
            <Input
              type="number"
              min={1}
              value={form.budgetTokens}
              onChange={(event) => setForm({ ...form, budgetTokens: event.target.value })}
            />
          </Field>
        </div>
        <Field label={t("expert.fieldBody")}>
          <Textarea
            rows={10}
            value={form.body}
            placeholder={t("expert.fieldBodyPlaceholder")}
            onChange={(event) => setForm({ ...form, body: event.target.value })}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setEditorOpen(false)}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={saving || !form.name.trim()} onClick={() => void submitExpertForm()}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      </Panel>
    );
  };

  const renderTeamEditor = () => {
    if (!teamEditorOpen) return null;
    return (
      <Panel className="page-card space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-md-plus font-medium">{t("expert.teamEditorTitle")}</div>
          <button
            type="button"
            className="icon-btn"
            aria-label={t("common.close")}
            onClick={() => setTeamEditorOpen(false)}
          >
            <IconX size={15} />
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("expert.fieldName")}>
            <Input
              value={teamForm.name}
              onChange={(event) => setTeamForm({ ...teamForm, name: event.target.value })}
            />
          </Field>
          <Field label={t("expert.fieldBudget")}>
            <Input
              type="number"
              min={1}
              value={teamForm.budgetTokens}
              onChange={(event) => setTeamForm({ ...teamForm, budgetTokens: event.target.value })}
            />
          </Field>
        </div>
        <Field label={t("expert.fieldDescription")}>
          <Input
            value={teamForm.description}
            onChange={(event) => setTeamForm({ ...teamForm, description: event.target.value })}
          />
        </Field>
        <Field
          label={t("expert.fieldMembers")}
          hint={t("expert.membersMaxHint", { max: MAX_TEAM_MEMBERS })}
        >
          <div className="flex flex-wrap gap-1.5">
            {experts.map((expert) => {
              const selected = teamForm.members.includes(expert.name);
              return (
                <button
                  key={expert.id}
                  type="button"
                  className={`rounded-full border px-2.5 py-1 text-xs ${
                    selected
                      ? "border-accent bg-accent-soft text-text-primary"
                      : "border-border-default text-text-secondary hover:bg-bg-hover"
                  } ${!selected && teamForm.members.length >= MAX_TEAM_MEMBERS ? "opacity-50" : ""}`}
                  onClick={() =>
                    setTeamForm((current) => {
                      if (current.members.includes(expert.name)) {
                        return {
                          ...current,
                          members: current.members.filter((name) => name !== expert.name),
                        };
                      }
                      if (current.members.length >= MAX_TEAM_MEMBERS) return current;
                      return { ...current, members: [...current.members, expert.name] };
                    })
                  }
                >
                  {expert.name}
                </button>
              );
            })}
          </div>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("expert.leaderStyle")}>
            <Select
              value={teamForm.leaderStyle}
              onChange={(event) =>
                setTeamForm({
                  ...teamForm,
                  leaderStyle: event.target.value as TeamFormState["leaderStyle"],
                })
              }
            >
              {LEADER_STYLES.map((style) => (
                <option key={style} value={style}>
                  {t(`expert.leader_${style}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("expert.integration")}>
            <Select
              value={teamForm.integration}
              onChange={(event) =>
                setTeamForm({
                  ...teamForm,
                  integration: event.target.value as TeamFormState["integration"],
                })
              }
            >
              {INTEGRATION_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {t(`expert.integration_${mode}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={t("expert.fieldLeaderBody")}>
          <Textarea
            rows={6}
            value={teamForm.body}
            placeholder={t("expert.fieldBodyPlaceholder")}
            onChange={(event) => setTeamForm({ ...teamForm, body: event.target.value })}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setTeamEditorOpen(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={teamSaving || !teamForm.name.trim()}
            onClick={() => void submitTeamForm()}
          >
            {teamSaving ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      </Panel>
    );
  };

  const renderTeamCard = (team: ExpertTeamListItem) => (
    <Panel key={team.id} className="page-card flex flex-col space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-hover text-text-secondary">
            <IconUsers size={15} />
          </span>
          <span className="min-w-0 truncate text-base-plus font-medium">{team.name}</span>
        </div>
        <Badge tone={sourceBadgeTone(team.source)}>
          {sourceBadge(team.source)}
        </Badge>
      </div>
      <div className="line-clamp-2 text-sm text-text-secondary">{team.description}</div>
      {team.members.length ? (
        <div className="flex flex-wrap items-center gap-1">
          {team.members.map((member) => (
            <span
              key={member}
              className="flex items-center gap-1 rounded-full border border-border-default px-2 py-0.5 text-xs text-text-secondary"
            >
              <IconUser size={11} />
              {member}
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-1">
        <Badge tone="neutral">{t("expert.leaderStyle")}: {t(`expert.leader_${team.leaderStyle === "coarse" ? "coarse" : "fine"}`)}</Badge>
        <Badge tone="neutral">
          {t("expert.integration")}:{" "}
          {t(
            `expert.integration_${
              (INTEGRATION_MODES as readonly string[]).includes(team.integration)
                ? team.integration
                : "moderator"
            }`,
          )}
        </Badge>
        {team.budgetTokens != null ? (
          <Badge tone="neutral">
            {t("expert.budgetShort")}: {team.budgetTokens.toLocaleString()}
          </Badge>
        ) : null}
      </div>
      <div className="mt-auto flex items-center justify-end gap-2 pt-1">
        {team.source === "user" ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => void deleteTeam(team)}>
              {t("expert.delete")}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => openTeamEditor(team)}>
              {t("expert.edit")}
            </Button>
          </>
        ) : null}
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            setTeamTask("");
            setTeamSessionId(activeSessionId ?? "");
            setTeamTarget(team);
          }}
        >
          <IconSparkles size={13} />
          {t("expert.invokeTeam")}
        </Button>
      </div>
    </Panel>
  );

  return (
    <div className="thread-scroll">
      <div className="page-frame">
        <div className="page-header">
          <div>
            <h1 className="page-title">{t("expert.title")}</h1>
            <div className="text-md text-text-secondary">{t("expert.subtitle")}</div>
          </div>
          <div className="flex gap-2">
            {tab === "mine" ? (
              <Button variant="primary" onClick={() => void openExpertEditor(null)}>
                <IconPlus size={14} />
                {t("expert.newExpert")}
              </Button>
            ) : null}
            {tab === "teams" ? (
              <Button variant="primary" onClick={() => openTeamEditor(null)}>
                <IconPlus size={14} />
                {t("expert.newTeam")}
              </Button>
            ) : null}
          </div>
        </div>

        <div className="dest-toolbar">
          <div className="dest-filters" role="tablist" aria-label={t("expert.title")}>
            {(
              [
                ["center", t("expert.tabCenter")],
                ["mine", t("expert.tabMine")],
                ["teams", t("expert.tabTeams")],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={`dest-filter ${tab === id ? "active" : ""}`}
                onClick={() => setTab(id)}
              >
                {id === "center" ? <IconSparkles size={13} /> : null}
                {id === "teams" ? <IconUsers size={13} /> : null}
                {label}
              </button>
            ))}
          </div>
        </div>

        {tab === "center" ? (
          <>
            <div className="dest-toolbar">
              <div className="dest-filters" role="group" aria-label={t("expert.fieldIndustry")}>
                <button
                  type="button"
                  className={`dest-filter ${industry === "all" ? "active" : ""}`}
                  onClick={() => setIndustry("all")}
                >
                  {t("expert.allIndustries")}
                </button>
                {industries.map((item) => (
                  <button
                    key={item}
                    type="button"
                    className={`dest-filter ${industry === item ? "active" : ""}`}
                    onClick={() => setIndustry(item)}
                  >
                    {item}
                  </button>
                ))}
              </div>
              <div className="relative min-w-[200px] flex-1">
                <Input
                  value={query}
                  placeholder={t("expert.searchPlaceholder")}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted">
                  <IconSearch size={14} />
                </span>
              </div>
            </div>
            {centerExperts.length === 0 ? (
              <Panel className="page-card page-empty">
                <div className="page-empty-icon">
                  <IconBot size={20} />
                </div>
                <div className="text-base-plus font-medium">{t("expert.emptyCenter")}</div>
              </Panel>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {centerExperts.map(renderExpertCard)}
              </div>
            )}
          </>
        ) : null}

        {tab === "mine" ? (
          <>
            {renderExpertEditor()}
            {mineExperts.length === 0 && !editorOpen ? (
              <Panel className="page-card page-empty">
                <div className="page-empty-icon">
                  <IconBot size={20} />
                </div>
                <div className="text-base-plus font-medium">{t("expert.emptyMine")}</div>
                <Button className="mt-5" variant="primary" onClick={() => void openExpertEditor(null)}>
                  {t("expert.newExpert")}
                </Button>
              </Panel>
            ) : (
              <div className="dest-list">
                {mineExperts.map((expert) => (
                  <div key={expert.id} className="dest-row">
                    <div className="dest-row-icon">
                      <IconBot size={16} />
                    </div>
                    <div className="dest-row-body">
                      <div className="dest-row-title">
                        <span className="min-w-0 truncate">{expert.name}</span>
                        <Badge tone={expert.enabled ? "success" : "neutral"}>
                          {expert.enabled ? t("expert.enabled") : t("expert.disabled")}
                        </Badge>
                        {expert.industry ? <Badge tone="neutral">{expert.industry}</Badge> : null}
                      </div>
                      <div className="dest-row-meta line-clamp-2">{expert.description}</div>
                    </div>
                    <div className="dest-row-actions">
                      <Button size="sm" variant="primary" onClick={() => openInvoke(expert)}>
                        {t("expert.invoke")}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => void toggleExpert(expert)}>
                        {expert.enabled ? t("expert.disabled") : t("expert.enabled")}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => void openExpertEditor(expert)}>
                        {t("expert.edit")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void deleteExpert(expert)}>
                        {t("expert.delete")}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : null}

        {tab === "teams" ? (
          <>
            {recentRuns.length ? (
              <div className="dest-section-label">{t("expert.runningTitle")}</div>
            ) : null}
            {recentRuns.map((run) => {
              const budget = run.budgetTokens ?? 0;
              const ratio = budget > 0 ? Math.min(1, run.totalTokens / budget) : 0;
              return (
                <Panel key={run.runId} className="page-card space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bg-hover text-text-secondary">
                        <IconUsers size={13} />
                      </span>
                      <span className="min-w-0 truncate text-sm font-medium">{run.teamName}</span>
                    </div>
                    <Badge tone={phaseTone(run.phase)}>{t(phaseKey(run.phase))}</Badge>
                  </div>
                  {run.members.length ? (
                    <div className="flex flex-wrap gap-1">
                      {run.members.map((member, index) => (
                        <span key={`${member.expert}-${index}`}>
                          <Badge tone={memberTone(member.status)}>
                            {member.expert}
                            {member.status === "failed" ? (
                              <button
                                type="button"
                                className="ml-1 underline"
                                onClick={() => void retryMember(run, index)}
                              >
                                {t("expert.retryMember")}
                              </button>
                            ) : null}
                          </Badge>
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-hover">
                      <div
                        className={`h-full rounded-full ${ratio >= 1 ? "bg-error" : "bg-success"}`}
                        style={{ width: `${Math.round(ratio * 100)}%` }}
                      />
                    </div>
                    <span className="text-xs text-text-muted">
                      {budget > 0
                        ? t("expert.budgetUsage", {
                            used: run.totalTokens.toLocaleString(),
                            budget: budget.toLocaleString(),
                          })
                        : t("expert.tokensUsed", { used: run.totalTokens.toLocaleString() })}
                    </span>
                  </div>
                </Panel>
              );
            })}
            {renderTeamEditor()}
            {teams.length === 0 && !teamEditorOpen ? (
              <Panel className="page-card page-empty">
                <div className="page-empty-icon">
                  <IconUsers size={20} />
                </div>
                <div className="text-base-plus font-medium">{t("expert.emptyTeams")}</div>
                <Button className="mt-5" variant="primary" onClick={() => openTeamEditor(null)}>
                  {t("expert.newTeam")}
                </Button>
              </Panel>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {teams.map(renderTeamCard)}
              </div>
            )}
          </>
        ) : null}

        {loading && !experts.length ? (
          <div className="dest-section-label">{t("common.loading")}</div>
        ) : null}
      </div>
      {renderInvokeDialog()}
    </div>
  );
}
