/**
 * FR-KB-05: multi-retrieval-service routing. Knowledge bases ARE MCP servers
 * (ADR-KB2), so with several deployed the agent needs a routing contract, not
 * a second registry: the session prompt names the retrieval services it can
 * see and tells the agent to pick by name (the PRD's "Agent 按名称路由"
 * variant — per-tool approval still goes through the existing MCP gate).
 *
 * Pure logic lives here; session-launch feeds it the `mcp.active` records it
 * already fetched, so the clause never widens what the session can call.
 */

/** Loose view of an active MCP record (host rows may carry org extras). */
export interface KbRoutingRecord {
  id: string;
  label: string;
  description?: string;
  enabled?: boolean;
  source?: string;
  orgId?: string;
}

export interface KbRoutingServer {
  id: string;
  label: string;
  description: string;
}

/** A retrieval service is the fork's own registration: `kb-` prefixed ids
 * cover org-delivered KB servers and personal ones from the KB path alike.
 * Org source alone is too broad — org expert packs register other MCP ids. */
export function kbRetrievalServers(records: readonly KbRoutingRecord[]): KbRoutingServer[] {
  return records
    .filter((record) => record.id.startsWith("kb-"))
    .map((record) => ({
      id: record.id,
      label: record.label,
      description: (record.description ?? "").trim(),
    }));
}

/** With zero or one service the agent already sees everything; the clause
 * exists to disambiguate several. */
export function buildKbRoutingClause(servers: readonly KbRoutingServer[]): string | undefined {
  if (servers.length < 2) return undefined;
  const listed = servers
    .map((server) => `- ${server.label}${server.description ? `：${server.description}` : ""}`)
    .join("\n");
  return [
    "## 知识库检索路由（多服务并存）",
    "本会话可用的知识库检索服务：",
    listed,
    "- 任务指明使用某个知识库（按名称）时，优先选用该服务的检索工具，不要用其它服务替代。",
    "- 任务未指明时，按任务语义选择最相关的一个服务检索；不要并行轰炸全部服务。",
    "- 检索工具的调用沿用既有 MCP 工具审批与权限模式。",
  ].join("\n");
}

/** Session-launch seam: records in, clauses out (undefined when unneeded). */
export function kbToolGuidanceClauses(records: readonly KbRoutingRecord[]): string[] {
  const clause = buildKbRoutingClause(kbRetrievalServers(records));
  return clause ? [clause] : [];
}
