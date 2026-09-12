/**
 * ExpertService (module 01, plans T51.2/T51.5; foreground polish 2026-09).
 *
 * Experts are independent agents: invoking one creates a REAL conversation
 * session (project-scoped when dispatched from one) and runs the first turn
 * on it through the HeadlessAgentDriver — never a subagent spawn. The turn
 * streams into the session like any chat, and the persona binding is
 * registered with ForegroundSessionRegistry so later user turns keep the
 * expert persona. Preset experts (`builtin-experts.ts`) merge with the
 * user's `~/.agents/experts` documents at list time; a personal document
 * with the same name shadows the preset.
 */

import {
  BUILTIN_EXPERT_DOCUMENTS,
  BUILTIN_TEAM_DOCUMENTS,
} from "./builtin-experts";
import type { ForegroundSessionRegistry } from "./expert-foreground";
import type {
  ExpertInvocation,
  ExpertTeamProgress,
} from "@pi-desktop/shared";

const HOST_RPC_TIMEOUT_MS = 30 * 60 * 1000;

export interface ExpertListItem {
  id: string;
  name: string;
  description: string;
  industry?: string;
  tags: string[];
  examples: string[];
  skills: string[];
  mcpServers: string[];
  model?: string;
  thinkingLevel?: string;
  enabled: boolean;
  source: "preset" | "user" | "org";
}

export interface ExpertTeamListItem {
  id: string;
  name: string;
  description: string;
  members: string[];
  leaderStyle: string;
  integration: string;
  budgetTokens?: number;
  enabled: boolean;
  source: "preset" | "user" | "org";
}

export interface ExpertDriver {
  start(request: {
    sessionId?: string;
    newSession?: {
      title?: string;
      projectPath?: string;
      providerId?: string;
      modelId?: string;
      thinkingLevel?: string;
    };
    prompt: string;
    personaPrompt?: string;
    timeoutMs?: number;
  }): Promise<{
    sessionId: string;
    turnId: string;
    completion: Promise<{
      sessionId: string;
      status: "completed" | "aborted" | "error";
      finalText: string;
      usage?: { totalTokens: number };
    }>;
  }>;
}

export interface ExpertServiceDeps {
  getHost(): {
    call<T = unknown>(method: string, params?: unknown): Promise<T>;
  } | null;
  getLogger(): {
    app(scope: string, level: string, message: string, data?: unknown): void;
  };
  getDriver(): ExpertDriver | null;
  broadcast(event: ExpertTeamProgress): void;
  /** Post a card message into a session transcript (completion cards). */
  postSessionCard(sessionId: string, message: {
    id: string;
    role: "assistant";
    content: string;
    createdAt: string;
    status: "complete";
    kind?: string;
  }): Promise<void>;
  /** Persona bindings for foreground expert/team sessions (module 01 polish). */
  foregroundRegistry: ForegroundSessionRegistry;
}

interface HostExpertRecord {
  id: string;
  name: string;
  description: string;
  industry?: string;
  tags?: string[];
  examples?: string[];
  skills?: string[];
  mcpServers?: string[];
  model?: string;
  thinkingLevel?: string;
  enabled: boolean;
}

interface PresetFrontMatter {
  industry?: string;
  tags?: string[];
  examples?: string[];
  skills?: string[];
  mcpServers?: string[];
  model?: string;
  thinkingLevel?: string;
}

function parsePresetDocument(
  document: string,
): { description: string; body: string; front: PresetFrontMatter } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(document);
  const front: PresetFrontMatter = {};
  let description = "";
  if (match) {
    for (const line of match[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      if (key === "description") {
        description = value;
      } else if (key === "industry") {
        front.industry = value;
      } else if (key === "tags" || key === "examples" || key === "skills" || key === "mcpservers") {
        const list = value
          .replace(/^\[|\]$/g, "")
          .split(key === "examples" ? "|" : ",")
          .map((item) => item.trim())
          .filter(Boolean);
        if (key === "tags") front.tags = list;
        else if (key === "examples") front.examples = list;
        else if (key === "skills") front.skills = list;
        else front.mcpServers = list;
      } else if (key === "model") {
        front.model = value;
      } else if (key === "thinkinglevel") {
        front.thinkingLevel = value;
      }
    }
  }
  const body = (match ? match[2] : document).trim();
  if (!description) description = body.split("\n")[0]?.slice(0, 120) ?? "";
  return { description, body, front };
}

