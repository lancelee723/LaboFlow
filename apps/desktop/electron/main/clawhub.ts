/**
 * Clawhub.ai skill marketplace adapter (ported from the frozen LaboFlow
 * client, W11/#12). The live API is served from https://clawhub.ai; an
 * unreachable network surfaces as an empty result list, not an error.
 */

export interface ClawhubSkill {
  slug: string;
  name: string;
  description: string;
  author: string;
  downloads: number;
}

const SKILL_MARKET_BASE =
  process.env.LABOFLOW_SKILL_MARKET_BASE?.trim() || "https://clawhub.ai";

export class ClawhubClient {
  constructor(
    private readonly base = SKILL_MARKET_BASE,
    private readonly fetchImpl: typeof fetch = (url, init) => fetch(url, init),
  ) {}

  async search(query: string): Promise<ClawhubSkill[]> {
    const res = await this.fetchImpl(
      `${this.base}/api/skills?q=${encodeURIComponent(query)}`,
      { headers: { accept: "application/json" } },
    );
    if (!res.ok) return [];
    const json = (await res.json().catch(() => ({}))) as {
      skills?: Array<Record<string, unknown>>;
    };
    return (json.skills ?? []).map((s) => ({
      slug: String(s.slug ?? s.id ?? ""),
      name: String(s.name ?? s.slug ?? ""),
      description: String(s.description ?? ""),
      author: String(s.author ?? ""),
      downloads: Number(s.downloads ?? 0),
    }));
  }

  /** Download one skill package (zip bytes); null when unavailable. */
  async download(slug: string): Promise<Buffer | null> {
    const res = await this.fetchImpl(
      `${this.base}/api/skills/${encodeURIComponent(slug)}/download`,
    );
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  }
}
