import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ExpertTeamProgress,
  McpServerRecord,
  ProviderPublic,
  ThinkingLevel,
  UserSkillRecord,
} from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { api, type ExpertListItem, type ExpertTeamListItem } from "../../lib/api";
import { THINKING_LEVELS } from "@pi-desktop/shared";
import { Badge, Button, Field, Input, Panel, Select, Textarea, cx } from "../ui";
import {
  AgentCapabilityPage,
  CapabilityButton,
  CapabilityEmpty,
  CapabilityGroupHeader,
  CapabilityPanel,
  CapabilityRow,
  CapabilityToolbar,
} from "./AgentCapabilityLayout";
import {
  McpEditorSheet,
  draftFromRecord,
  draftToInput,
  emptyMcpDraft,
  type McpDraft,
} from "../extensions/McpEditorSheet";
import { AgentMultiSelect } from "./AgentMultiSelect";
import { IconGraduationCap, IconPencil, IconPlus, IconServer, IconUser, IconUsers, IconX } from "../icons";

/** Industry filter chips: the fixed catalog first, then anything else in data. */
const FIXED_INDUSTRIES = ["通用", "战略与组织", "金融", "先进制造", "TMT", "医疗健康"];
const LEADER_STYLES = ["fine", "coarse"] as const;
const INTEGRATION_MODES = ["moderator", "summary", "sections"] as const;
const MAX_TEAM_MEMBERS = 6;

