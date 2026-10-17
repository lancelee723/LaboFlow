/**
 * Module 02 team spaces — REST client + IPC host (T52.4-11, SPEC §3.5).
 *
 * SpaceClient is a thin typed passthrough over the org server's
 * `/spaces/...` route family (the routes mirror apps/server/src/app.controller.ts).
 * All requests run with the current logged-in user's org bearer — the server
 * permission matrix is the only judge (SPEC ADR-TC2); this client never
 * decides permissions locally.
 *
 * createSpaceIpcHost wires the client to the `pi-desktop/space/*` IPC
 * namespace and runs the per-space event poll loop (the server exposes
 * `GET /spaces/:id/events?since=` as the same cursor the future WS hub uses;
 * polling is the degraded but compatible transport). Frames go to the
 * renderer via `emit` → IPC.event.spaceEvent, orgWsFrame-style.
 *
 * Runtime imports stay limited to node builtins + `@pi-desktop/shared` so
 * plain-node tests can load this file directly.
 */

import { IPC } from "@pi-desktop/shared";

import type {
  RevisionDecideResult,
  RevisionSuggestion,
  SpaceAnchor,
  SpaceComment,
  SpaceDoc,
  SpaceDto,
  SpaceEventFrame,
  SpaceEventPayload,
  SpaceNode,
} from "@pi-desktop/shared";

export interface SpaceClientDeps {
  /** Authenticated GET (org bearer) → parsed JSON. */
  getJson(path: string): Promise<unknown>;
  /** Authenticated POST (org bearer) → parsed JSON. */
  postJson(path: string, body: unknown): Promise<unknown>;
  /** Authenticated PATCH (org bearer) → parsed JSON. */
  patchJson(path: string, body: unknown): Promise<unknown>;
  /** Authenticated PUT (org bearer) → parsed JSON. */
  putJson(path: string, body: unknown): Promise<unknown>;
  /** Authenticated DELETE (org bearer) → parsed JSON. */
  deleteJson(path: string): Promise<unknown>;
}

/** Normalized REST failure surfaced to the renderer as a readable toast. */
export class SpaceClientError extends Error {
  readonly code?: string;
  readonly status?: number;

  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.name = "SpaceClientError";
    this.code = code;
    this.status = status;
  }
}

const FRIENDLY: Record<string, string> = {
  ORG_NOT_CONNECTED: "尚未连接 LaboFlow 组织服务器",
  ORG_EXPIRED: "组织登录已过期，请重新登录",
  EVERSION: "版本冲突：文档已被他人更新，请刷新后再保存",
  EANCHOR: "锚定原文已变化，无法应用该建议",
  ENOENT: "内容不存在或无权访问",
  EFORBIDDEN: "权限不足",
};

/** Best-effort normalization: keep the machine code + readable message. */
export function normalizeSpaceError(error: unknown): SpaceClientError {
  if (error instanceof SpaceClientError) return error;
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes("ORG_NOT_CONNECTED")) {
    return new SpaceClientError(FRIENDLY.ORG_NOT_CONNECTED!, "ORG_NOT_CONNECTED");
  }
  if (raw.includes("ORG_EXPIRED")) {
    return new SpaceClientError(FRIENDLY.ORG_EXPIRED!, "ORG_EXPIRED");
  }
  const tagged = error as { code?: unknown; status?: unknown; message?: unknown };
  const code = typeof tagged.code === "string" ? tagged.code : undefined;
  const status = typeof tagged.status === "number" ? tagged.status : undefined;
  const message =
    typeof tagged.message === "string" && tagged.message && !tagged.message.startsWith("ORG_API_FAILED")
      ? tagged.message
      : code && FRIENDLY[code]
        ? FRIENDLY[code]
        : raw.replace(/^ORG_API_FAILED:\s*/, "") || "空间服务请求失败";
  return new SpaceClientError(message, code, status);
}

