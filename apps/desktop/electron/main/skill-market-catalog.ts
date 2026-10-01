/**
 * Aggregator for user-configured skill market sources.
 *
 * Lives in the main process because the renderer's CSP only allows localhost
 * connections. Document fetching (for preview and install) also sits here for
 * the same CSP reason; the actual write goes through the existing
 * `skills.create` path on the renderer's side.
 */
import { net, session } from "electron";
import type { SkillCatalogEntry, SkillMarketSource } from "@pi-desktop/shared";
import { createPublicHttpsClient } from "./public-https-fetch";
import { ClawhubClient } from "./clawhub";
import {
  allowInsecureUserEndpointsEnabled,
  noteInsecureUserEndpoint,
  relaxedNetworkPolicyEnabled,
} from "./endpoint-policy";
import {
  createSkillMarketAggregator,
  type SkillMarketDocument,
  type SkillMarketSearchResult,
} from "./skill-market-scan";
import type { SourcedSkillEntry } from "@pi-desktop/shared";

export type { SkillMarketDocument, SkillMarketSearchResult } from "./skill-market-scan";
export { guessSkillCategories } from "./skill-market-scan";

/**
 * `net.fetch` issues requests from the default session, so the guard asks that
 * same session which route the request will take before it judges an address:
 * a proxied hop dials the proxy, not the address a local resolver answered
 * (ADR 0177, ADR 0272).
 */
const client = createPublicHttpsClient({
  fetchImpl: (url, init) => net.fetch(url, init),
  routeImpl: (url) => session.defaultSession.resolveProxy(url),
  // Fake-IP answers come from the network policy, not from the proxy switch:
  // the relaxed mode is what tolerates a transparent router's placeholder
  // addresses for content the app fetched from a public HTTPS source.
  allowFakeIp: () => relaxedNetworkPolicyEnabled(),
  // A source URL the user typed may be a LAN or loopback catalog; the opt-in
  // for a plaintext hop to it is the stored `networkPolicy`.
  allowInsecureUserEndpoints: () => allowInsecureUserEndpointsEnabled(),
  // A plaintext hop to the user's own LAN catalogue is worth one notice.
  onInsecureUserEndpoint: (host) => noteInsecureUserEndpoint(host),
});
const aggregator = createSkillMarketAggregator(client.request, {
  allowInsecureUserEndpoints: () => allowInsecureUserEndpointsEnabled(),
});
const clawhub = new ClawhubClient();
const CLAWHUB_SOURCE_NAME = "Clawhub";
const CLAWHUB_ENTRY_ID_PREFIX = "clawhub:";

/**
 * Clawhub is a built-in source: the aggregator only knows user-configured
 * catalogs, so without this fold-in the market search came up empty for
 * everyone who never added a source by hand. Entries keep the slug recoverable
 * (id prefix) because install round-trips slug + ownerHandle through
 * `skillMarketInstall` → ClawhubClient.download.
 */
async function searchClawhub(
  query: string,
  result: SkillMarketSearchResult,
): Promise<SkillMarketSearchResult> {
  try {
    const skills = await clawhub.search(query);
    const entries: SourcedSkillEntry[] = skills.map((skill) => ({
      id: `${CLAWHUB_ENTRY_ID_PREFIX}${skill.slug}`,
      sourceId: "clawhub",
      name: skill.name,
      description: skill.description,
      author: skill.ownerHandle,
      homepage: `https://clawhub.ai/${skill.ownerHandle}/skills/${skill.slug}`,
      url: `https://clawhub.ai/${skill.ownerHandle}/skills/${skill.slug}`,
    }));
    return { ...result, entries: [...entries, ...result.entries] };
  } catch (error) {
    return {
      ...result,
      failedSources: [...result.failedSources, CLAWHUB_SOURCE_NAME],
      failureKinds: {
        ...result.failureKinds,
        [CLAWHUB_SOURCE_NAME]: "network",
      },
      failureDetails: {
        ...result.failureDetails,
        [CLAWHUB_SOURCE_NAME]: {
          host: "clawhub.ai",
          reason: error instanceof Error ? error.message : String(error),
        } as SkillMarketSearchResult["failureDetails"][string],
      },
    };
  }
}

export async function searchSkillMarket(
  query: string,
  sources: SkillMarketSource[],
): Promise<SkillMarketSearchResult> {
  const result = await aggregator.search(query, sources);
  return searchClawhub(query, result);
}

export function fetchSkillMarketDocument(entry: SkillCatalogEntry): Promise<SkillMarketDocument> {
  return aggregator.fetchEntryDocument(entry);
}
