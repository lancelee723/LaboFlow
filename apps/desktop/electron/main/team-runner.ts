/**
 * TeamRunner (module 01, plan T51.6) — star-topology expert team orchestration.
 *
 * The leader is an orchestration ROLE, not a member: main plans the
 * decomposition with a one-shot completion, dispatches every subtask to an
 * independent background expert session (HeadlessAgentDriver, concurrency ≤4),
 * and integrates the results with a second one-shot. Members never talk to
 * each other — all coordination flows through this runner (ADR-E3).
 */

import { randomUUID } from "node:crypto";

import type {
  ExpertTeamProgress,
  TeamPlan,
  TeamPlanSubtask,
  ThinkingLevel,
} from "@pi-desktop/shared";
import {
  completeOneShot,
  type RuntimeProviderConfig,
} from "@pi-desktop/agent-runtime";
import { withSkillsBinding } from "./expert-service.ts";

const MAX_PARALLEL_MEMBERS = 4;
const DEP_RESULT_MAX_CHARS = 4000;
const BUDGET_WARNING_RATIO = 0.8;

/** Compact per-member token tag for delivery cards: " 12.3k tok", omitted at 0. */
function memberTokenTag(tokens: number): string {
  if (tokens <= 0) return "";
  return ` ${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tok`;
}

export interface TeamMemberState {
  expert: string;
  status: "pending" | "running" | "done" | "failed";
  sessionId?: string;
  brief?: string;
  totalTokens: number;
}

export interface TeamRunState {
  runId: string;
  sessionId?: string;
  teamId: string;
  teamName: string;
  task: string;
  leaderStyle: string;
  integration: string;
  leaderBody: string;
  integrateBody: string;
  /** Loop pipeline (pi-agent-loop protocol): stage names in order. */
  pipeline: string[];
  stageExperts: Record<string, string>;
  goal?: string;
  rounds: number;
  maxRounds: number;
  phase: "planning" | "executing" | "integrating" | "done" | "failed";
  plan: TeamPlan | null;
  rawPlan?: string;
  members: TeamMemberState[];
  integratedText?: string;
  totalTokens: number;
  budgetTokens?: number;
  budgetWarned: boolean;
  startedAt: number;
}

export interface TeamRunnerDeps {
  getLogger(): { app(scope: string, level: string, message: string, data?: unknown): void };
  getDriver(): {
    start(request: {
      sessionId?: string;
      newSession?: {
        title?: string;
        projectPath?: string;
        modelId?: string;
        thinkingLevel?: string;
      };
      prompt: string;
      personaPrompt?: string;
      timeoutMs?: number;
    }): Promise<{
      sessionId: string;
      completion: Promise<{
        sessionId: string;
        status: "completed" | "aborted" | "error";
        finalText: string;
        usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
      }>;
    }>;
  } | null;
  getOneShotProvider(): Promise<{
    provider: RuntimeProviderConfig;
    thinkingLevel: ThinkingLevel;
  } | null>;
  resolveTeam(teamId: string): Promise<{
    name: string;
    description: string;
    members: string[];
    leaderStyle: string;
    integration: string;
    pipeline?: string;
    stageExperts?: string;
    goal?: string;
    rounds?: number;
    maxRounds?: number;
    budgetTokens?: number;
    body: string;
  } | null>;
  resolvePersona(id: string): Promise<{
    name: string;
    personaPrompt: string;
    model?: string;
    thinkingLevel?: string;
    skills?: string[];
  } | null>;
  broadcast(event: ExpertTeamProgress): void;
  postSessionCard(sessionId: string, message: {
    id: string;
    role: "assistant";
    content: string;
    createdAt: string;
    status: "complete";
    kind?: string;
  }): Promise<void>;
  getProjectPath(sessionId?: string): Promise<string | undefined>;
  /** Foreground polish: create the REAL session a team run streams into. */
  createSession(input: {
    title: string;
    projectPath?: string;
  }): Promise<{ id: string }>;
  /** Persona bindings for foreground expert/team sessions (module 01 polish). */
  foregroundRegistry: {
    register(
      sessionId: string,
      record: { kind: "expert" | "team"; id: string; name: string; personaPrompt: string },
    ): void;
  };
}