export function createSpaceClient(deps: SpaceClientDeps) {
  const id = (value: string) => encodeURIComponent(value);
  return {
    listSpaces(): Promise<SpaceDto[]> {
      return deps.getJson("/spaces") as Promise<SpaceDto[]>;
    },
    createSpace(input: { name: string; description?: string; teamId?: string }): Promise<{ id: string }> {
      return deps.postJson("/spaces", input) as Promise<{ id: string }>;
    },
    tree(spaceId: string): Promise<SpaceNode[]> {
      return deps.getJson(`/spaces/${id(spaceId)}/tree`) as Promise<SpaceNode[]>;
    },
    createNode(
      spaceId: string,
      input: { parentId?: string | null; type: string; name: string; sortKey?: number },
    ): Promise<SpaceNode> {
      return deps.postJson(`/spaces/${id(spaceId)}/nodes`, input) as Promise<SpaceNode>;
    },
    renameNode(spaceId: string, nodeId: string, name: string): Promise<SpaceNode> {
      return deps.patchJson(`/spaces/${id(spaceId)}/nodes/${id(nodeId)}`, { name }) as Promise<SpaceNode>;
    },
    moveNode(spaceId: string, nodeId: string, parentId: string | null): Promise<SpaceNode> {
      return deps.patchJson(`/spaces/${id(spaceId)}/nodes/${id(nodeId)}`, { parentId }) as Promise<SpaceNode>;
    },
    deleteNode(spaceId: string, nodeId: string): Promise<{ ok: true }> {
      return deps.deleteJson(`/spaces/${id(spaceId)}/nodes/${id(nodeId)}`) as Promise<{ ok: true }>;
    },
    restoreNode(spaceId: string, nodeId: string): Promise<SpaceNode> {
      return deps.postJson(`/spaces/${id(spaceId)}/nodes/${id(nodeId)}/restore`, {}) as Promise<SpaceNode>;
    },
    getDoc(spaceId: string, nodeId: string, version?: number): Promise<SpaceDoc> {
      const query = version === undefined ? "" : `?version=${version}`;
      return deps.getJson(`/spaces/${id(spaceId)}/nodes/${id(nodeId)}/doc${query}`) as Promise<SpaceDoc>;
    },
    saveDoc(
      spaceId: string,
      nodeId: string,
      input: { content: string; baseVersion: number; source?: string },
    ): Promise<{ nodeId: string; version: number; sha256: string; source?: string; seq?: number }> {
      return deps.putJson(`/spaces/${id(spaceId)}/nodes/${id(nodeId)}/doc`, input) as Promise<{
        nodeId: string;
        version: number;
        sha256: string;
        source?: string;
        seq?: number;
      }>;
    },
    uploadFile(
      spaceId: string,
      input: { nodeId?: string; parentId?: string | null; name?: string; contentBase64: string },
    ): Promise<{ nodeId: string; name: string; versionNo: number; size: number; sha256: string }> {
      return deps.postJson(`/spaces/${id(spaceId)}/files`, input) as Promise<{
        nodeId: string;
        name: string;
        versionNo: number;
        size: number;
        sha256: string;
      }>;
    },
    listMembers(spaceId: string): Promise<Array<{ userId: string; username: string; displayName: string | null; perm: string }>> {
      return deps.getJson(`/spaces/${id(spaceId)}/members`) as Promise<
        Array<{ userId: string; username: string; displayName: string | null; perm: string }>
      >;
    },
    addMember(spaceId: string, input: { userId: string; perm: string }): Promise<{ ok: true }> {
      return deps.postJson(`/spaces/${id(spaceId)}/members`, input) as Promise<{ ok: true }>;
    },
    updateMember(spaceId: string, userId: string, input: { perm: string }): Promise<{ ok: true }> {
      return deps.patchJson(`/spaces/${id(spaceId)}/members/${id(userId)}`, input) as Promise<{ ok: true }>;
    },
    removeMember(spaceId: string, userId: string): Promise<{ ok: true }> {
      return deps.deleteJson(`/spaces/${id(spaceId)}/members/${id(userId)}`) as Promise<{ ok: true }>;
    },
    createInvite(
      spaceId: string,
      input: { perm?: string; expiresInDays?: number; maxUses?: number | null },
    ): Promise<Record<string, unknown>> {
      return deps.postJson(`/spaces/${id(spaceId)}/invites`, input) as Promise<Record<string, unknown>>;
    },
    search(spaceId: string, query: string, limit?: number): Promise<Array<Record<string, unknown>>> {
      const params = new URLSearchParams({ q: query });
      if (limit !== undefined) params.set("limit", String(limit));
      return deps.getJson(`/spaces/${id(spaceId)}/search?${params.toString()}`) as Promise<
        Array<Record<string, unknown>>
      >;
    },
    listFileVersions(spaceId: string, nodeId: string): Promise<Array<Record<string, unknown>>> {
      return deps.getJson(`/spaces/${id(spaceId)}/files/${id(nodeId)}/versions`) as Promise<
        Array<Record<string, unknown>>
      >;
    },
    downloadFile(
      spaceId: string,
      nodeId: string,
      version?: number,
    ): Promise<{ name: string; contentBase64: string; sha256: string; versionNo: number } | null> {
      const query = version === undefined ? "" : `?version=${version}`;
      return deps.getJson(`/spaces/${id(spaceId)}/files/${id(nodeId)}/download${query}`) as Promise<{
        name: string;
        contentBase64: string;
        sha256: string;
        versionNo: number;
      } | null>;
    },
    listComments(spaceId: string, nodeId: string): Promise<SpaceComment[]> {
      return deps.getJson(`/spaces/${id(spaceId)}/nodes/${id(nodeId)}/comments`) as Promise<SpaceComment[]>;
    },
    createComment(
      spaceId: string,
      nodeId: string,
      input: { body: string; anchor?: SpaceAnchor | null },
    ): Promise<SpaceComment> {
      return deps.postJson(`/spaces/${id(spaceId)}/nodes/${id(nodeId)}/comments`, input) as Promise<SpaceComment>;
    },
    replyComment(
      spaceId: string,
      nodeId: string,
      commentId: string,
      body: string,
    ): Promise<SpaceComment> {
      return deps.postJson(
        `/spaces/${id(spaceId)}/nodes/${id(nodeId)}/comments/${id(commentId)}/reply`,
        { body },
      ) as Promise<SpaceComment>;
    },
    resolveComment(
      spaceId: string,
      nodeId: string,
      commentId: string,
      status: "open" | "resolved",
    ): Promise<SpaceComment> {
      return deps.postJson(
        `/spaces/${id(spaceId)}/nodes/${id(nodeId)}/comments/${id(commentId)}/resolve`,
        { status },
      ) as Promise<SpaceComment>;
    },
    listRevisions(spaceId: string, nodeId: string): Promise<RevisionSuggestion[]> {
      return deps.getJson(`/spaces/${id(spaceId)}/nodes/${id(nodeId)}/revisions`) as Promise<RevisionSuggestion[]>;
    },
    createRevision(
      spaceId: string,
      nodeId: string,
      input: {
        anchor?: SpaceAnchor | null;
        originalText: string;
        revisedText: string;
        rationale?: string;
        producedBy?: "user" | "agent";
        model?: string;
      },
    ): Promise<RevisionSuggestion> {
      return deps.postJson(`/spaces/${id(spaceId)}/nodes/${id(nodeId)}/revisions`, input) as Promise<RevisionSuggestion>;
    },
    decideRevision(
      spaceId: string,
      nodeId: string,
      suggestionId: string,
      decision: "accepted" | "rejected",
    ): Promise<RevisionDecideResult> {
      return deps.postJson(
        `/spaces/${id(spaceId)}/nodes/${id(nodeId)}/revisions/${id(suggestionId)}/decide`,
        { decision },
      ) as Promise<RevisionDecideResult>;
    },
    /**
     * 按评论修订 (SPEC §3.3 reviewByComments): aggregate all open comments →
     * batch of pending suggestions. NOTE: the route shape is mirrored from
     * the SPEC literally (`POST …/revisions/reviewByComments`); if the server
     * slice names it differently only this method needs to change.
     */
    async reviewByComments(spaceId: string, nodeId: string): Promise<RevisionSuggestion[]> {
      const body = (await deps.postJson(
        `/spaces/${id(spaceId)}/nodes/${id(nodeId)}/revisions/reviewByComments`,
        {},
      )) as unknown;
      if (Array.isArray(body)) return body as RevisionSuggestion[];
      const suggestions = (body as { suggestions?: unknown })?.suggestions;
      return Array.isArray(suggestions) ? (suggestions as RevisionSuggestion[]) : [];
    },
    pullEvents(spaceId: string, since: number): Promise<{ events: SpaceEventPayload[]; lastSeq: number }> {
      return deps.getJson(`/spaces/${id(spaceId)}/events?since=${since}`) as Promise<{
        events: SpaceEventPayload[];
        lastSeq: number;
      }>;
    },
  };
}

