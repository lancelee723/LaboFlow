/**
 * LaboFlow module 01 (T51.5): resolve a leading `@专家名` (or `@团队名`)
 * against the expert and team registries (fetched at most once per TTL).
 * Expert names win over same-named teams. Returns null when the prompt is not
 * an agent mention — including when the name is unknown — so a regular prompt
 * that merely starts with "@" still reaches the agent untouched.
 * FR-E-17 adds `matchExpertMentionChain`, which recognises a serial
 * multi-expert dispatch (`@A 做X，然后 @B 做Y`) and returns the ordered steps.
 */
import { api, type ExpertListItem, type ExpertTeamListItem } from "../lib/api";

const EXPERT_MENTION_CACHE_TTL_MS = 60_000;
let expertMentionCache: {
  experts: Map<string, string>;
  teams: Map<string, string>;
  fetchedAt: number;
} | null = null;

export interface ExpertMentionMatch {
  /** Which registry resolved the mention: an independent expert or a team run. */
  kind: "expert" | "team";
  id: string;
  name: string;
  task: string;
}

export async function matchExpertMention(
  content: string,
): Promise<ExpertMentionMatch | null> {
  const match = /^@(\S+)\s*([\s\S]*)$/.exec(content);
  if (!match) return null;
  const name = match[1];
  const task = match[2].trim();
  if (!task) return null;
  const registries = await resolveRegistries();
  if (!registries) return null;
  const expertId = registries.experts.get(name);
  if (expertId) return { kind: "expert", id: expertId, name, task };
  const teamId = registries.teams.get(name);
  if (!teamId) return null;
  return { kind: "team", id: teamId, name, task };
}

/**
 * FR-E-17: parse a serial multi-expert dispatch — `@A 做X，然后 @B 做Y`.
 *
 * Segments split on the sequencing separators a user actually types between
 * two assignments ("然后/接着", English "then", `；`/`;`, or a newline);
 * order in the text is the execution order. Every segment must resolve to an
 * ENABLED EXPERT: a team (it orchestrates its own members already), an
 * unknown name, or an empty task makes the whole prompt not a chain, and the
 * caller falls back to the single-mention path unchanged.
 */
export async function matchExpertMentionChain(
  content: string,
): Promise<ExpertMentionMatch[] | null> {
  const segments = content
    .split(/[,，;；]?\s*(?:然后|接着|之后再|then)\s*/i)
    .flatMap((segment) => segment.split(/\n+/))
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length < 2) return null;
  const parsed: Array<{ name: string; task: string }> = [];
  for (const segment of segments) {
    const match = /^@(\S+)\s*([\s\S]*)$/.exec(segment);
    if (!match) return null;
    const task = match[2].trim();
    if (!task) return null;
    parsed.push({ name: match[1], task });
  }
  const registries = await resolveRegistries();
  if (!registries) return null;
  const steps: ExpertMentionMatch[] = [];
  for (const { name, task } of parsed) {
    const expertId = registries.experts.get(name);
    // A team or unknown name in the middle of a chain is not a chain.
    if (!expertId) return null;
    steps.push({ kind: "expert", id: expertId, name, task });
  }
  return steps;
}

async function resolveRegistries(): Promise<{
  experts: Map<string, string>;
  teams: Map<string, string>;
} | null> {
  const now = Date.now();
  if (
    !expertMentionCache ||
    now - expertMentionCache.fetchedAt > EXPERT_MENTION_CACHE_TTL_MS
  ) {
    let experts: ExpertListItem[];
    try {
      experts = await api.listExperts();
    } catch {
      // Expert center unavailable: treat the prompt as plain text.
      return null;
    }
    let teams: ExpertTeamListItem[] = [];
    try {
      teams = await api.listExpertTeams();
    } catch {
      // Teams are an optional second registry; experts still resolve.
    }
    const expertsByName = new Map<string, string>();
    for (const expert of experts) {
      // A disabled expert must not hijack prompts addressed to its name.
      if (expert.enabled !== false) expertsByName.set(expert.name, expert.id);
    }
    const teamsByName = new Map<string, string>();
    for (const team of teams) {
      if (team.enabled !== false) teamsByName.set(team.name, team.id);
    }
    expertMentionCache = {
      experts: expertsByName,
      teams: teamsByName,
      fetchedAt: now,
    };
  }
  return expertMentionCache;
}

/** Test hook: drop the cached @专家 list so the next mention re-resolves. */
export function resetExpertMentionCacheForTests(): void {
  expertMentionCache = null;
}