export interface OrgExpertPack {
  kind: "expert" | "team";
  name: string;
  payload: Record<string, unknown>;
  version: number;
}

export class ExpertService {
  private readonly deps: ExpertServiceDeps;
  private orgPacks: OrgExpertPack[] = [];

  constructor(deps: ExpertServiceDeps) {
    this.deps = deps;
  }

  /** Persona prompt for a foreground expert/team session (agentPrompt hook). */
  foregroundPersona(sessionId: string): string | undefined {
    return this.deps.foregroundRegistry.lookup(sessionId);
  }

  /** Org delivery (T51.8): packs ride the bootstrap cache — in-memory only,
   * so a personal expert with the same name keeps local priority (FR-E-19). */
  setOrgPacks(packs: OrgExpertPack[]): void {
    this.orgPacks = Array.isArray(packs) ? packs : [];
  }

  private host() {
    const host = this.deps.getHost();
    if (!host) throw new Error("backend unavailable");
    return host;
  }

  private logger() {
    return this.deps.getLogger();
  }

  async list(): Promise<ExpertListItem[]> {
    const host = this.host();
    const { experts } = await host.call<{ experts: HostExpertRecord[] }>(
      "experts.list",
    );
    const userNames = new Set(experts.map((expert) => expert.name));
    const presets: ExpertListItem[] = BUILTIN_PRESETS.filter(
      (preset) => !userNames.has(preset.name),
    ).map((preset) => ({
      id: preset.name,
      name: preset.name,
      description: preset.description,
      industry: preset.industry,
      tags: preset.tags,
      examples: preset.examples,
      skills: preset.skills,
      mcpServers: preset.mcpServers,
      model: preset.model,
      thinkingLevel: preset.thinkingLevel,
      enabled: true,
      source: "preset",
    }));
    const userItems: ExpertListItem[] = experts.map((expert) => ({
      id: expert.id,
      name: expert.name,
      description: expert.description,
      industry: expert.industry,
      tags: expert.tags ?? [],
      examples: expert.examples ?? [],
      skills: expert.skills ?? [],
      mcpServers: expert.mcpServers ?? [],
      model: expert.model,
      thinkingLevel: expert.thinkingLevel,
      enabled: expert.enabled,
      source: "user",
    }));
    const taken = new Set([...presets, ...userItems].map((item) => item.name));
    const orgItems: ExpertListItem[] = this.orgPacks
      .filter((pack) => pack.kind === "expert" && !taken.has(pack.name))
      .map((pack) => ({
        id: pack.name,
        name: pack.name,
        description: String(pack.payload.description ?? ""),
        industry: pack.payload.industry as string | undefined,
        tags: (pack.payload.tags as string[] | undefined) ?? [],
        examples: (pack.payload.examples as string[] | undefined) ?? [],
        skills: (pack.payload.skills as string[] | undefined) ?? [],
        mcpServers: (pack.payload.mcpServers as string[] | undefined) ?? [],
        model: pack.payload.model as string | undefined,
        thinkingLevel: pack.payload.thinkingLevel as string | undefined,
        enabled: true,
        source: "org",
      }));
    return [...presets, ...userItems, ...orgItems];
  }

  async get(id: string): Promise<{ expert: ExpertListItem | null; body: string | null }> {
    const user = await this.host()
      .call<{ expert: HostExpertRecord | null; body: string | null }>(
        "experts.read",
        { id },
      )
      .catch(() => ({ expert: null, body: null }));
    if (user.expert) {
      const expert = user.expert;
      return {
        expert: {
          id: expert.id,
          name: expert.name,
          description: expert.description,
          industry: expert.industry,
          tags: expert.tags ?? [],
          examples: expert.examples ?? [],
          skills: expert.skills ?? [],
          mcpServers: expert.mcpServers ?? [],
          model: expert.model,
          thinkingLevel: expert.thinkingLevel,
          enabled: expert.enabled,
          source: "user",
        },
        body: user.body,
      };
    }
    const orgPack = this.orgPacks.find(
      (pack) => pack.kind === "expert" && pack.name === id,
    );
    if (orgPack) {
      const payload = orgPack.payload;
      const body = String(payload.body ?? "");
      if (body.trim()) {
        return {
          expert: {
            id: orgPack.name,
            name: orgPack.name,
            description: String(payload.description ?? ""),
            industry: payload.industry as string | undefined,
            tags: (payload.tags as string[] | undefined) ?? [],
            examples: (payload.examples as string[] | undefined) ?? [],
            skills: (payload.skills as string[] | undefined) ?? [],
            mcpServers: (payload.mcpServers as string[] | undefined) ?? [],
            model: payload.model as string | undefined,
            thinkingLevel: payload.thinkingLevel as string | undefined,
            enabled: true,
            source: "org",
          },
          body,
        };
      }
    }
    const preset = BUILTIN_PRESETS.find((item) => item.name === id);
    if (!preset) return { expert: null, body: null };
    return {
      expert: {
        id: preset.name,
        name: preset.name,
        description: preset.description,
        industry: preset.industry,
        tags: preset.tags,
        examples: preset.examples,
        skills: preset.skills,
        mcpServers: preset.mcpServers,
        model: preset.model,
        thinkingLevel: preset.thinkingLevel,
        enabled: true,
        source: "preset",
      },
      body: preset.body,
    };
  }