export function extractJson(raw: string): TeamPlan | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidates = [fenced?.[1], raw];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as {
        subtasks?: Array<{ expert?: string; brief?: string; dependsOn?: number[] }>;
        riskNotes?: string;
      };
      if (!Array.isArray(parsed.subtasks) || parsed.subtasks.length === 0) continue;
      const subtasks: TeamPlanSubtask[] = parsed.subtasks
        .map((subtask) => ({
          expert: String(subtask.expert ?? "").trim(),
          brief: String(subtask.brief ?? "").trim(),
          dependsOn: Array.isArray(subtask.dependsOn)
            ? subtask.dependsOn
                .map((index) => Number(index))
                .filter((index) => Number.isInteger(index) && index >= 0)
            : [],
        }))
        .filter((subtask) => subtask.expert && subtask.brief);
      if (subtasks.length === 0) continue;
      return {
        subtasks,
        ...(parsed.riskNotes ? { riskNotes: String(parsed.riskNotes) } : {}),
      };
    } catch {
      continue;
    }
  }
  return null;
}

function clipResult(text: string, maxChars = DEP_RESULT_MAX_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length <= maxChars
    ? trimmed
    : `${trimmed.slice(0, maxChars)}\n…（截断）`;
}

/** Member results per run state (kept off the broadcast payload). */
const resultsByState = new WeakMap<TeamRunState, Map<number, string>>();

export class TeamRunner {
  private readonly deps: TeamRunnerDeps;
  private readonly states = new Map<string, TeamRunState>();

  constructor(deps: TeamRunnerDeps) {
    this.deps = deps;
  }

  getState(runId: string): TeamRunState | undefined {
    return this.states.get(runId);
  }

  private broadcast(
    state: TeamRunState,
    type: ExpertTeamProgress["type"],
    payload: Record<string, unknown> = {},
  ): void {
    this.deps.broadcast({
      runId: state.runId,
      sessionId: state.sessionId,
      type,
      payload: {
        team: state.teamName,
        phase: state.phase,
        members: state.members.map((member) => ({
          expert: member.expert,
          status: member.status,
          sessionId: member.sessionId,
          totalTokens: member.totalTokens,
        })),
        totalTokens: state.totalTokens,
        budgetTokens: state.budgetTokens,
        ...payload,
      },
    });
  }

  async invoke(request: {
    sessionId?: string;
    teamId: string;
    task: string;
  }): Promise<{ runId: string; sessionId: string }> {
    const team = await this.deps.resolveTeam(request.teamId);
    if (!team) throw new Error(`EXPERT_INVALID: unknown team "${request.teamId}"`);
    const driver = this.deps.getDriver();
    if (!driver) throw new Error("backend unavailable");

    // Foreground polish (module 01): the team run streams into a REAL session
    // the user is dropped into — project-scoped when dispatched from one.
    // Progress milestones post there; the registry keeps the moderator persona
    // for follow-up questions after the run settles.
    const projectPath = await this.deps.getProjectPath(request.sessionId);
    const session = await this.deps.createSession({
      title: `${team.name} · ${request.task.slice(0, 24)}`,
      ...(projectPath ? { projectPath } : {}),
    });
    this.deps.foregroundRegistry.register(session.id, {
      kind: "team",
      id: request.teamId,
      name: team.name,
      personaPrompt: team.body,
    });

    const sections = splitLeaderSections(team.body);
    const stageExperts: Record<string, string> = {};
    for (const pair of (team.stageExperts ?? "").split(",")) {
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const stage = pair.slice(0, eq).trim();
      const expert = pair.slice(eq + 1).trim();
      if (stage && expert) stageExperts[stage] = expert;
    }
    const state: TeamRunState = {
      runId: `team-${randomUUID()}`,
      sessionId: session.id,
      teamId: request.teamId,
      teamName: team.name,
      task: request.task,
      leaderStyle: team.leaderStyle,
      integration: team.integration,
      leaderBody: sections.plan,
      integrateBody: sections.integrate,
      pipeline: (team.pipeline ?? "")
        .split("|")
        .map((stage) => stage.trim())
        .filter(Boolean),
      stageExperts,
      ...(team.goal ? { goal: team.goal } : {}),
      rounds: team.rounds ?? 1,
      maxRounds: team.maxRounds ?? 5,
      phase: "planning",
      plan: null,
      members: [],
      totalTokens: 0,
      budgetTokens: team.budgetTokens,
      budgetWarned: false,
      startedAt: Date.now(),
    };
    this.states.set(state.runId, state);

    // Kickoff milestone in the foreground session: the user sees the team
    // accept the task with its plan instead of a silent background run.
    await this.deps
      .postSessionCard(session.id, {
        id: `team-card-${randomUUID()}`,
        role: "assistant",
        content: `【${team.name} · 已受理】\n\n${request.task}\n\n—— 成员：${team.members.join("、")}；主持人正在拆解任务。`,
        createdAt: new Date().toISOString(),
        status: "complete",
        kind: "team-card",
      })
      .catch(() => undefined);

    void this.run(state).catch((error) => {
      state.phase = "failed";
      this.broadcast(state, "failed", { error: String(error) });
      this.deps.getLogger().app("expert", "warn", "team run failed", {
        sessionId: state.sessionId,
        data: String(error),
      });
    });
    return { runId: state.runId, sessionId: session.id };
  }

