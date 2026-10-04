/**
 * FR-PPT-06 artifact chain: exported decks register as session artifacts so
 * re-exports land on the same (session, path) row with a fresh timestamp —
 * the artifacts table's upsert IS the version chain. Registration is
 * best-effort: extraction failures are silent (nothing to register), host
 * failures surface only in logs.
 */

import type { HostProcess } from "../host-process";

const SLIDES_PLUGIN_ID = "laboflow.slides";
/** L1 quick export and the L2 pipeline's export gate script. */
const EXPORT_TOOL_NAMES = new Set(["slides_export", "ppt_script"]);
const L2_EXPORT_SCRIPT = "svg_to_pptx";

/** Path-shaped .pptx tokens in tool output text (CJK workspace names included).
 * Branch order matters: drive/root-anchored, then separator-bearing relative,
 * then bare file names. */
const PPTX_PATH_PATTERN =
  /(?:[A-Za-z]:)?[\/\\][\w.\-\u4e00-\u9fff\\/]+\.pptx|[\w.\-\u4e00-\u9fff]+(?:[\/\\][\w.\-\u4e00-\u9fff]+)+\.pptx|[\w.\-\u4e00-\u9fff]+\.pptx/g;

/** Result payloads are `{content: string}` (agent tool convention) or raw text. */
function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const content = (result as { content?: unknown }).content;
    if (typeof content === "string") return content;
    const stdout = (result as { stdout?: unknown }).stdout;
    if (typeof stdout === "string") return stdout;
  }
  return "";
}

/** Pull deduplicated, non-quoted .pptx paths out of a tool result. */
export function extractExportedPptxPaths(result: unknown): string[] {
  const text = resultText(result);
  if (!text) return [];
  const found = new Set<string>();
  for (const match of text.matchAll(PPTX_PATH_PATTERN)) {
    const token = match[0].replace(/^[("'`]+|[)"'`,.;]+$/g, "");
    if (token.toLowerCase().endsWith(".pptx") && token.length > 5) {
      found.add(token);
    }
  }
  return [...found];
}

export type SlidesArtifactInput = {
  pluginId: string;
  toolName: string;
  sessionId: string;
  turnId?: string;
  args: unknown;
  result: unknown;
};

/** True when this tool result is an export completion worth registering. */
export function isSlidesExportResult(input: SlidesArtifactInput): boolean {
  if (input.pluginId !== SLIDES_PLUGIN_ID) return false;
  if (!EXPORT_TOOL_NAMES.has(input.toolName)) return false;
  if (input.toolName === "ppt_script") {
    const script =
      input.args && typeof input.args === "object"
        ? (input.args as { script?: unknown }).script
        : undefined;
    if (script !== L2_EXPORT_SCRIPT) return false;
  }
  return true;
}

const MAX_ACTIVE_REGISTRATIONS = 512;

/**
 * Register exported decks for the session. Export-gated tools only, pptx
 * paths only; a per-process registry avoids re-calling the host for the same
 * (session, path) pair, while the artifacts upsert stays the source of truth.
 */
export async function maybeRegisterSlidesArtifact(
  host: HostProcess | null,
  input: SlidesArtifactInput,
  seen?: Set<string>,
): Promise<void> {
  if (!host || !input.sessionId) return;
  if (!isSlidesExportResult(input)) return;
  const registry = seen ?? globalSeen;
  for (const path of extractExportedPptxPaths(input.result)) {
    const key = `${input.sessionId}\u0000${path}`;
    if (registry.has(key)) continue;
    if (registry.size >= MAX_ACTIVE_REGISTRATIONS) {
      registry.clear();
    }
    registry.add(key);
    await host.call("artifacts.record", {
      sessionId: input.sessionId,
      path,
      op: "export",
      ...(input.turnId ? { turnId: input.turnId } : {}),
    });
  }
}

const globalSeen = new Set<string>();
