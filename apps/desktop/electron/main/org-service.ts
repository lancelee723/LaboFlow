/**
 * Org session client (PRD 4.1.12, FR-S-01) — talks to the LaboFlow Server
 * auth/org API and keeps sessions in the host secret store. Phase 3 upgrade:
 * multiple org sessions (one per server+user) with a "current" pointer, so
 * the settings page can mirror the model-provider pattern (list + set
 * current). Secrets never cross back to the renderer; the renderer only sees
 * the mapped OrgStatus profile.
 */

import type { OrgBootstrap, OrgStatus } from "@pi-desktop/shared";

export const ORG_SECRET_REF = "org/session";

export type OrgHostDeps = {
  call: <T>(method: string, params?: unknown) => Promise<T>;
};

export type OrgFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type StoredSession = {
  serverUrl: string;
  username: string;
  accessToken: string;
  refreshToken?: string;
  mustChangePassword?: boolean;
  displayName?: string;
  role?: string;
  orgName?: string;
};

export type OrgBook = {
  sessions: StoredSession[];
  current: string | null;
};

export function orgSessionKey(entry: {
  serverUrl: string;
  username: string;
}): string {
  return `${entry.serverUrl}|${entry.username}`;
}

export class OrgService {
  private readonly fetchImpl: OrgFetch;
  private lastBootstrap: OrgBootstrap | null = null;

  constructor(
    private readonly deps: OrgHostDeps,
    fetchImpl?: OrgFetch,
  ) {
    this.fetchImpl =
      fetchImpl ?? ((url, init) => fetch(url, init));
  }

  /** Raw bootstrap payload from the most recent successful status refresh. */
  getBootstrap(): OrgBootstrap | null {
    return this.lastBootstrap;
  }

