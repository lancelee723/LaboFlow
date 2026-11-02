import { pairsToRecord, type KeyValuePair } from "./kv-pairs.ts";

/**
 * Bearer-token sugar over the persisted `headers` shape.
 *
 * Streamable HTTP servers almost always authenticate with
 * `Authorization: Bearer <token>`, but users copy a bare key out of the
 * providing software, which never mentions that a scheme name must precede it.
 * The editor therefore owns the `Authorization` header in "bearer" mode: the
 * user pastes the key and the header is assembled here, in one place, before
 * save. The persisted record keeps storing a plain header, so the host
 * runtime, import, and export paths never learn this form existed.
 */

/** Lower-case name of the header that carries credentials. */
const AUTHORIZATION = "authorization";
/** Canonical casing written when the form assembles the header. */
const CANONICAL_AUTHORIZATION = "Authorization";
/** `<scheme> <credentials>`; the scheme is case-insensitive per RFC 7235. */
const BEARER_VALUE = /^bearer[ \t]+(\S.*)$/i;

export type McpAuthMode = "bearer" | "headers";

/** First Authorization header regardless of key casing. */
export function findAuthorizationEntry(
  headers: Record<string, string> | undefined,
): { key: string; value: string } | null {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.trim().toLowerCase() === AUTHORIZATION) return { key, value };
  }
  return null;
}

/** Bearer mode when an Authorization header already holds a `Bearer` token. */
export function detectAuthMode(headers: Record<string, string> | undefined): McpAuthMode {
  const entry = findAuthorizationEntry(headers);
  return entry && BEARER_VALUE.test(entry.value) ? "bearer" : "headers";
}

/**
 * Split a saved `Authorization: Bearer <token>` out of the header record so
 * editing can show the bare token again. Every other header — including an
 * Authorization header with a non-Bearer value — stays in `rest` and keeps
 * working exactly as before.
 */
export function splitBearerHeaders(
  headers: Record<string, string> | undefined,
): { token: string; rest: Record<string, string> } | null {
  const entry = findAuthorizationEntry(headers);
  if (!entry) return null;
  const match = BEARER_VALUE.exec(entry.value);
  if (!match) return null;
  const rest: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key !== entry.key) rest[key] = value;
  }
  return { token: match[1].trim(), rest };
}

/**
 * Bearer mode owns `Authorization`: whenever the token field is set, its
 * canonical header wins over anything left in the rows. An empty token
 * preserves the rows untouched, so a hand-written Authorization survives.
 */
export function assembleBearerHeaders(
  token: string,
  rest: Record<string, string>,
): Record<string, string> {
  const headers = { ...rest };
  const trimmed = token.trim();
  if (trimmed) headers[CANONICAL_AUTHORIZATION] = `Bearer ${trimmed}`;
  return headers;
}

/** Headers the editor persists for an HTTP server, per selected auth mode. */
export function buildHttpHeaders(
  authMode: McpAuthMode,
  bearerToken: string,
  pairs: readonly KeyValuePair[],
): Record<string, string> {
  const record = pairsToRecord(pairs);
  return authMode === "bearer" ? assembleBearerHeaders(bearerToken, record) : record;
}
