/**
 * KbService (module 05, plans T55.1/T55.6).
 *
 * Knowledge-base retrieval services ARE MCP servers (ADR-KB2): org-delivered
 * entries are upserted into the existing `mcp_servers` registry with
 * `source: "org"` (read-only, exempt from the user's 16-server cap), and
 * personal web-URL entries ride the app settings blob. No parallel registry.
 */

import type {
  KbServerDelivery,
  KbUrlEntry,
} from "@pi-desktop/shared";

export interface KbServiceDeps {
  getHost(): {
    call<T = unknown>(method: string, params?: unknown): Promise<T>;
  } | null;
  getLogger(): { app(scope: string, level: string, message: string, data?: unknown): void };
}

function slugifyId(name: string): string {
  const ascii = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (ascii) return ascii;
  // CJK names hash to a stable ASCII id (valid_capability_id is ASCII-only).
  let hash = 5381;
  for (const byte of Buffer.from(name.trim(), "utf8")) {
    hash = ((hash << 5) + hash + byte) >>> 0;
  }
  return `kb-${hash.toString(36)}`;
}

export class KbService {
  constructor(private readonly deps: KbServiceDeps) {}

  private host() {
    const host = this.deps.getHost();
    if (!host) throw new Error("backend unavailable");
    return host;
  }

  /** Apply `bootstrap.kbServers[]` (called by OrgService after login/refresh). */
  async applyOrgDelivery(
    orgId: string,
    items: KbServerDelivery[],
  ): Promise<{ applied: number; removed: number }> {
    const host = this.host();
    const mcpItems = items.filter((item) => item.kind === "mcp" && item.enabled !== false);
    const existing = await host
      .call<{ servers: Array<{ id: string; source?: string; orgId?: string }> }>("mcp.list", {
        includeDisabled: true,
      })
      .catch(() => ({ servers: [] }));
    const orgOwned = new Set(
      existing.servers
        .filter((server) => server.source === "org")
        .map((server) => server.id),
    );
    let applied = 0;
    for (const item of mcpItems) {
      const id = `kb-${slugifyId(item.name)}`;
      orgOwned.delete(id);
      try {
        await host.call("mcp.upsert", {
          id,
          label: item.name,
          description: item.description ?? "组织下发的知识库检索服务",
          transport: item.transport === "stdio" ? "stdio" : "http",
          ...(item.transport === "stdio"
            ? { command: item.command, args: item.args, env: item.env }
            : { url: item.url, headers: item.apiKey ? { "X-API-Key": item.apiKey } : {} }),
          enabled: true,
          source: "org",
          orgId,
        });
        applied += 1;
      } catch (error) {
        this.deps.getLogger().app("kb", "warn", "org kb server upsert failed", {
          data: { name: item.name, error: String(error) },
        });
      }
    }
    // Org items that vanished from the delivery are disabled, not deleted —
    // the member may re-receive them on the next bootstrap.
    let removed = 0;
    for (const staleId of orgOwned) {
      await host
        .call("mcp.setEnabled", { id: staleId, enabled: false })
        .then(() => {
          removed += 1;
        })
        .catch(() => undefined);
    }
    return { applied, removed };
  }

  /** Disable every org-provided server (logout). Personal entries survive. */
  async disableOrgServers(): Promise<void> {
    const host = this.host();
    const { servers } = await host
      .call<{ servers: Array<{ id: string; source?: string }> }>("mcp.list", {
        includeDisabled: true,
      })
      .catch(() => ({ servers: [] }));
    for (const server of servers) {
      if (server.source !== "org") continue;
      await host
        .call("mcp.setEnabled", { id: server.id, enabled: false })
        .catch(() => undefined);
    }
  }

  async listUrls(): Promise<KbUrlEntry[]> {
    const settings = (await this.host().call<Record<string, unknown>>("settings.get").catch(
      () => ({}),
    )) as { kbUrls?: KbUrlEntry[] };
    return Array.isArray(settings.kbUrls) ? settings.kbUrls : [];
  }

  async saveUrl(entry: { name: string; url: string }): Promise<KbUrlEntry[]> {
    const host = this.host();
    const name = String(entry?.name ?? "").trim();
    const url = String(entry?.url ?? "").trim();
    if (!name || !/^https?:\/\//i.test(url)) {
      throw new Error("KB_INVALID: name and http(s) url are required");
    }
    const urls = await this.listUrls();
    const next = urls.some((item) => item.name === name)
      ? urls.map((item) => (item.name === name ? { ...item, url } : item))
      : [...urls, { id: `kburl-${slugifyId(name) || Date.now().toString(36)}`, name, url, source: "user" as const }];
    await host.call("settings.set", { kbUrls: next });
    return next;
  }

  async deleteUrl(id: string): Promise<KbUrlEntry[]> {
    const host = this.host();
    const urls = await this.listUrls();
    const next = urls.filter((item) => item.id !== id && item.source !== "org");
    await host.call("settings.set", { kbUrls: next });
    return next;
  }
}