interface ExpertFormState {
  name: string;
  description: string;
  industry: string;
  tags: string;
  examples: string;
  /** Multi-select from the user's skill list (4a). */
  skills: string[];
  /** Multi-select from the user's GLOBAL MCP servers (module 01 polish). */
  mcpServers: string[];
  /** `providerId/modelId` from the provider list; empty = same as session. */
  model: string;
  thinkingLevel: ThinkingLevel | "";
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
interface TeamRunStage {
  index: number;
  total: number;
  name: string;
  round?: number;
  maxRounds?: number;
  expert?: string;
}

interface TeamRunView {
  runId: string;
  teamName: string;
  phase: string;
  members: Array<{ expert: string; status: string }>;
  totalTokens: number;
  budgetTokens?: number;
  stage?: TeamRunStage;
  updatedAt: number;
}

interface ModelOption {
  value: string;
  label: string;
}

const EMPTY_EXPERT_FORM: ExpertFormState = {
  name: "",
  description: "",
  industry: "",
  tags: "",
  examples: "",
  skills: [],
  mcpServers: [],
  model: "",
  thinkingLevel: "",
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

/** Enabled providers with a usable credential, flattened to model options. */
function modelOptionsFrom(providers: ProviderPublic[]): ModelOption[] {
  const options: ModelOption[] = [];
  for (const provider of providers) {
    if (!provider.enabled) continue;
    if (!(provider.hasSecret || provider.hasOauth || provider.authKind === "none")) continue;
    for (const model of provider.models ?? []) {
      options.push({
        value: `${provider.id}/${model.id}`,
        label: `${provider.name} · ${model.id}`,
      });
    }
  }
  return options;
}

/**
 * Editor field heading (div-based, NOT a `<label>` wrapper — the label
 * element forwards clicks to the first labelable control inside, which
 * broke checkbox pickers). `required` renders the red asterisk; `error`
 * turns the title red until the user fills the value in.
 */
function EditorField({
  label,
  required = false,
  error = false,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  error?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className={cx("ext-field-label", error && "is-error")}>
        {label}
        {required ? (
          <span className="required-mark" aria-hidden="true">
            *
          </span>
        ) : null}
      </div>
      {children}
      {hint ? <p className="ext-field-hint">{hint}</p> : null}
    </div>
  );
}

export function AgentExpertsPage() {
  const { t } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const setPage = useAppStore((s) => s.setPage);
  const selectSession = useAppStore((s) => s.selectSession);
  const activeSessionId = useAppStore((s) => s.activeSessionId);

  const [experts, setExperts] = useState<ExpertListItem[]>([]);
  const [teams, setTeams] = useState<ExpertTeamListItem[]>([]);
  const [loading, setLoading] = useState(false);

  // Filters (single-page grouped list, mirroring the skills page).
  const [industry, setIndustry] = useState("all");
  const [query, setQuery] = useState("");

  // Expert invoke dialog (foreground dispatch: no target-session picker).
  const [invokeTarget, setInvokeTarget] = useState<ExpertListItem | null>(null);
  const [invokeTask, setInvokeTask] = useState("");
  const [invoking, setInvoking] = useState(false);

  // Team invoke dialog
  const [teamTarget, setTeamTarget] = useState<ExpertTeamListItem | null>(null);
  const [teamTask, setTeamTask] = useState("");
  const [teamInvoking, setTeamInvoking] = useState(false);

  // Expert editor sheet
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingPreset, setEditingPreset] = useState(false);
  const [form, setForm] = useState<ExpertFormState>(EMPTY_EXPERT_FORM);
  const [saving, setSaving] = useState(false);
  // Required-field validation: armed on save attempt, cleared live as the
  // user fills the field in (red title until the value exists).
  const [expertErrorsArmed, setExpertErrorsArmed] = useState(false);

  // Team editor sheet
  const [teamEditorOpen, setTeamEditorOpen] = useState(false);
  const [teamForm, setTeamForm] = useState<TeamFormState>(EMPTY_TEAM_FORM);
  const [teamSaving, setTeamSaving] = useState(false);
  const [teamErrorsArmed, setTeamErrorsArmed] = useState(false);

  // Live team runs (专家团 group)
  const [runs, setRuns] = useState<Record<string, TeamRunView>>({});

  // Picker sources (4a): the model, skill, and GLOBAL MCP server lists come
  // from LaboFlow itself; project-scoped MCP configs are never read here.
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [skillOptions, setSkillOptions] = useState<UserSkillRecord[]>([]);
  const [mcpOptions, setMcpOptions] = useState<McpServerRecord[]>([]);
  const [mcpEditorDraft, setMcpEditorDraft] = useState<McpDraft | null>(null);
  const [mcpEditingId, setMcpEditingId] = useState<string | null>(null);
  const [mcpSaving, setMcpSaving] = useState(false);
  const [mcpTesting, setMcpTesting] = useState(false);

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

  /** Load picker sources once per editor opening; empty lists degrade to hints. */
  const loadPickerSources = async () => {
    try {
      const { providers } = await api.listProviders();
      setModelOptions(modelOptionsFrom(providers ?? []));
    } catch {
      setModelOptions([]);
    }
    try {
      const { skills } = await api.listUserSkills();
      setSkillOptions((skills ?? []).filter((skill) => skill.enabled));
    } catch {
      setSkillOptions([]);
    }
    try {
      // Global scope only: project-workspace MCP configs must not leak into
      // the expert's server list.
      const { servers } = await api.listMcpServers({ level: "global" });
      setMcpOptions(servers ?? []);
    } catch {
      setMcpOptions([]);
    }
  };

  useEffect(() => {
    void refresh();
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
        const stageRaw = payload.stage as Record<string, unknown> | undefined;
        const next: TeamRunView = {
          runId: event.runId,
          teamName: asString(payload.team) ?? prev?.teamName ?? "",
          phase: asString(payload.phase) ?? prev?.phase ?? "planning",
          members,
          totalTokens: asNumber(payload.totalTokens) ?? prev?.totalTokens ?? 0,
          budgetTokens: asNumber(payload.budgetTokens) ?? prev?.budgetTokens,
          stage: stageRaw
            ? {
                index: asNumber(stageRaw.index) ?? 0,
                total: asNumber(stageRaw.total) ?? 0,
                name: asString(stageRaw.name) ?? "",
                round: asNumber(stageRaw.round),
                maxRounds: asNumber(stageRaw.maxRounds),
                expert: asString(stageRaw.expert),
              }
            : prev?.stage,
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
    // Expert and team invoke dialogs are mutually exclusive: a stale teamTarget
    // would flip the dialog into team mode (title, submit path).
    setTeamTarget(null);
    setTeamTask("");
    setInvokeTask(expert.examples[0] ?? "");
    setInvokeTarget(expert);
  };

  const submitInvoke = async () => {
    const target = invokeTarget;
    if (!target || !invokeTask.trim()) return;
    setInvoking(true);
    try {
      // Foreground dispatch: the invoke creates a NEW session — project-scoped
      // from the current one — and returns it; we navigate there.
      const result = await api.invokeExpert({
        sessionId: activeSessionId || undefined,
        expertId: target.id,
        task: invokeTask.trim(),
      });
      showToast(t("expert.dispatched", { expert: target.name }), { variant: "success" });
      setInvokeTarget(null);
      setInvokeTask("");
      await useAppStore.getState().refreshSessions();
      await selectSession(result.sessionId);
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
      const result = await api.invokeExpertTeam({
        sessionId: activeSessionId || undefined,
        teamId: target.id,
        task: teamTask.trim(),
      });
      showToast(t("expert.teamDispatched", { team: target.name }), { variant: "success" });
      setTeamTarget(null);
      setTeamTask("");
      await useAppStore.getState().refreshSessions();
      await selectSession(result.sessionId);
      setPage("chat");
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setTeamInvoking(false);
    }
  };

  const openExpertEditor = async (expert: ExpertListItem | null) => {
    void loadPickerSources();
    setExpertErrorsArmed(false);
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
        skills: [...record.skills],
        mcpServers: [...record.mcpServers],
        model: record.model ?? "",
        thinkingLevel: (record.thinkingLevel as ThinkingLevel | undefined) ?? "",
        body: detail.body ?? "",
      });
      setEditorOpen(true);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    }
  };

