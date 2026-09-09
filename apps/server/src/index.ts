export const SERVER_VERSION = '0.9.0-beta';

/** Liveness probe (T2.1). Full readiness aggregation lands with T2.9. */
export function healthz(): { ok: boolean; version: string; phase: string } {
  return { ok: true, version: SERVER_VERSION, phase: 'P2-beta' };
}