  async save(input: Record<string, unknown>): Promise<ExpertListItem> {
    const host = this.host();
    const name = String(input.name ?? "").trim();
    if (!name) throw new Error("EXPERT_INVALID: name is required");
    const existing = await host.call<{ experts: HostExpertRecord[] }>(
      "experts.list",
    );
    const isUpdate = existing.experts.some(
      (expert) => expert.name === name,
    );
    const payload = {
      name,
      description: String(input.description ?? "").trim(),
      industry: input.industry,
      tags: input.tags,
      examples: input.examples,
      skills: input.skills,
      mcpServers: input.mcpServers,
      model: input.model,
      thinkingLevel: input.thinkingLevel,
      body: input.body,
    };
    const result = isUpdate
      ? await host.call<{ expert: HostExpertRecord }>("experts.update", {
          id: name,
          expert: payload,
        })
      : await host.call<{ expert: HostExpertRecord }>("experts.create", {
          expert: payload,
        });
    const expert = result.expert;
    return {
      id: expert.id,
      name: expert.name,
      description: expert.description,
      industry: expert.industry,
      tags: expert.tags ?? [],
      examples: expert.examples ?? [],
      skills: expert.skills ?? [],
      mcpServers: expert.mcpServers ?? [],
      model: expert.model,
      thinkingLevel: expert.thinkingLevel,
      enabled: expert.enabled,
      source: "user",
    };
  }

  async delete(id: string): Promise<boolean> {
    return this.host().call<boolean>("experts.remove", { id });
  }

  async toggle(id: string, enabled: boolean): Promise<boolean> {
    await this.host().call("experts.setEnabled", { id, enabled });
    return true;
  }

  async listTeams(): Promise<ExpertTeamListItem[]> {
    const host = this.host();
    const { teams } = await host.call<{
      teams: Array<HostExpertRecord & {
        members?: string[];
        leaderStyle?: string;
        integration?: string;
        budgetTokens?: number;
      }>;
    }>("expertTeams.list");
    const userNames = new Set(teams.map((team) => team.name));
    const presets: ExpertTeamListItem[] = BUILTIN_TEAMS.filter(
      (team) => !userNames.has(team.name),
    ).map((team) => ({
      id: team.name,
      name: team.name,
      description: team.description,
      members: team.members,
      leaderStyle: team.leaderStyle,
      integration: team.integration,
      budgetTokens: team.budgetTokens,
      enabled: true,
      source: "preset",
    }));
    const userItems: ExpertTeamListItem[] = teams.map((team) => ({
      id: team.id,
      name: team.name,
      description: team.description,
      members: team.members ?? [],
      leaderStyle: team.leaderStyle ?? "fine",
      integration: team.integration ?? "moderator",
      budgetTokens: team.budgetTokens,
      enabled: team.enabled,
      source: "user",
    }));
    const takenTeams = new Set([...presets, ...userItems].map((item) => item.name));
    const orgTeamItems: ExpertTeamListItem[] = this.orgPacks
      .filter((pack) => pack.kind === "team" && !takenTeams.has(pack.name))
      .map((pack) => ({
        id: pack.name,
        name: pack.name,
        description: String(pack.payload.description ?? ""),
        members: (pack.payload.members as string[] | undefined) ?? [],
        leaderStyle: (pack.payload.leaderStyle as string | undefined) ?? "fine",
        integration: (pack.payload.integration as string | undefined) ?? "moderator",
        budgetTokens: pack.payload.budgetTokens as number | undefined,
        enabled: true,
        source: "org" as const,
      }));
    return [...presets, ...userItems, ...orgTeamItems];
  }

