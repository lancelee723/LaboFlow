/**
 * Phase 4 shared-workspace client: live WS stream per shared session plus the
 * REST passthrough the workspace page needs. The stream owns incremental sync
 * (pull-on-open, live frames, seq tracking) and the round-lock heartbeat; the
 * renderer only consumes normalized frames.
 *
 * Frames to renderer: { sessionId, type, seq?, entry?, userId?, mine?, reason? }
 *   - "entry.appended" — transcript content (initial pull replays as these)
 *   - "lock.acquired" / "lock.released" — round-lock state (mine annotated)
 */

export type WsFrame = {
  sessionId: string;
  type: string;
  seq?: number;
  entry?: { kind?: string; text?: string } & Record<string, unknown>;
  userId?: string;
  mine?: boolean;
  reason?: string;
};

export type OrgWorkspaceDeps = {
  /** Authenticated GET (org bearer) → parsed JSON. */
  getJson: (path: string) => Promise<unknown>;
  /** Authenticated POST (org bearer) → parsed JSON. */
  postJson: (path: string, body: unknown) => Promise<unknown>;
  /** Current session's access token (WS auth query param). */
  getToken: () => Promise<string | null>;
  /** Current org user id — annotates lock frames with `mine`. */
  getUserId: () => Promise<string | undefined>;
  /** Current org server origin (http(s) → upgraded to ws(s)). */
  getServerUrl: () => Promise<string | undefined>;
  /** Frame sink (renderer-facing). */
  emit: (frame: WsFrame) => void;
  /** Injectable socket constructor (tests). */
  webSocketFactory?: (url: string) => WsLike;
};

export type WsLike = {
  send: (data: string) => void;
  close: () => void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
};

const HEARTBEAT_MS = 10_000;
const RECONNECT_MAX_MS = 15_000;

export class OrgWorkspaceHub {
  private streams = new Map<
    string,
    {
      wid: string;
      sid: string;
      ws: WsLike;
      closed: boolean;
      heartbeat?: ReturnType<typeof setInterval>;
      reconnectTimer?: ReturnType<typeof setTimeout>;
    }
  >();
  private lastSeqBySid = new Map<string, number>();
  private reconnectDelay = 1_000;

  constructor(private readonly deps: OrgWorkspaceDeps) {}

  async connect(wid: string, sid: string): Promise<void> {
    if (this.streams.has(sid)) return;
    const token = await this.deps.getToken();
    if (!token) throw new Error("ORG_NOT_CONNECTED");
    const userId = await this.deps.getUserId();
    const serverUrl = await this.deps.getServerUrl();
    if (!serverUrl) throw new Error("ORG_NOT_CONNECTED");
    const wsBase = serverUrl.replace(/^http/, "ws").replace(/\/+$/, "");
    const url = `${wsBase}/ws/${wid}/${sid}?token=${encodeURIComponent(token)}&userId=${encodeURIComponent(userId ?? "")}`;
    const ws = this.deps.webSocketFactory
      ? this.deps.webSocketFactory(url)
      : new WebSocket(url);
    const state = {
      wid,
      sid,
      ws: ws as WsLike,
      closed: false,
      heartbeat: undefined as ReturnType<typeof setInterval> | undefined,
      reconnectTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    };
    this.streams.set(sid, state);

    ws.onopen = () => {
      this.reconnectDelay = 1_000;
      // Initial incremental pull (first connect: everything), then live frames.
      void this.pullSince(wid, sid);
      state.heartbeat = setInterval(() => {
        try {
          ws.send(JSON.stringify({ type: "heartbeat" }));
        } catch {
          /* socket closing */
        }
      }, HEARTBEAT_MS);
    };
    ws.onmessage = (ev: { data: string }) => {
      try {
        const frame = JSON.parse(String(ev.data)) as {
          type?: string;
          seq?: number;
          entry?: WsFrame["entry"];
          userId?: string;
          reason?: string;
        };
        if (frame.type === "entry.appended" && typeof frame.seq === "number") {
          this.lastSeqBySid.set(
            sid,
            Math.max(this.lastSeqBySid.get(sid) ?? 0, frame.seq),
          );
        }
        this.deps.emit({
          sessionId: sid,
          type: frame.type ?? "unknown",
          seq: frame.seq,
          entry: frame.entry,
          userId: frame.userId,
          mine: Boolean(userId && frame.userId && frame.userId === userId),
          reason: frame.reason,
        });
      } catch {
        /* malformed frame — ignore */
      }
    };
    ws.onclose = () => {
      if (state.heartbeat) clearInterval(state.heartbeat);
      if (state.closed) return;
      // Auto-reconnect with capped backoff; pull fills the gap on reopen.
      state.reconnectTimer = setTimeout(() => {
        this.streams.delete(sid);
        void this.connect(wid, sid).catch(() => undefined);
      }, this.reconnectDelay);
      this.reconnectDelay = Math.min(RECONNECT_MAX_MS, this.reconnectDelay * 2);
    };
    ws.onerror = () => undefined; // onclose follows
  }

  private async pullSince(wid: string, sid: string): Promise<void> {
    const since = this.lastSeqBySid.get(sid) ?? -1;
    const rows = (await this.deps.getJson(
      `/workspaces/${wid}/sessions/${sid}/entries?since=${since}`,
    )) as Array<{ seq: number; entry: WsFrame["entry"] }>;
    for (const row of rows) {
      this.lastSeqBySid.set(sid, Math.max(this.lastSeqBySid.get(sid) ?? 0, row.seq));
      this.deps.emit({
        sessionId: sid,
        type: "entry.appended",
        seq: row.seq,
        entry: row.entry,
      });
    }
  }

  disconnect(sid: string): void {
    const state = this.streams.get(sid);
    if (!state) return;
    state.closed = true;
    if (state.heartbeat) clearInterval(state.heartbeat);
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    try {
      state.ws.close();
    } catch {
      /* already closing */
    }
    this.streams.delete(sid);
  }

  disconnectAll(): void {
    for (const sid of [...this.streams.keys()]) this.disconnect(sid);
  }

  /** Round speech: append an entry (server enforces lock + seq continuity). */
  async say(
    wid: string,
    sid: string,
    text: string,
    extra?: Record<string, unknown>,
  ): Promise<{ seq: number }> {
    const result = (await this.deps.postJson(
      `/workspaces/${wid}/sessions/${sid}/entries`,
      { entry: { kind: "say", text, ...(extra ?? {}) } },
    )) as { seq: number };
    this.lastSeqBySid.set(sid, Math.max(this.lastSeqBySid.get(sid) ?? 0, result.seq));
    return result;
  }
}
