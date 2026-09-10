/**
 * Clawhub.ai skill marketplace adapter (W11/#12, rewritten against the real
 * ClawHub API — the same contract the official `clawhub` CLI speaks):
 *   search   GET /api/v1/search?q=…                  → { results: […] }
 *   detail   GET /api/v1/skills/{slug}?ownerHandle=…  → latestVersion
 *   download GET /api/v1/download?slug=&ownerHandle=&version= → zip bytes
 * An unreachable network surfaces as an empty result list, not an error.
 */

export interface ClawhubSkill {
  /** Registry slug, e.g. "planning-with-files". */
  slug: string;
  /** Publisher handle, e.g. "othmanadi"; passed back on download. */
  ownerHandle: string;
  name: string;
  description: string;
  downloads: number;
}

export interface ClawhubDownload {
  slug: string;
  ownerHandle: string;
  /** Resolved latest version (from the detail endpoint). */
  version: string;
  zip: Buffer;
}

const SKILL_MARKET_BASE =
  process.env.LABOFLOW_SKILL_MARKET_BASE?.trim() || "https://clawhub.ai";

type SearchItem = {
  displayName?: string;
  downloads?: number;
  canonicalUrl?: string;
  install?: { reference?: string };
  native?: {
    ownerHandle?: string;
    skill?: { slug?: string; summary?: string; description?: string };
  };
};

type SkillDetail = {
  skill?: {
    slug?: string;
    latestVersion?: { version?: string };
  };
  latestVersion?: { version?: string };
};

export class ClawhubClient {
  constructor(
    private readonly base = SKILL_MARKET_BASE,
    private readonly fetchImpl: typeof fetch = (url, init) => fetch(url, init),
  ) {}

  async search(query: string): Promise<ClawhubSkill[]> {
    const response = await this.fetchImpl(
      `${this.base}/api/v1/search?q=${encodeURIComponent(query)}`,
      { headers: { accept: "application/json" } },
    );
    if (!response.ok) return [];
    const body = (await response.json().catch(() => ({}))) as {
      results?: SearchItem[];
    };
    return (body.results ?? []).map((item) => {
      const native = item.native ?? {};
      const reference = item.install?.reference ?? "";
      const fallbackSlug = reference.includes("/")
        ? reference.split("/").slice(1).join("/")
        : reference;
      return {
        slug: native.skill?.slug ?? fallbackSlug,
        ownerHandle: native.ownerHandle ?? "",
        name: item.displayName ?? native.skill?.slug ?? fallbackSlug,
        description: native.skill?.summary ?? "",
        downloads: Number(item.downloads ?? 0),
      };
    });
  }

  /**
   * Download the latest version of one skill as a zip. The version comes from
   * the detail endpoint, mirroring the CLI's resolve-then-download flow.
   */
  async download(
    slug: string,
    ownerHandle?: string,
  ): Promise<ClawhubDownload | null> {
    const detail = await this.fetchImpl(
      `${this.base}/api/v1/skills/${encodeURIComponent(slug)}${
        ownerHandle ? `?ownerHandle=${encodeURIComponent(ownerHandle)}` : ""
      }`,
      { headers: { accept: "application/json" } },
    );
    if (!detail.ok) return null;
    const meta = (await detail.json().catch(() => ({}))) as SkillDetail;
    const version = meta.skill?.latestVersion?.version ?? meta.latestVersion?.version;
    if (!version) return null;

    const url = new URL(`${this.base}/api/v1/download`);
    url.searchParams.set("slug", slug);
    if (ownerHandle) url.searchParams.set("ownerHandle", ownerHandle);
    url.searchParams.set("version", version);
    const response = await this.fetchImpl(url.toString());
    if (!response.ok) return null;
    const zip = Buffer.from(await response.arrayBuffer());
    return { slug, ownerHandle: ownerHandle ?? "", version, zip };
  }
}
