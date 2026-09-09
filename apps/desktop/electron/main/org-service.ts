/**
 * Org session client (PRD 4.1.12, FR-S-01) — talks to the LaboFlow Server
 * auth/org API and keeps the session in the host secret store. Secrets are
 * written through host RPC and never cross back to the renderer; the
 * renderer only ever sees the mapped OrgStatus profile.
 */

import type { OrgBootstrap, OrgStatus } from "@pi-desktop/shared";

export const ORG_SECRET_REF = "org/session";

export type OrgHostDeps = {
  call: <T>(method: string, params?: unknown) => Promise<T>;
};

export type OrgFetch = (url: string, init?: RequestInit) => Promise<Response>;

type StoredSession = {
  serverUrl: string;
  username: string;
  accessToken: string;
  refreshToken?: string;
  mustChangePassword?: boolean;
  displayName?: string;
  role?: string;
};

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

export class OrgService {
  private readonly fetchImpl: OrgFetch;

  constructor(
    private readonly deps: OrgHostDeps,
    fetchImpl?: OrgFetch,
  ) {
    this.fetchImpl =
      fetchImpl ?? ((url, init) => fetch(url, init));
  }

  private async readSession(): Promise<StoredSession | null> {
    const { value } = await this.deps.call<{ value?: string | null }>(
      "secrets.getForRuntime",
      { secretRef: ORG_SECRET_REF },
    );
    if (!value) return null;
    try {
      return JSON.parse(value) as StoredSession;
    } catch {
      return null;
    }
  }

  private async writeSession(session: StoredSession): Promise<void> {
    await this.deps.call("secrets.set", {
      secretRef: ORG_SECRET_REF,
      value: JSON.stringify(session),
    });
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
    await this.writeSession(session);
    return this.status();
  }

  async changePassword(input: {
    currentPassword: string;
    newPassword: string;
  }): Promise<OrgStatus> {
    const session = await this.readSession();
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
    await this.writeSession({
      ...session,
      accessToken: nextBody.tokens?.accessToken ?? session.accessToken,
      refreshToken: nextBody.tokens?.refreshToken ?? session.refreshToken,
      mustChangePassword: false,
    });
    return this.status();
  }

  async logout(): Promise<OrgStatus> {
    await this.deps.call("secrets.delete", { secretRef: ORG_SECRET_REF });
    return { connected: false, state: "disconnected" };
  }

  async status(): Promise<OrgStatus> {
    const session = await this.readSession();
    if (!session) return { connected: false, state: "disconnected" };
    const { ok, status, body } = await this.api(session, "/org/bootstrap");
    if (status === 401) {
      return {
        connected: false,
        state: "expired",
        serverUrl: session.serverUrl,
        username: session.username,
      };
    }
    if (!ok) {
      return {
        connected: false,
        state: "expired",
        serverUrl: session.serverUrl,
        username: session.username,
        error: `ORG_STATUS_FAILED: HTTP ${status}`,
      };
    }
    const bootstrap = body as OrgBootstrap;
    return {
      connected: true,
      state: "connected",
      serverUrl: session.serverUrl,
      username: bootstrap.me?.username ?? session.username,
      displayName: bootstrap.me?.displayName ?? session.displayName,
      role: bootstrap.me?.role ?? session.role,
      orgName: bootstrap.org?.name,
      teamName: bootstrap.org?.teamName ?? undefined,
      workspaceCount: Array.isArray(bootstrap.workspaces)
        ? bootstrap.workspaces.length
        : 0,
      mustChangePassword: session.mustChangePassword,
    };
  }
}