export type SpaceClient = ReturnType<typeof createSpaceClient>;

export interface SpaceIpcHostDeps {
  client: SpaceClient;
  /** Frame sink for IPC.event.spaceEvent (main wires sendToRenderer). */
  emit(frame: SpaceEventFrame): void;
  /** Poll interval for the events cursor; default 4s. */
  pollMs?: number;
  /** Optional warn sink (main logger). */
  warn?(context: string, message: string): void;
  /**
   * FR-TC-10 production: the LLM-backed review-by-comments pipeline lives in
   * the main process (it needs the session model); when supplied it replaces
   * the legacy passthrough that assumed a server route.
   */
  reviewByComments?(
    spaceId: string,
    nodeId: string,
  ): Promise<RevisionSuggestion[]>;
  /** FR-TC-12: one-shot in-place rewrite of one selection (main-side model). */
  rewriteSelection?(input: {
    text: string;
    instruction?: string;
    before?: string;
    after?: string;
  }): Promise<{ text: string }>;
}

export interface SpaceIpcHost {
  client: SpaceClient;
  /**
   * Register all `space/*` handlers. Pass index.ts's `handle(channel, fn)`
   * wrapper so handlers go through the standard error envelope.
   */
  registerIpc(handle: (channel: string, fn: (...args: any[]) => Promise<any>) => void): void;
  /** Stop every poll loop (app shutdown). */
  stopAll(): void;
}

