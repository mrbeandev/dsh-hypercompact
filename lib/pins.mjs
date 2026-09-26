/**
 * Recall-aware retention.
 *
 * When the model recalls an entry, that content is evidently still needed.
 * The recall tools record the recalled seqs here, and the next compaction
 * marks matching checkpoint entries as pinned: kept at full length, excerpts
 * kept, never elided. Pins are cleared once a compaction has honored them
 * (the pinned lines then live on in the checkpoint, which is itself
 * protected when carried forward).
 *
 * Keyed by Session object in a WeakMap, so state is released with the session.
 *
 * @module dsh-hypercompact/pins
 */

const pinsBySession = new WeakMap();

/** Maximum pins kept per session; the oldest are dropped first. */
export const MAX_PINS = 200;

/** Record recalled seqs for a session. */
export function pin(session, seqs) {
  if (session === undefined || session === null) return;
  let pins = pinsBySession.get(session);
  if (pins === undefined) {
    pins = new Set();
    pinsBySession.set(session, pins);
  }
  for (const seq of seqs) {
    if (!Number.isSafeInteger(seq)) continue;
    pins.delete(seq);
    pins.add(seq);
  }
  while (pins.size > MAX_PINS) pins.delete(pins.values().next().value);
}

/** Current pins for a session (a copy). */
export function pinsFor(session) {
  return new Set(pinsBySession.get(session) ?? []);
}

/** Drop pins that a compaction has now carried into its checkpoint. */
export function releasePins(session, seqs) {
  const pins = pinsBySession.get(session);
  if (pins === undefined) return;
  for (const seq of seqs) pins.delete(seq);
}
