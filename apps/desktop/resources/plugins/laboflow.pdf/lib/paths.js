/**
 * Session-root path resolution for PDFRead (ADR 0313).
 *
 * A PDF the agent is asked to read lives in one of three host-owned roots:
 * the open workspace, the session scratch directory, or the content-addressed
 * attachments store. Mirrors the host's own `resolvePromptPath` rules: the
 * canonical containment check is `realpath`-based, so a symlink cannot pull
 * a resolution outside its root.
 */
import { realpathSync, statSync, existsSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

function inside(root, candidate) {
  const relative = root === candidate ? "" : candidate.startsWith(root + sep) ? candidate.slice(root.length + 1) : null;
  return relative !== null && !relative.startsWith("..") && !isAbsolute(relative);
}

function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Derive the host data directory from this plugin's data path. The host
 * places plugin data at `<dataDir>/plugins/data/<pluginId>` (see
 * `PluginRuntime.pluginDataDir`); the derivation is verified against the
 * sibling roots before it is trusted, so a layout change fails closed.
 */
export function dataDirFromPluginDataPath(pluginDataPath) {
  const candidate = resolve(pluginDataPath, "..", "..", "..");
  if (!existsSync(join(candidate, "attachments")) && !existsSync(join(candidate, "scratch"))) {
    return undefined;
  }
  return candidate;
}

/**
 * Resolve an agent-supplied path against the session roots.
 * Returns { absolute } or undefined when the path is outside every root.
 */
export function resolvePdfPath({ path, workspacePath, dataDir, sessionId }) {
  const trimmed = (path ?? "").trim();
  if (!trimmed) return undefined;
  const roots = [];
  if (workspacePath) roots.push(canonical(workspacePath));
  if (dataDir && sessionId) roots.push(canonical(join(dataDir, "scratch", sessionId)));
  if (dataDir) roots.push(canonical(join(dataDir, "attachments")));
  const candidates = [];
  if (isAbsolute(trimmed)) {
    candidates.push(resolve(trimmed));
  } else if (trimmed.startsWith("attachments/")) {
    if (!dataDir) return undefined;
    candidates.push(resolve(dataDir, trimmed));
  } else if (workspacePath) {
    candidates.push(resolve(workspacePath, trimmed));
  } else {
    return undefined;
  }
  for (const candidate of candidates) {
    const real = canonical(candidate);
    if (!real) continue;
    const root = roots.find((entry) => entry && inside(entry, real));
    if (!root) continue;
    try {
      if (!statSync(real).isFile()) continue;
    } catch {
      continue;
    }
    return { absolute: real };
  }
  return undefined;
}