interface EventPoller {
  timer?: ReturnType<typeof setInterval>;
  /** null until the initial pull anchors the cursor at the live tip. */
  cursor: number | null;
  inFlight: boolean;
  stopped: boolean;
}

export function createSpaceIpcHost(deps: SpaceIpcHostDeps): SpaceIpcHost {
  const client = deps.client;
  const pollMs = deps.pollMs ?? 4_000;
  const pollers = new Map<string, EventPoller>();

  const stopPoller = (spaceId: string): void => {
    const poller = pollers.get(spaceId);
    if (!poller) return;
    poller.stopped = true;
    if (poller.timer) clearInterval(poller.timer);
    pollers.delete(spaceId);
  };

  const pollOnce = async (spaceId: string, poller: EventPoller): Promise<void> => {
    if (poller.inFlight || poller.stopped) return;
    poller.inFlight = true;
    try {
      const since = poller.cursor ?? -1;
      const result = await client.pullEvents(spaceId, since);
      if (poller.cursor === null) {
        // First pull anchors the cursor at the live tip WITHOUT replaying
        // history — the renderer loads the current tree/doc itself when it
        // opens a space (mirror of the orgWs since semantics).
        poller.cursor = Math.max(0, Number(result.lastSeq ?? 0));
        return;
      }
      poller.cursor = Math.max(poller.cursor, Number(result.lastSeq ?? since));
      for (const event of result.events ?? []) {
        if (Number(event.seq) <= since) continue; // capped 200 backfill guard
        poller.cursor = Math.max(poller.cursor, Number(event.seq));
        deps.emit({
          spaceId,
          seq: Number(event.seq),
          type: String(event.type ?? "unknown"),
          payload: (event.payload ?? {}) as Record<string, unknown>,
          actorId: event.actorId ?? null,
          createdAt: event.createdAt,
        });
      }
    } catch (error) {
      // Poll failures are expected while offline/org-expired — warn quietly
      // and keep the loop; the renderer shows the degraded banner on its own
      // invoke failures.
      deps.warn?.("space", `events poll failed: ${String(error)}`);
    } finally {
      poller.inFlight = false;
    }
  };

  const subscribe = async (spaceId: string): Promise<{ ok: true }> => {
    if (pollers.has(spaceId)) return { ok: true };
    const poller: EventPoller = { cursor: null, inFlight: false, stopped: false };
    pollers.set(spaceId, poller);
    await pollOnce(spaceId, poller); // anchor the cursor at the live tip
    if (poller.stopped) return { ok: true };
    poller.timer = setInterval(() => void pollOnce(spaceId, poller), pollMs);
    return { ok: true };
  };

  const wrap = <T>(fn: () => Promise<T>): Promise<T> =>
    fn().catch((error: unknown) => {
      throw normalizeSpaceError(error);
    });

  return {
    client,
    registerIpc(handle) {
      handle(IPC.invoke.spaceList, async () => wrap(() => client.listSpaces()));
      handle(
        IPC.invoke.spaceCreate,
        async (input: { name?: string; description?: string; teamId?: string }) =>
          wrap(() =>
            client.createSpace({
              name: String(input?.name ?? ""),
              ...(input?.description !== undefined ? { description: String(input.description) } : {}),
              ...(input?.teamId !== undefined ? { teamId: String(input.teamId) } : {}),
            }),
          ),
      );
      handle(IPC.invoke.spaceTree, async (input: { spaceId?: string }) =>
        wrap(() => client.tree(String(input?.spaceId ?? ""))),
      );
      handle(
        IPC.invoke.spaceNodeCreate,
        async (input: {
          spaceId?: string;
          parentId?: string | null;
          type?: string;
          name?: string;
          sortKey?: number;
        }) =>
          wrap(() =>
            client.createNode(String(input?.spaceId ?? ""), {
              parentId: input?.parentId ?? null,
              type: String(input?.type ?? ""),
              name: String(input?.name ?? ""),
              ...(typeof input?.sortKey === "number" ? { sortKey: input.sortKey } : {}),
            }),
          ),
      );
      handle(
        IPC.invoke.spaceNodeRename,
        async (input: { spaceId?: string; nodeId?: string; name?: string }) =>
          wrap(() =>
            client.renameNode(String(input?.spaceId ?? ""), String(input?.nodeId ?? ""), String(input?.name ?? "")),
          ),
      );
      handle(
        IPC.invoke.spaceNodeMove,
        async (input: { spaceId?: string; nodeId?: string; parentId?: string | null }) =>
          wrap(() =>
            client.moveNode(
              String(input?.spaceId ?? ""),
              String(input?.nodeId ?? ""),
              input?.parentId ?? null,
            ),
          ),
      );
      handle(IPC.invoke.spaceNodeDelete, async (input: { spaceId?: string; nodeId?: string }) =>
        wrap(() => client.deleteNode(String(input?.spaceId ?? ""), String(input?.nodeId ?? ""))),
      );
      handle(IPC.invoke.spaceNodeRestore, async (input: { spaceId?: string; nodeId?: string }) =>
        wrap(() => client.restoreNode(String(input?.spaceId ?? ""), String(input?.nodeId ?? ""))),
      );
      handle(
        IPC.invoke.spaceFileUpload,
        async (input: {
          spaceId?: string;
          nodeId?: string;
          parentId?: string | null;
          name?: string;
          contentBase64?: string;
        }) =>
          wrap(() =>
            client.uploadFile(String(input?.spaceId ?? ""), {
              ...(typeof input?.nodeId === "string" && input.nodeId ? { nodeId: input.nodeId } : {}),
              parentId: input?.parentId ?? null,
              name: input?.name,
              contentBase64: String(input?.contentBase64 ?? ""),
            }),
          ),
      );
      handle(
        IPC.invoke.spaceSearch,
        async (input: { spaceId?: string; query?: string; limit?: number }) =>
          wrap(() =>
            client.search(
              String(input?.spaceId ?? ""),
              String(input?.query ?? ""),
              typeof input?.limit === "number" ? input.limit : undefined,
            ),
          ),
      );
      handle(
        IPC.invoke.spaceFileVersions,
        async (input: { spaceId?: string; nodeId?: string }) =>
          wrap(() =>
            client.listFileVersions(String(input?.spaceId ?? ""), String(input?.nodeId ?? "")),
          ),
      );
      handle(
        IPC.invoke.spaceFileDownload,
        async (input: { spaceId?: string; nodeId?: string; version?: number }) =>
          wrap(() =>
            client.downloadFile(
              String(input?.spaceId ?? ""),
              String(input?.nodeId ?? ""),
              typeof input?.version === "number" ? input.version : undefined,
            ),
          ),
      );
      handle(
        IPC.invoke.spaceDocGet,
        async (input: { spaceId?: string; nodeId?: string; version?: number }) =>
          wrap(() =>
            client.getDoc(
              String(input?.spaceId ?? ""),
              String(input?.nodeId ?? ""),
              typeof input?.version === "number" ? input.version : undefined,
            ),
          ),
      );
      handle(
        IPC.invoke.spaceDocSave,
        async (input: {
          spaceId?: string;
          nodeId?: string;
          content?: string;
          baseVersion?: number;
          source?: string;
        }) =>
          wrap(() =>
            client.saveDoc(String(input?.spaceId ?? ""), String(input?.nodeId ?? ""), {
              content: String(input?.content ?? ""),
              baseVersion: Number(input?.baseVersion ?? 0),
              ...(input?.source !== undefined ? { source: String(input.source) } : {}),
            }),
          ),
      );
      handle(IPC.invoke.spaceCommentsList, async (input: { spaceId?: string; nodeId?: string }) =>
        wrap(() => client.listComments(String(input?.spaceId ?? ""), String(input?.nodeId ?? ""))),
      );
      handle(
        IPC.invoke.spaceCommentsCreate,
        async (input: { spaceId?: string; nodeId?: string; body?: string; anchor?: SpaceAnchor | null }) =>
          wrap(() =>
            client.createComment(String(input?.spaceId ?? ""), String(input?.nodeId ?? ""), {
              body: String(input?.body ?? ""),
              anchor: input?.anchor ?? null,
            }),
          ),
      );
      handle(
        IPC.invoke.spaceCommentsReply,
        async (input: { spaceId?: string; nodeId?: string; commentId?: string; body?: string }) =>
          wrap(() =>
            client.replyComment(
              String(input?.spaceId ?? ""),
              String(input?.nodeId ?? ""),
              String(input?.commentId ?? ""),
              String(input?.body ?? ""),
            ),
          ),
      );
      handle(
        IPC.invoke.spaceCommentsResolve,
        async (input: { spaceId?: string; nodeId?: string; commentId?: string; status?: string }) =>
          wrap(() =>
            client.resolveComment(
              String(input?.spaceId ?? ""),
              String(input?.nodeId ?? ""),
              String(input?.commentId ?? ""),
              input?.status === "open" ? "open" : "resolved",
            ),
          ),
      );
      handle(IPC.invoke.spaceRevisionsList, async (input: { spaceId?: string; nodeId?: string }) =>
        wrap(() => client.listRevisions(String(input?.spaceId ?? ""), String(input?.nodeId ?? ""))),
      );
      handle(
        IPC.invoke.spaceRevisionsCreate,
        async (input: {
          spaceId?: string;
          nodeId?: string;
          anchor?: SpaceAnchor | null;
          originalText?: string;
          revisedText?: string;
          rationale?: string;
          producedBy?: string;
          model?: string;
        }) =>
          wrap(() =>
            client.createRevision(String(input?.spaceId ?? ""), String(input?.nodeId ?? ""), {
              anchor: input?.anchor ?? null,
              originalText: String(input?.originalText ?? ""),
              revisedText: String(input?.revisedText ?? ""),
              ...(input?.rationale !== undefined ? { rationale: String(input.rationale) } : {}),
              ...(input?.producedBy === "agent" ? { producedBy: "agent" as const } : { producedBy: "user" as const }),
              ...(input?.model !== undefined ? { model: String(input.model) } : {}),
            }),
          ),
      );
      handle(
        IPC.invoke.spaceRevisionsDecide,
        async (input: {
          spaceId?: string;
          nodeId?: string;
          suggestionId?: string;
          decision?: string;
        }) =>
          wrap(() =>
            client.decideRevision(
              String(input?.spaceId ?? ""),
              String(input?.nodeId ?? ""),
              String(input?.suggestionId ?? ""),
              input?.decision === "rejected" ? "rejected" : "accepted",
            ),
          ),
      );
      handle(
        IPC.invoke.spaceRevisionsReviewByComments,
        async (input: { spaceId?: string; nodeId?: string }) =>
          wrap(() => {
            const spaceId = String(input?.spaceId ?? "");
            const nodeId = String(input?.nodeId ?? "");
            if (deps.reviewByComments) return deps.reviewByComments(spaceId, nodeId);
            return client.reviewByComments(spaceId, nodeId);
          }),
      );
      handle(
        IPC.invoke.spaceRewriteSelection,
        async (input: {
          text?: string;
          instruction?: string;
          before?: string;
          after?: string;
        }) =>
          wrap(() => {
            if (!deps.rewriteSelection) {
              throw Object.assign(new Error("rewrite unavailable"), {
                errorCode: "NOT_SUPPORTED",
              });
            }
            return deps.rewriteSelection({
              text: String(input?.text ?? ""),
              instruction: input?.instruction ? String(input.instruction) : undefined,
              before: input?.before ? String(input.before) : undefined,
              after: input?.after ? String(input.after) : undefined,
            });
          }),
      );
      handle(IPC.invoke.spaceEventsPull, async (input: { spaceId?: string; since?: number }) =>
        wrap(() => client.pullEvents(String(input?.spaceId ?? ""), Number(input?.since ?? -1))),
      );
      handle(IPC.invoke.spaceEventsSubscribe, async (input: { spaceId?: string }) =>
        subscribe(String(input?.spaceId ?? "")),
      );
      handle(IPC.invoke.spaceEventsUnsubscribe, async (input: { spaceId?: string }) => {
        stopPoller(String(input?.spaceId ?? ""));
        return { ok: true };
      });
    },
    stopAll() {
      for (const spaceId of [...pollers.keys()]) stopPoller(spaceId);
    },
  };
}