  private async readBook(): Promise<OrgBook> {
    const { value } = await this.deps.call<{ value?: string | null }>(
      "secrets.getForRuntime",
      { secretRef: ORG_SECRET_REF },
    );
    if (!value) return { sessions: [], current: null };
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return { sessions: [], current: null };
    }
    // Legacy Phase 2 shape: a single bare session object.
    if (parsed && typeof parsed === "object" && "accessToken" in parsed) {
      const legacy = parsed as StoredSession;
      return {
        sessions: [legacy],
        current: orgSessionKey(legacy),
      };
    }
    const book = parsed as Partial<OrgBook>;
    return {
      sessions: Array.isArray(book.sessions) ? book.sessions : [],
      current: typeof book.current === "string" ? book.current : null,
    };
  }

  private async writeBook(book: OrgBook): Promise<void> {
    await this.deps.call("secrets.set", {
      secretRef: ORG_SECRET_REF,
      value: JSON.stringify(book),
    });
  }

  private async currentSession(): Promise<StoredSession | null> {
    const book = await this.readBook();
    return (
      book.sessions.find((entry) => orgSessionKey(entry) === book.current) ??
      book.sessions[0] ??
      null
    );
  }

  private async api(
    session: StoredSession,
    path: string,
    init?: RequestInit,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const response = await this.fetchImpl(`${session.serverUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.accessToken}`,
        ...(init?.headers ?? {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body };
  }

  async login(input: {
    serverUrl: string;
    username: string;
    password: string;
  }): Promise<OrgStatus> {
    const serverUrl = normalizeServerUrl(input.serverUrl);
    const username = input.username.trim();
    if (!username) throw new Error("ORG_USERNAME_REQUIRED");
    if (!input.password) throw new Error("ORG_PASSWORD_REQUIRED");

    let response: Response;
    try {
      response = await this.fetchImpl(`${serverUrl}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username,
          password: input.password,
        }),
      });
    } catch (error) {
      throw new Error(
        `ORG_UNREACHABLE: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status === 401) throw new Error("ORG_BAD_CREDENTIALS");
    if (!response.ok) throw new Error(`ORG_LOGIN_FAILED: HTTP ${response.status}`);
    const body = (await response.json().catch(() => ({}))) as {
      tokens?: { accessToken?: string; refreshToken?: string } | null;
      mustChangePassword?: boolean;
      user?: { displayName?: string; role?: string };
    };
    const accessToken = body.tokens?.accessToken;
    if (!accessToken) throw new Error("ORG_LOGIN_FAILED: no token");
    const session: StoredSession = {
      serverUrl,
      username,
      accessToken,
      refreshToken: body.tokens?.refreshToken,
      mustChangePassword: Boolean(body.mustChangePassword),
      displayName: body.user?.displayName,
      role: body.user?.role,
    };
    const book = await this.readBook();
    const key = orgSessionKey(session);
    const sessions = book.sessions.filter(
      (entry) => orgSessionKey(entry) !== key,
    );
    sessions.push(session);
    await this.writeBook({ sessions, current: key });
    return this.status();
  }

  /** Point "current" at another stored org session and revalidate it. */
  async setCurrent(key: string): Promise<OrgStatus> {
    const book = await this.readBook();
    if (!book.sessions.some((entry) => orgSessionKey(entry) === key)) {
      throw new Error("ORG_NOT_CONNECTED");
    }
    await this.writeBook({ ...book, current: key });
    this.lastBootstrap = null;
    return this.status();
  }

  async changePassword(input: {
    currentPassword: string;
    newPassword: string;
  }): Promise<OrgStatus> {
    const session = await this.currentSession();
    if (!session) throw new Error("ORG_NOT_CONNECTED");
    const { ok, status, body } = await this.api(session, "/auth/change-password", {
      method: "POST",
      body: JSON.stringify({
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
      }),
    });
    if (!ok) {
      const detail =
        (body as { message?: string; error?: string })?.message ??
        (body as { error?: string })?.error ??
        `HTTP ${status}`;
      throw new Error(`ORG_CHANGE_PASSWORD_FAILED: ${detail}`);
    }
    const nextBody = body as {
      tokens?: { accessToken?: string; refreshToken?: string };
    };
    const book = await this.readBook();
    const key = orgSessionKey(session);
    const sessions = book.sessions.map((entry) =>
      orgSessionKey(entry) === key
        ? {
            ...entry,
            accessToken: nextBody.tokens?.accessToken ?? entry.accessToken,
            refreshToken: nextBody.tokens?.refreshToken ?? entry.refreshToken,
            mustChangePassword: false,
          }
        : entry,
    );
    await this.writeBook({
      sessions,
      current: book.sessions.length ? key : null,
    });
    return this.status();
  }

  /** Sign out of the CURRENT org only; other stored orgs stay. */
  async logout(): Promise<OrgStatus> {
    const book = await this.readBook();
    const key = book.current;
    const sessions = book.sessions.filter(
      (entry) => orgSessionKey(entry) !== key,
    );
    const current = sessions.length
      ? orgSessionKey(sessions[0])
      : null;
    await this.writeBook({ sessions, current });
    this.lastBootstrap = null;
    return this.status();
  }

  async status(): Promise<OrgStatus> {
    const book = await this.readBook();
    if (!book.sessions.length) {
      return { connected: false, state: "disconnected" };
    }
    const session =
      book.sessions.find((entry) => orgSessionKey(entry) === book.current) ??
      book.sessions[0];
    const currentKey = orgSessionKey(session);
    const { ok, status, body } = await this.api(session, "/org/bootstrap");
    const orgs = book.sessions.map((entry) => ({
      key: orgSessionKey(entry),
      serverUrl: entry.serverUrl,
      username: entry.username,
      displayName: entry.displayName,
      role: entry.role,
      orgName: entry.orgName,
    }));
    if (status === 401) {
      return {
        connected: false,
        state: "expired",
        serverUrl: session.serverUrl,
        username: session.username,
        currentKey,
        orgs,
      };
    }
    if (!ok) {
      return {
        connected: false,
        state: "expired",
        serverUrl: session.serverUrl,
        username: session.username,
        currentKey,
        orgs,
        error: `ORG_STATUS_FAILED: HTTP ${status}`,
      };
    }
    const bootstrap = body as OrgBootstrap;
    this.lastBootstrap = bootstrap;
    const orgName = bootstrap.org?.name;
    // Remember the org name so the picker can label entries without a call.
    const enriched = book.sessions.map((entry) =>
      orgSessionKey(entry) === currentKey ? { ...entry, orgName } : entry,
    );
    if (enriched.some((entry, i) => entry !== book.sessions[i])) {
      await this.writeBook({ sessions: enriched, current: currentKey });
    }
    return {
      connected: true,
      state: "connected",
      serverUrl: session.serverUrl,
      username: bootstrap.me?.username ?? session.username,
      displayName: bootstrap.me?.displayName ?? session.displayName,
      role: bootstrap.me?.role ?? session.role,
      orgName: bootstrap.org?.name ?? undefined,
      teamName: bootstrap.org?.teamName ?? undefined,
      workspaceCount: Array.isArray(bootstrap.workspaces)
        ? bootstrap.workspaces.length
        : 0,
      mustChangePassword: session.mustChangePassword,
      currentKey,
      orgs: orgs.map((entry) =>
        entry.key === currentKey ? { ...entry, orgName } : entry,
      ),
    };
  }

  /**
   * Authenticated GET passthrough for org endpoints (e.g. /quota/remaining).
   * Throws ORG_EXPIRED when the stored session is no longer accepted.
   */
  async getOrgJson(path: string): Promise<unknown> {
    const session = await this.currentSession();
    if (!session) throw new Error("ORG_NOT_CONNECTED");
    const response = await this.fetchImpl(`${session.serverUrl}${path}`, {
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.accessToken}`,
      },
    });
    if (response.status === 401) throw new Error("ORG_EXPIRED");
    if (!response.ok) throw new Error(`ORG_API_FAILED: HTTP ${response.status}`);
    return response.json();
  }

  async quotaRemaining(): Promise<unknown> {
    return this.getOrgJson("/quota/remaining");
  }
}

function normalizeServerUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("ORG_SERVER_REQUIRED");
  if (!/^https?:\/\//.test(trimmed)) {
    // The PRD mandates https in production; localhost keeps http for dev.
    return /^https?:\/\/(localhost|127\.0\.0\.1)/.test(`http://${trimmed}`) ||
      trimmed.startsWith("localhost") ||
      trimmed.startsWith("127.0.0.1")
      ? `http://${trimmed}`
      : `https://${trimmed}`;
  }
  return trimmed;
}