  const submitExpertForm = async () => {
    // Required: name + description (host-core rejects saves without them).
    if (!form.name.trim() || !form.description.trim()) {
      setExpertErrorsArmed(true);
      return;
    }
    setSaving(true);
    try {
      await api.saveExpert({
        name: form.name.trim(),
        description: form.description.trim(),
        ...(form.industry ? { industry: form.industry } : {}),
        tags: splitList(form.tags),
        examples: form.examples
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        skills: form.skills,
        mcpServers: form.mcpServers,
        ...(form.model.trim() ? { model: form.model.trim() } : {}),
        ...(form.thinkingLevel ? { thinkingLevel: form.thinkingLevel } : {}),
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

  /** Save the in-sheet MCP form into the user's GLOBAL server list. */
  const submitMcpEditor = async () => {
    if (!mcpEditorDraft) return;
    const candidateId = mcpEditorDraft.id.trim();
    if (!candidateId) {
      showToast(t("settings.mcpDuplicate"), { variant: "error" });
      return;
    }
    setMcpSaving(true);
    try {
      await api.upsertMcpServer(
        draftToInput(mcpEditorDraft, { level: "global" }),
      );
      const { servers } = await api.listMcpServers({ level: "global" });
      setMcpOptions(servers ?? []);
      // The freshly added server becomes selected for this expert.
      setForm((current) => ({
        ...current,
        mcpServers: current.mcpServers.includes(candidateId)
          ? current.mcpServers
          : [...current.mcpServers, candidateId],
      }));
      setMcpEditorDraft(null);
      setMcpEditingId(null);
      showToast(t("expert.mcpAdded", { name: mcpEditorDraft.label || candidateId }), {
        variant: "success",
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setMcpSaving(false);
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
    void loadPickerSources();
    setTeamErrorsArmed(false);
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
    // Required: name + description + at least one member (host-core rules).
    if (!teamForm.name.trim() || !teamForm.description.trim() || !teamForm.members.length) {
      setTeamErrorsArmed(true);
      return;
    }
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

  /** One expert as a capability row (skills-page parity for list layout). */
  const renderExpertRow = (expert: ExpertListItem) => {
    const key = `expert:${expert.id}`;
    return (
      <CapabilityRow
        key={key}
        glyph={<IconGraduationCap size={16} />}
        name={expert.name}
        off={!expert.enabled}
        badges={
          <>
            <span className="agent-capability-badge">{sourceBadge(expert.source)}</span>
            {expert.industry ? (
              <span className="agent-capability-badge">{expert.industry}</span>
            ) : null}
            {!expert.enabled ? (
              <span className="agent-capability-badge">{t("expert.disabled")}</span>
            ) : null}
          </>
        }
        description={expert.description || t("settings.noCapabilityDescription")}
        meta={
          expert.tags.length ? (
            <div className="flex flex-wrap gap-1">
              {expert.tags.map((tag) => (
                <Badge key={tag} tone="neutral">
                  {tag}
                </Badge>
              ))}
            </div>
          ) : undefined
        }
        actions={
          <>
            <Button size="sm" variant="primary" onClick={() => openInvoke(expert)}>
              {t("expert.summon")}
            </Button>
            {String(expert.source) !== "org" ? (
              <Button size="sm" variant="secondary" onClick={() => void openExpertEditor(expert)}>
                <IconPencil size={13} />
                {t("expert.edit")}
              </Button>
            ) : null}
            {expert.source === "user" ? (
              <>
                <Button size="sm" variant="secondary" onClick={() => void toggleExpert(expert)}>
                  {expert.enabled ? t("expert.disabled") : t("expert.enabled")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void deleteExpert(expert)}>
                  {t("expert.delete")}
                </Button>
              </>
            ) : null}
          </>
        }
      />
    );
  };

  /** One team as a capability row. */
  const renderTeamRow = (team: ExpertTeamListItem) => (
    <CapabilityRow
      key={`team:${team.id}`}
      glyph={<IconUsers size={16} />}
      name={team.name}
      off={!team.enabled}
      badges={
        <>
          <span className="agent-capability-badge">{sourceBadge(team.source)}</span>
          <span className="agent-capability-badge">
            {t("expert.leaderStyle")}:{" "}
            {t(`expert.leader_${team.leaderStyle === "coarse" ? "coarse" : "fine"}`)}
          </span>
          {team.budgetTokens != null ? (
            <span className="agent-capability-badge">
              {t("expert.budgetShort")}: {team.budgetTokens.toLocaleString()}
            </span>
          ) : null}
        </>
      }
      description={team.description || t("settings.noCapabilityDescription")}
      meta={
        team.members.length ? (
          <div className="flex flex-wrap gap-1">
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
        ) : undefined
      }
      actions={
        <>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              setInvokeTarget(null);
              setInvokeTask("");
              setTeamTask("");
              setTeamTarget(team);
            }}
          >
            {t("expert.invoke")}
          </Button>
          {/* Preset teams are editable too: saving a doc with the same name
              shadows the builtin (name is the id), same pattern as preset
              experts. Org packs stay read-only. */}
          {team.source === "user" || team.source === "preset" ? (
            <>
              <Button size="sm" variant="secondary" onClick={() => openTeamEditor(team)}>
                <IconPencil size={13} />
                {t("expert.edit")}
              </Button>
              {team.source === "user" ? (
                <Button size="sm" variant="ghost" onClick={() => void deleteTeam(team)}>
                  {t("expert.delete")}
                </Button>
              ) : null}
            </>
          ) : null}
        </>
      }
    />
  );

  const renderInvokeDialog = () => {
    if (!invokeTarget && !teamTarget) return null;
    const isTeam = Boolean(teamTarget);
    const name = invokeTarget?.name ?? teamTarget?.name ?? "";
    const task = invokeTarget ? invokeTask : teamTask;
    const setTask = invokeTarget ? setInvokeTask : setTeamTask;
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
          <p className="text-xs text-text-muted">{t("expert.newSessionNote")}</p>
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

  const toggleFormSkill = (name: string, on: boolean) => {
    setForm((current) => ({
      ...current,
      skills: on
        ? [...current.skills, name]
        : current.skills.filter((skill) => skill !== name),
    }));
  };

  const toggleFormMcp = (id: string, on: boolean) => {
    setForm((current) => ({
      ...current,
      mcpServers: on
        ? [...current.mcpServers, id]
        : current.mcpServers.filter((server) => server !== id),
    }));
  };

  const renderExpertEditor = () => {
    if (!editorOpen) return null;
    // Required-field errors arm on save and clear live as values arrive.
    const nameError = expertErrorsArmed && !form.name.trim();
    const descriptionError = expertErrorsArmed && !form.description.trim();
    return (
      <>
      <div
        className="overlay ext-sheet-overlay"
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !saving) setEditorOpen(false);
        }}
      >
        <div className="dialog ext-sheet" role="dialog" aria-modal aria-labelledby="expert-sheet-title">
          <div className="ext-sheet-head">
            <div>
              <h3 id="expert-sheet-title" className="ext-sheet-title">
                {t("expert.editorTitle")}
              </h3>
              <p className="ext-sheet-sub">{t("expert.editorSubtitle")}</p>
            </div>
            <button
              type="button"
              className="ext-sheet-close"
              aria-label={t("common.close")}
              onClick={() => setEditorOpen(false)}
            >
              <IconX size={14} />
            </button>
          </div>

          <div className="ext-sheet-body">
            {editingPreset ? (
              <p className="ext-field-hint">{t("expert.presetShadowNote")}</p>
            ) : null}
            <div className="ext-field-pair">
              <EditorField
                label={t("expert.fieldName")}
                required
                error={nameError}
                hint={editingPreset ? t("expert.presetNameHint") : undefined}
              >
                <Input
                  value={form.name}
                  autoFocus={!editingPreset}
                  disabled={editingPreset}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                />
              </EditorField>
              <EditorField label={t("expert.fieldIndustry")}>
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
              </EditorField>
            </div>

            <EditorField label={t("expert.fieldDescription")} required error={descriptionError}>
              <Input
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            </EditorField>

            <div className="ext-field-pair">
              <EditorField label={t("expert.fieldTags")} hint={t("expert.tagsHint")}>
                <Input
                  value={form.tags}
                  onChange={(event) => setForm({ ...form, tags: event.target.value })}
                />
              </EditorField>
              <EditorField label={t("expert.fieldModel")} hint={t("expert.modelHint")}>
                <Select
                  value={form.model}
                  onChange={(event) => setForm({ ...form, model: event.target.value })}
                >
                  <option value="">{t("expert.modelInherit")}</option>
                  {modelOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </EditorField>
            </div>

            <Field label={t("expert.fieldExamples")} hint={t("expert.examplesHint")}>
              <Textarea
                rows={2}
                value={form.examples}
                onChange={(event) => setForm({ ...form, examples: event.target.value })}
              />
            </Field>

            <div className="ext-field-group">
              <div className="ext-field-label">{t("expert.fieldThinking")}</div>
              <p className="ext-field-hint">{t("expert.thinkingHint")}</p>
              <Select
                value={form.thinkingLevel}
                onChange={(event) =>
                  setForm({
                    ...form,
                    thinkingLevel: event.target.value as ThinkingLevel | "",
                  })
                }
              >
                <option value="">{t("expert.thinkInherit")}</option>
                {THINKING_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {t(`thinkingLevel.${level}`)}
                  </option>
                ))}
              </Select>
            </div>

            <div className="ext-field-group">
              <div className="ext-field-label">{t("expert.fieldSkills")}</div>
              <p className="ext-field-hint">{t("expert.skillsHint")}</p>
              <AgentMultiSelect
                options={skillOptions.map((skill) => ({
                  value: skill.id,
                  label: skill.name || skill.id,
                  description: skill.description || "",
                }))}
                selected={form.skills}
                onChange={(next) => setForm((current) => ({ ...current, skills: next }))}
                placeholder={t("expert.skillsSelect")}
                emptyLabel={t("expert.skillsEmpty")}
              />
            </div>

            <div className="ext-field-group">
              <div className="flex items-center justify-between gap-2">
                <div className="ext-field-label">{t("expert.fieldMcp")}</div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setMcpEditorDraft(emptyMcpDraft());
                    setMcpEditingId(null);
                  }}
                >
                  <IconPlus size={13} />
                  {t("expert.mcpAdd")}
                </Button>
              </div>
              <p className="ext-field-hint">{t("expert.mcpHint")}</p>
              {mcpOptions.length ? (
                <div className="ext-tool-pick" role="group" aria-label={t("expert.fieldMcp")}>
                  {mcpOptions.map((server) => (
                    <label
                      key={server.id}
                      className={cx(
                        "ext-tool-opt",
                        form.mcpServers.includes(server.id) && "is-on",
                      )}
                      title={server.description || undefined}
                    >
                      <input
                        type="checkbox"
                        checked={form.mcpServers.includes(server.id)}
                        onChange={(event) => toggleFormMcp(server.id, event.target.checked)}
                      />
                      <IconServer size={12} />
                      <code>{server.label || server.id}</code>
                      <span className="ext-tool-opt-tag">{server.transport}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="ext-field-hint">{t("expert.mcpEmpty")}</p>
              )}
            </div>

            <div className="ext-field-group">
              <div className="ext-field-label">{t("expert.fieldBody")}</div>
              <p className="ext-field-hint">{t("expert.bodyHint")}</p>
              <Textarea
                className="ext-skill-body"
                rows={12}
                spellCheck={false}
                value={form.body}
                placeholder={t("expert.fieldBodyPlaceholder")}
                onChange={(event) => setForm({ ...form, body: event.target.value })}
              />
            </div>
          </div>

          <div className="ext-sheet-actions">
            <span className="ext-sheet-note">{t("expert.sheetNote")}</span>
            <div className="ext-sheet-actions-end">
              <Button variant="ghost" onClick={() => setEditorOpen(false)} disabled={saving}>
                {t("common.cancel")}
              </Button>
              <Button variant="primary" disabled={saving} onClick={() => void submitExpertForm()}>
                {saving ? t("common.saving") : t("common.save")}
              </Button>
            </div>
          </div>
        </div>
        </div>
        {mcpEditorDraft ? (
          <McpEditorSheet
            draft={mcpEditorDraft}
            setDraft={setMcpEditorDraft}
            editing={mcpEditingId ? (mcpOptions.find((s) => s.id === mcpEditingId) ?? null) : null}
            saving={mcpSaving}
            testing={false}
            projects={[]}
            onClose={() => {
              setMcpEditorDraft(null);
              setMcpEditingId(null);
            }}
            onSave={() => void submitMcpEditor()}
            onTest={() => undefined}
          />
        ) : null}
      </>
    );
  };

  const toggleTeamMember = (name: string, on: boolean) => {
    setTeamForm((current) => {
      if (!on) {
        return { ...current, members: current.members.filter((member) => member !== name) };
      }
      if (current.members.includes(name) || current.members.length >= MAX_TEAM_MEMBERS) {
        return current;
      }
      return { ...current, members: [...current.members, name] };
    });
  };

  const selectableMembers = useMemo(
    () => experts.filter((expert) => expert.enabled),
    [experts],
  );

  const renderTeamEditor = () => {
    if (!teamEditorOpen) return null;
    return (
      <div
        className="overlay ext-sheet-overlay"
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !teamSaving) setTeamEditorOpen(false);
        }}
      >
        <div className="dialog ext-sheet" role="dialog" aria-modal aria-labelledby="team-sheet-title">
          <div className="ext-sheet-head">
            <div>
              <h3 id="team-sheet-title" className="ext-sheet-title">
                {t("expert.teamEditorTitle")}
              </h3>
              <p className="ext-sheet-sub">{t("expert.teamEditorSubtitle")}</p>
            </div>
            <button
              type="button"
              className="ext-sheet-close"
              aria-label={t("common.close")}
              onClick={() => setTeamEditorOpen(false)}
            >
              <IconX size={14} />
            </button>
          </div>

          <div className="ext-sheet-body">
            <div className="ext-field-pair">
              <EditorField
                label={t("expert.fieldName")}
                required
                error={teamErrorsArmed && !teamForm.name.trim()}
              >
                <Input
                  value={teamForm.name}
                  autoFocus
                  onChange={(event) => setTeamForm({ ...teamForm, name: event.target.value })}
                />
              </EditorField>
              <Field label={t("expert.fieldBudget")} hint={t("expert.budgetHint")}>
                <Input
                  type="number"
                  min={1}
                  value={teamForm.budgetTokens}
                  placeholder={t("expert.budgetPlaceholder")}
                  onChange={(event) => setTeamForm({ ...teamForm, budgetTokens: event.target.value })}
                />
              </Field>
            </div>

            <EditorField
              label={t("expert.fieldDescription")}
              required
              error={teamErrorsArmed && !teamForm.description.trim()}
            >
              <Input
                value={teamForm.description}
                onChange={(event) => setTeamForm({ ...teamForm, description: event.target.value })}
              />
            </EditorField>

            <div className="ext-field-group">
              <div className="ext-field-label ext-field-label-row">
                <span className={cx(teamErrorsArmed && !teamForm.members.length && "is-error")}>
                  {t("expert.fieldMembers")}
                </span>
                <span className="ext-byte-count">
                  {t("expert.membersCount", {
                    count: teamForm.members.length,
                    max: MAX_TEAM_MEMBERS,
                  })}
                </span>
              </div>
              <p className="ext-field-hint">{t("expert.membersMaxHint", { max: MAX_TEAM_MEMBERS })}</p>
              {selectableMembers.length ? (
                <div className="ext-tool-pick" role="group" aria-label={t("expert.fieldMembers")}>
                  {selectableMembers.map((expert) => (
                    <label
                      key={expert.id}
                      className={cx(
                        "ext-tool-opt",
                        teamForm.members.includes(expert.name) && "is-on",
                      )}
                      title={expert.description || undefined}
                    >
                      <input
                        type="checkbox"
                        checked={teamForm.members.includes(expert.name)}
                        onChange={(event) => toggleTeamMember(expert.name, event.target.checked)}
                      />
                      <code>{expert.name}</code>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="ext-field-hint">{t("expert.membersEmpty")}</p>
              )}
            </div>

            <div className="ext-field-pair">
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

            <div className="ext-field-group">
              <div className="ext-field-label">{t("expert.fieldLeaderBody")}</div>
              <p className="ext-field-hint">{t("expert.leaderBodyHint")}</p>
              <Textarea
                className="ext-skill-body"
                rows={8}
                spellCheck={false}
                value={teamForm.body}
                placeholder={t("expert.fieldBodyPlaceholder")}
                onChange={(event) => setTeamForm({ ...teamForm, body: event.target.value })}
              />
            </div>
          </div>

          <div className="ext-sheet-actions">
            <span className="ext-sheet-note">{t("expert.sheetNote")}</span>
            <div className="ext-sheet-actions-end">
              <Button variant="ghost" onClick={() => setTeamEditorOpen(false)} disabled={teamSaving}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                disabled={teamSaving}
                onClick={() => void submitTeamForm()}
              >
                {teamSaving ? t("common.saving") : t("common.save")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // Grouped list (skills-page parity): teams with their live runs, personal
  // experts, then preset experts — one shared search + industry filter.
  const mineGroup = useMemo(
    () => centerExperts.filter((expert) => expert.source === "user"),
    [centerExperts],
  );
  const presetGroup = useMemo(
    () => centerExperts.filter((expert) => expert.source === "preset"),
    [centerExperts],
  );

  return (
    <AgentCapabilityPage
      className="agent-experts"
      toolbar={
        <CapabilityToolbar
          search={query}
          onSearchChange={setQuery}
          searchPlaceholder={t("expert.searchPlaceholder")}
          actions={
            <>
              <CapabilityButton
                variant="primary"
                title={t("expert.newExpert")}
                onClick={() => void openExpertEditor(null)}
              >
                <IconPlus size={14} />
                {t("expert.newExpert")}
              </CapabilityButton>
              <CapabilityButton title={t("expert.newTeam")} onClick={() => openTeamEditor(null)}>
                <IconPlus size={14} />
                {t("expert.newTeam")}
              </CapabilityButton>
            </>
          }
        />
      }
    >
      {industries.length ? (
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
        </div>
      ) : null}

      <CapabilityPanel loading={loading} loadingLabel={t("common.loading")}>
        <CapabilityGroupHeader label={t("expert.tabTeams")} path="~/.agents/teams" count={teams.length} />
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
              {run.stage ? (
                <div className="text-xs text-text-secondary">
                  {t("expert.stageOf", {
                    index: run.stage.index,
                    total: run.stage.total,
                    name: run.stage.name,
                    expert: run.stage.expert ?? "",
                  })}
                  {run.stage.round && run.stage.maxRounds && run.stage.maxRounds > 1
                    ? ` · ${t("expert.roundOf", { round: run.stage.round, max: run.stage.maxRounds })}`
                    : ""}
                </div>
              ) : null}
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
        {teams.length ? (
          teams.map(renderTeamRow)
        ) : (
          <CapabilityEmpty
            message={t("expert.emptyTeams")}
            icon={<IconUsers size={18} />}
            action={
              <CapabilityButton variant="primary" onClick={() => openTeamEditor(null)}>
                <IconPlus size={14} />
                {t("expert.newTeam")}
              </CapabilityButton>
            }
          />
        )}

        <CapabilityGroupHeader
          label={t("expert.tabMine")}
          path="~/.agents/experts"
          count={mineGroup.length}
          action={
            <CapabilityButton onClick={() => void openExpertEditor(null)}>
              <IconPlus size={14} />
              {t("expert.newExpert")}
            </CapabilityButton>
          }
        />
        {mineGroup.length ? (
          mineGroup.map(renderExpertRow)
        ) : (
          <CapabilityEmpty
            message={t("expert.emptyMine")}
            icon={<IconGraduationCap size={18} />}
            action={
              <CapabilityButton variant="primary" onClick={() => void openExpertEditor(null)}>
                <IconPlus size={14} />
                {t("expert.newExpert")}
              </CapabilityButton>
            }
          />
        )}

        <CapabilityGroupHeader label={t("expert.tabCenter")} path="builtin" count={presetGroup.length} />
        {presetGroup.length ? (
          presetGroup.map(renderExpertRow)
        ) : (
          <CapabilityEmpty
            message={t("expert.emptyCenter")}
            icon={<IconGraduationCap size={18} />}
          />
        )}
      </CapabilityPanel>

      {renderInvokeDialog()}
      {renderExpertEditor()}
      {renderTeamEditor()}
    </AgentCapabilityPage>
  );
}