  private async run(state: TeamRunState): Promise<void> {
    if (state.pipeline.length > 0) {
      // Loop pipeline mode (pi-agent-loop protocol): named stages in order,
      // each bound to one member expert; goal mode repeats a stage until the
      // expert's own [LOOP:DONE] verdict or maxRounds.
      await this.runPipeline(state);
      return;
    }
    await this.plan(state);
    // Plan milestone for the foreground session (non-pipeline mode).
    if (state.sessionId && state.members.length) {
      await this.deps
        .postSessionCard(state.sessionId, {
          id: `team-card-${randomUUID()}`,
          role: "assistant",
          content: `【${state.teamName} · 拆解完成】\n\n${state.members
            .map((member, index) => `${index + 1}. @${member.expert}：${member.brief ?? ""}`)
            .join("\n")}`,
          createdAt: new Date().toISOString(),
          status: "complete",
          kind: "team-card",
        })
        .catch(() => undefined);
    }
    await this.dispatchAll(state);
    await this.integrate(state);
  }

  /** Parse the expert's loop verdict from its final text (loop_control analog). */
  private loopVerdict(text: string): "next" | "done" {
    return /\[LOOP:DONE/i.test(text) ? "done" : "next";
  }

  private stageExpertFor(state: TeamRunState, stage: string, index: number): string | undefined {
    return (
      state.stageExperts[stage] ??
      state.members.find((member) => member.expert === stage)?.expert ??
      state.members[index]?.expert
    );
  }

  /**
   * Pipeline mode: named stages in order. Each round is an independent expert
   * session whose prompt carries the pipeline position (stage i/n, round r),
   * the stage brief and the previous stage's clipped output. Goal stages
   * repeat until the expert declares [LOOP:DONE] or maxRounds is hit — the
   * verdict protocol is the text twin of pi-agent-loop's loop_control tool.
   */
  private async runPipeline(state: TeamRunState): Promise<void> {
    state.phase = "executing";
    const resultsByState = new Map<number, string>();
    let previousSummary = "";
    let pipelineFailed = false;
    const total = state.pipeline.length;
    for (let index = 0; index < total; index += 1) {
      if (pipelineFailed) return;
      const stage = state.pipeline[index];
      const expertName = this.stageExpertFor(state, stage, index);
      if (!expertName) {
        state.phase = "failed";
          pipelineFailed = true;
        this.broadcast(state, "failed", { error: `EXPERT_INVALID: stage "${stage}" has no bound expert` });
        return;
      }
      const persona = await this.deps.resolvePersona(expertName);
      if (!persona) {
        state.phase = "failed";
          pipelineFailed = true;
        this.broadcast(state, "failed", { error: `EXPERT_INVALID: unknown expert "${expertName}"` });
        return;
      }
      // Budget gate per stage.
      if (state.budgetTokens != null && state.totalTokens >= state.budgetTokens) {
        state.phase = "failed";
          pipelineFailed = true;
        this.broadcast(state, "failed", { budget: true });
        return;
      }
      const maxRoundsForStage = state.goal ? state.maxRounds : Math.max(1, state.rounds);
      let stageOutput = "";
      let previousRoundOutput = "";
      for (let round = 1; round <= maxRoundsForStage; round += 1) {
        this.broadcast(state, "member", {
          stage: { index: index + 1, total, name: stage, round, maxRounds: maxRoundsForStage, expert: expertName },
        });
        const header = [
          `[管线阶段 ${index + 1}/${total}：${stage}${state.goal ? ` · 第 ${round}/${maxRoundsForStage} 轮` : ""}]`,
          state.goal ? `总体目标：${state.goal}` : "",
          round > 1
            ? `上一轮产出：\n${clipResult(previousRoundOutput)}\n\n这是第 ${round} 轮继续。若总体目标已达成，在回复末尾单独一行输出 [LOOP:DONE] 并给理由；否则输出 [LOOP:NEXT] 与本轮完成内容。`
            : previousSummary
              ? `上一阶段产物摘要：\n${clipResult(previousSummary)}`
              : "",
        ]
          .filter(Boolean)
          .join("\n");
        const prompt = [
          header,
          "",
          `任务（${state.teamName}）：`,
          state.task,
          "",
          "你的职责（管线阶段）：",
          state.members[index]?.brief ?? stage,
        ]
          .join("\n")
          .trim();
        const driver = this.deps.getDriver()!;
        const projectPath = await this.deps.getProjectPath(state.sessionId);
        try {
          const run = await driver.start({
            newSession: {
              title: `${state.teamName}·${stage}${maxRoundsForStage > 1 ? `·R${round}` : ""}`,
              projectPath,
              modelId: persona.model,
              thinkingLevel: persona.thinkingLevel,
            },
            prompt,
            personaPrompt: withSkillsBinding(persona.personaPrompt, persona.skills ?? []),
          });
          const result = await run.completion;
          state.totalTokens += result.usage?.totalTokens ?? 0;
          if (result.status !== "completed" || !result.finalText.trim()) {
            // A failed round is retried within the cap unless it was aborted.
            if (result.status === "aborted") {
              state.phase = "failed";
          pipelineFailed = true;
              this.broadcast(state, "failed", { error: "aborted by user", stage: { index: index + 1, name: stage } });
              return;
            }
            if (round === maxRoundsForStage) {
              state.phase = "failed";
          pipelineFailed = true;
              this.broadcast(state, "failed", { error: `stage "${stage}" failed after ${maxRoundsForStage} rounds` });
              return;
            }
            continue;
          }
          stageOutput = result.finalText;
          previousRoundOutput = stageOutput;
          if (this.loopVerdict(stageOutput) === "done" || !state.goal) break;
          if (round === maxRoundsForStage) {
            // Goal cap reached without convergence: never deliver silently.
            state.phase = "failed";
            pipelineFailed = true;
            this.broadcast(state, "failed", {
              error: `goal not converged after ${maxRoundsForStage} rounds`,
              stage: { index: index + 1, name: stage },
            });
            return;
          }
        } catch (error) {
          state.phase = "failed";
          pipelineFailed = true;
          this.broadcast(state, "failed", { error: String(error) });
          this.deps.getLogger().app("expert", "warn", "pipeline stage failed", {
            data: { stage, error: String(error) },
          });
          return;
        }
      }
      resultsByState.set(index, stageOutput);
      previousSummary = stageOutput;
      // Stage milestone in the foreground session (skip the last stage: its
      // output is the delivery posted by the completion card below).
      if (index < total - 1 && state.sessionId) {
        await this.deps
          .postSessionCard(state.sessionId, {
            id: `team-card-${randomUUID()}`,
            role: "assistant",
            content: `【${state.teamName} · 阶段完成 ${index + 1}/${total}：${stage}】\n\n${clipResult(stageOutput, 1200)}\n\n—— 下一阶段：${state.pipeline[index + 1]}`,
            createdAt: new Date().toISOString(),
            status: "complete",
            kind: "team-card",
          })
          .catch(() => undefined);
      }
    }
    // Last stage's output is the delivery; integration runs only when the
    // team explicitly defines merge instructions beyond the pipeline.
    state.integratedText = resultsByState.get(total - 1) ?? "";
    state.phase = "done";
    this.broadcast(state, "integrated", {
      integrated: state.integratedText.slice(0, 2000),
      durationMs: Date.now() - state.startedAt,
      pipeline: true,
    });
    if (state.sessionId) {
      await this.deps
        .postSessionCard(state.sessionId, {
          id: `team-card-${randomUUID()}`,
          role: "assistant",
          content: `【${state.teamName} · 管线交付完成】\n\n${state.integratedText}\n\n—— 管线：${state.pipeline.join(" → ")}；成员：${state.members
            .map((member) => `${member.expert}(${member.status === "done" ? "✓" : "×"}${memberTokenTag(member.totalTokens)})`)
            .join("、")}；消耗 ${state.totalTokens} tokens`,
          createdAt: new Date().toISOString(),
          status: "complete",
          kind: "team-card",
        })
        .catch((error) =>
          this.deps.getLogger().app("expert", "warn", "post team card failed", {
            data: String(error),
          }),
        );
    }
  }

  /** Leader planning; parse failure degrades to whole-task member dispatch. */
  private async plan(state: TeamRunState): Promise<void> {
    const oneShot = await this.deps.getOneShotProvider();
    if (!oneShot) throw new Error("model not configured");
    const members = state.plan
      ? state.plan.subtasks.map((subtask) => subtask.expert)
      : (await this.deps.resolveTeam(state.teamId))?.members ?? [];
    const planningContext = {
      systemPrompt: `你是「${state.teamName}」的团长（编排角色）。\n${state.leaderBody}`,
      messages: [
        {
          role: "user" as const,
          content: `任务：${state.task}\n\n可用成员（只能指派这些专家）：${members.join("、")}\n拆解粒度：${state.leaderStyle === "coarse" ? "粗放（尽量合并子任务）" : "精细（按职责拆到可独立执行）"}\n\n编排规则：若任务单一、一名成员即可完成，直接拆为单成员直通计划（快速模式），不必凑齐多名成员。`,
          timestamp: Date.now(),
        },
      ],
    };
    const planResult = await completeOneShot(
      oneShot.provider,
      planningContext,
      oneShot.thinkingLevel,
      { sessionId: state.runId },
    );
    const plan = extractJson(planResult.text);
    if (plan) {
      state.plan = plan;
      state.members = plan.subtasks.map((subtask) => ({
        expert: subtask.expert,
        status: "pending",
        brief: subtask.brief,
        totalTokens: 0,
      }));
    } else {
      state.rawPlan = planResult.text.slice(0, 1200);
      state.members = members.map((expert) => ({
        expert,
        status: "pending",
        brief: state.task,
        totalTokens: 0,
      }));
    }
    this.broadcast(state, "plan", {
      plan: state.plan,
      ...(state.rawPlan ? { rawPlan: state.rawPlan } : {}),
    });
  }

  private subtasksOf(state: TeamRunState): TeamPlanSubtask[] {
    return (
      state.plan?.subtasks ??
      state.members.map((member) => ({
        expert: member.expert,
        brief: member.brief ?? state.task,
        dependsOn: [],
      }))
    );
  }

  /** Dispatch every pending subtask (topological + parallel gate ≤4). */
  private async dispatchAll(state: TeamRunState): Promise<void> {
    state.phase = "executing";
    const subtasks = this.subtasksOf(state);
    const completed = new Map<number, string>();
    resultsByState.set(state, completed);
    const dispatched = new Set<number>();

    const ready = (): number[] =>
      subtasks
        .map((_, index) => index)
        .filter(
          (index) =>
            !dispatched.has(index) &&
            (subtasks[index]?.dependsOn ?? []).every((dep) => completed.has(dep)),
        );

    const workers = new Set<Promise<void>>();
    for (;;) {
      while (workers.size < MAX_PARALLEL_MEMBERS) {
        const next = ready()[0];
        if (next === undefined) break;
        dispatched.add(next);
        const worker = this.dispatchMember(state, subtasks, next, completed).finally(
          () => {
            workers.delete(worker);
          },
        );
        workers.add(worker);
      }
      if (workers.size === 0) break;
      await Promise.race(workers);
    }
  }

  private memberResult(state: TeamRunState, index: number): string | undefined {
    return resultsByState.get(state)?.get(index);
  }

  /** Run one member on an independent expert session. */
  private async dispatchMember(
    state: TeamRunState,
    subtasks: TeamPlanSubtask[],
    index: number,
    completed: Map<number, string>,
  ): Promise<void> {
    const subtask = subtasks[index];
    const member = state.members[index];
    if (!subtask || !member) return;
    // Budget gate: a depleted pool fails not-yet-started members fast.
    if (state.budgetTokens != null && state.totalTokens >= state.budgetTokens) {
      member.status = "failed";
      this.broadcast(state, "member", { index, status: "failed", budget: true });
      return;
    }
    member.status = "running";
    this.broadcast(state, "dispatch", { index });

    const depContext = subtask.dependsOn
      .map((depIndex) => {
        const depResult = completed.get(depIndex);
        return depResult
          ? `【成员「${subtasks[depIndex]?.expert ?? depIndex}」的产出】\n${clipResult(depResult)}`
          : undefined;
      })
      .filter(Boolean)
      .join("\n\n");
    const prompt = [
      `团队任务（${state.teamName}）：`,
      state.task,
      "",
      "你的职责（团长分配）：",
      subtask.brief,
      depContext ? `\n上游成员产出（供你参考，不必重复其工作）：\n${depContext}` : "",
      "",
      `团队预算 ${state.budgetTokens ?? 200000} tokens，请控制篇幅，直接产出你职责内的成果。`,
    ]
      .join("\n")
      .trim();

    const persona = await this.deps.resolvePersona(subtask.expert);
    if (!persona) {
      member.status = "failed";
      this.broadcast(state, "member", { index, status: "failed", error: "unknown expert" });
      return;
    }
    const projectPath = await this.deps.getProjectPath(state.sessionId);
    try {
      const driver = this.deps.getDriver()!;
      const run = await driver.start({
        newSession: {
          title: `${state.teamName}·${persona.name}`,
          projectPath,
          modelId: persona.model,
          thinkingLevel: persona.thinkingLevel,
        },
        prompt,
        personaPrompt: withSkillsBinding(persona.personaPrompt, persona.skills ?? []),
      });
      member.sessionId = run.sessionId;
      this.broadcast(state, "member", { index, status: "running", memberSessionId: run.sessionId });
      const result = await run.completion;
      member.totalTokens = result.usage?.totalTokens ?? 0;
      state.totalTokens += member.totalTokens;
      if (result.status === "completed" && result.finalText.trim()) {
        member.status = "done";
        const results = resultsByState.get(state) ?? new Map<number, string>();
        results.set(index, result.finalText);
        completed.set(index, result.finalText);
      } else {
        member.status = "failed";
      }
    } catch (error) {
      member.status = "failed";
      this.deps.getLogger().app("expert", "warn", "member dispatch failed", {
        data: { expert: subtask.expert, error: String(error) },
      });
    }
    this.broadcast(state, "member", { index, status: member.status });

    if (
      !state.budgetWarned &&
      state.budgetTokens != null &&
      state.totalTokens >= state.budgetTokens * BUDGET_WARNING_RATIO
    ) {
      state.budgetWarned = true;
      this.broadcast(state, "dispatch", { budgetWarning: true });
    }
  }

  /** Integration is an explicit one-shot call — not a prompt约定 (ADR-E4). */
  private async integrate(state: TeamRunState): Promise<void> {
    state.phase = "integrating";
    this.broadcast(state, "dispatch", { phase: state.phase });
    const subtasks = this.subtasksOf(state);
    const memberDigest = state.members
      .map((member, index) => {
        const result = this.memberResult(state, index);
        return `【${member.expert}｜${member.status === "done" ? "已完成" : "失败"}】\n${
          result ? clipResult(result) : "（该成员未产出成果，整合时请说明缺口）"
        }`;
      })
      .join("\n\n");
    void subtasks;

    const oneShot = await this.deps.getOneShotProvider();
    let integratedText: string;
    if (!oneShot) {
      integratedText = `${memberDigest}\n\n（整合步骤不可用：模型未配置）`;
    } else {
      const integrationContext = {
        systemPrompt: `你是「${state.teamName}」的团长，负责最终整合交付。\n${state.integrateBody}`,
        messages: [
          {
            role: "user" as const,
            content: `原始任务：${state.task}\n\n各成员成果：\n${memberDigest}\n\n交付要求：\n1. 以主持人身份收尾，简述各成员的开工与收尾（用 @成员名 提及）。\n2. 文末固定输出「用户下一步建议」段：给出 3-5 条用户拿到交付物后可以立即执行的后续动作。`,
            timestamp: Date.now(),
          },
        ],
      };
      try {
        const integration = await completeOneShot(
          oneShot.provider,
          integrationContext,
          oneShot.thinkingLevel,
          { sessionId: state.runId },
        );
        integratedText = integration.text;
      } catch (error) {
        this.deps.getLogger().app("expert", "warn", "team integration failed", {
          data: String(error),
        });
        integratedText = `${memberDigest}\n\n（整合步骤失败：${String(error)}）`;
      }
    }

    state.integratedText = integratedText;
    state.phase = "done";
    this.broadcast(state, "integrated", {
      integrated: integratedText.slice(0, 2000),
      durationMs: Date.now() - state.startedAt,
    });

    if (state.sessionId) {
      await this.deps
        .postSessionCard(state.sessionId, {
          id: `team-card-${randomUUID()}`,
          role: "assistant",
          content: `【${state.teamName} · 交付完成】\n\n${integratedText}\n\n—— 成员：${state.members
            .map((member) => `${member.expert}(${member.status === "done" ? "✓" : "×"}${memberTokenTag(member.totalTokens)})`)
            .join("、")}；消耗 ${state.totalTokens} tokens`,
          createdAt: new Date().toISOString(),
          status: "complete",
          kind: "team-card",
        })
        .catch((error) =>
          this.deps.getLogger().app("expert", "warn", "post team card failed", {
            data: String(error),
          }),
        );
    }
  }

  /** Retry one failed member on a fresh expert session, then re-integrate. */
  async retryMember(request: { runId: string; index: number }): Promise<boolean> {
    const state = this.states.get(request.runId);
    if (!state) return false;
    const subtasks = this.subtasksOf(state);
    const subtask = subtasks[request.index];
    const member = state.members[request.index];
    if (!subtask || !member) return false;
    member.status = "pending";
    const completed = new Map<number, string>();
    state.members.forEach((entry, index) => {
      if (index !== request.index && entry.status === "done") {
        completed.set(index, this.memberResult(state, index) ?? "");
      }
    });
    this.broadcast(state, "dispatch", { phase: state.phase, retry: request.index });
    void this.dispatchMember(state, subtasks, request.index, completed)
      .then(() => this.integrate(state))
      .catch((error) => {
        this.deps.getLogger().app("expert", "warn", "member retry failed", {
          data: String(error),
        });
      });
    return true;
  }
}

function splitLeaderSections(body: string): { plan: string; integrate: string } {
  const planMatch = /【拆解指令】([\s\S]*?)(?=【整合指令】|$)/.exec(body);
  const integrateMatch = /【整合指令】([\s\S]*?)(?=【拆解指令】|$)/.exec(body);
  return {
    plan: planMatch?.[1]?.trim() || body.trim(),
    integrate: integrateMatch?.[1]?.trim() || body.trim(),
  };
}