  /** Resolve an expert's persona (user document first, preset fallback). */
  async resolvePersona(id: string): Promise<{
    name: string;
    personaPrompt: string;
    model?: string;
    thinkingLevel?: string;
    skills: string[];
    mcpServers: string[];
  } | null> {
    const resolved = await this.get(id);
    if (!resolved.expert || resolved.body == null) return null;
    return {
      name: resolved.expert.name,
      personaPrompt: resolved.body,
      model: resolved.expert.model,
      thinkingLevel: resolved.expert.thinkingLevel,
      skills: resolved.expert.skills,
      mcpServers: resolved.expert.mcpServers,
    };
  }

  /**
   * @专家指派 (FR-E-16, foreground polish): create a REAL conversation session
   * (project-scoped when dispatched from one), run the first turn on it via
   * the durable driver — streaming into the transcript like any chat — and
   * register the persona so later turns in that session keep being the
   * expert. No completion card is posted anywhere; the session IS the result.
   */
  async invoke(request: ExpertInvocation): Promise<{ sessionId: string }> {
    const driver = this.deps.getDriver();
    if (!driver) throw new Error("backend unavailable");
    const persona = await this.resolvePersona(request.expertId);
    if (!persona) throw new Error(`EXPERT_INVALID: unknown expert "${request.expertId}"`);

    let projectPath: string | undefined;
    if (request.sessionId) {
      const parent = await this.host()
        .call<{ session?: { projectPath?: string } }>("session.get", {
          id: request.sessionId,
        })
        .catch(() => undefined);
      projectPath = parent?.session?.projectPath;
    }

    const created = await this.host().call<{
      session?: { id?: string };
    }>("session.create", {
      title: `${persona.name} · ${request.task.slice(0, 24)}`,
      mode: "agent",
      ...(projectPath ? { projectPath } : {}),
      ...(persona.model ? { modelId: persona.model } : {}),
      ...(persona.thinkingLevel ? { thinkingLevel: persona.thinkingLevel } : {}),
    });
    const sessionId = String(created.session?.id ?? "").trim();
    if (!sessionId) throw new Error("session.create returned no session");
    this.deps.foregroundRegistry.register(sessionId, {
      kind: "expert",
      id: request.expertId,
      name: persona.name,
      personaPrompt: persona.personaPrompt,
    });

    const run = await driver.start({
      sessionId,
      prompt: request.task,
      personaPrompt: persona.personaPrompt,
      timeoutMs: HOST_RPC_TIMEOUT_MS,
    });

    void run.completion
      .then(async (result) => {
        this.deps.broadcast({
          runId: run.sessionId,
          sessionId,
          type: "member",
          payload: {
            expert: persona.name,
            status: result.status,
            totalTokens: result.usage?.totalTokens ?? 0,
          },
        });
      })
      .catch((error) => {
        this.logger().app("expert", "warn", "expert invoke failed", {
          sessionId,
          data: String(error),
        });
        this.deps.broadcast({
          runId: run.sessionId,
          sessionId,
          type: "member",
          payload: { expert: persona.name, status: "error" },
        });
      });

    this.deps.broadcast({
      runId: run.sessionId,
      sessionId,
      type: "member",
      payload: { expert: persona.name, status: "running" },
    });
    return { sessionId };
  }
}

const BUILTIN_PRESETS = BUILTIN_EXPERT_DOCUMENTS.map((preset) => {
  const parsed = parsePresetDocument(preset.document);
  return {
    name: preset.name,
    industry: preset.industry,
    description: parsed.description,
    body: parsed.body,
    tags: parsed.front.tags ?? [],
    examples: parsed.front.examples ?? [],
    skills: parsed.front.skills ?? [],
    mcpServers: parsed.front.mcpServers ?? [],
    model: parsed.front.model,
    thinkingLevel: parsed.front.thinkingLevel,
  };
});

const BUILTIN_TEAMS = BUILTIN_TEAM_DOCUMENTS.map((team) => {
  const parsed = parsePresetDocument(team.document);
  const members = /members:\s*\[([^\]]*)\]/.exec(team.document)?.[1]
    ?.split(",")
    .map((member) => member.trim())
    .filter(Boolean) ?? [];
  return {
    name: team.name,
    description: parsed.description,
    body: parsed.body,
    members,
    leaderStyle: /leaderStyle:\s*(\w+)/.exec(team.document)?.[1] ?? "fine",
    integration: /integration:\s*(\w+)/.exec(team.document)?.[1] ?? "moderator",
    budgetTokens: undefined as number | undefined,
  };
});
