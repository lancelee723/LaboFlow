/**
 * Throttle policy for `pi.session.continueFromPlugin` (F-2 proposal,
 * docs/laboflow/phase7-ppt-master/F-2-SESSION-CONTINUE-PROPOSAL.md).
 *
 * A plugin may resume a session turn only after an explicit user action in
 * that plugin's own surface, but a bug or a loop could still storm the
 * agent. The host caps continues per (session, plugin) inside a sliding
 * window; anything beyond the cap resolves `queued: false` without
 * touching the session.
 */

export const SESSION_CONTINUE_WINDOW_MS = 60_000;
export const SESSION_CONTINUE_MAX_PER_WINDOW = 6;

/** Pure sliding-window admission check. `hits` is mutated on accept. */
export function admitSessionContinue(
  hits: number[],
  now: number,
  max = SESSION_CONTINUE_MAX_PER_WINDOW,
  windowMs = SESSION_CONTINUE_WINDOW_MS,
): boolean {
  const kept = hits.filter((t) => now - t < windowMs);
  hits.length = 0;
  hits.push(...kept);
  if (kept.length >= max) return false;
  hits.push(now);
  return true;
}
