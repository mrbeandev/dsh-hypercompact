/**
 * Incremental per-session surface index.
 *
 * Builds the plain surface view consumed by `select.mjs` from a live
 * `Session` without rescanning the log every step:
 *
 *   - `turnOfSeq` and `resultOrigin` are folded once per event, appended
 *     incrementally (O(new events) per call);
 *   - per-node byte prices are cached by seq until `contentGeneration` changes;
 *     newer DSH can project `image/offload` without replacing that seq.
 *
 * Only public Session members are used: `seq`, `eventAt`, `surface.nodes`,
 * `deriveEventMessage`, and `requestHeader`.
 *
 * @module dsh-hypercompact/surface
 */

import { messageBytes, toolsBytes } from './bytes.mjs';

/**
 * Index state for one session. Kept in a WeakMap by the engine so it is
 * released with the session.
 */
export class SurfaceIndex {
  constructor() {
    /** Next log seq not yet folded. */
    this.foldedSeq = 0;
    this.currentTurn = 0;
    /** seq -> turn number (only for surface-eligible events). */
    this.turnOfSeq = new Map();
    /**
     * seq -> the seq of the ORIGINAL tool/result when a node is a pruned or
     * rewritten replacement, so pointers always name byte-exact originals.
     */
    this.originOfSeq = new Map();
    /** seq -> estimated request bytes of the derived message. */
    this.bytesOfSeq = new Map();
    /** A durable projection can change message content without changing its seq. */
    this.contentGeneration = undefined;
    this.toolsBytesCache = { tools: undefined, bytes: 0 };
  }

  /** Fold log events appended since the last call. */
  sync(session) {
    const end = session.seq;
    for (let seq = this.foldedSeq; seq < end; seq += 1) {
      const event = session.eventAt(seq);
      if (event === undefined) continue;
      if (event.type === 'turn/start' && Number.isFinite(event.data?.turn)) this.currentTurn = event.data.turn;
      if (event.surfaceOp !== undefined) {
        this.turnOfSeq.set(seq, this.currentTurn);
        if (event.type === 'tool/result' && typeof event.surfaceOp === 'object' && Array.isArray(event.sourceEventSeqs)) {
          const source = event.sourceEventSeqs[0];
          if (Number.isSafeInteger(source)) this.originOfSeq.set(seq, this.originOfSeq.get(source) ?? source);
        }
      }
    }
    this.foldedSeq = end;
  }

  /** The original event seq behind a (possibly replaced) tool/result node. */
  originOf(seq) {
    return this.originOfSeq.get(seq) ?? seq;
  }

  /**
   * Build the surface view for selection and pricing.
   * @param session - live session.
   * @param [tools] - effective tool schemas; defaults to the logged header.
   */
  view(session, tools) {
    this.sync(session);
    const generation = session.surface.contentGeneration;
    if (generation !== this.contentGeneration) {
      // DSH 0.2 can append image/offload without replacing surface nodes.
      // Older DSH versions have no contentGeneration; their immutable seq
      // pricing remains cached until a new node is appended.
      if (this.contentGeneration !== undefined) this.bytesOfSeq.clear();
      this.contentGeneration = generation;
    }
    const surfaceNodes = session.surface.nodes;
    const nodes = new Array(surfaceNodes.length);
    for (let index = 0; index < surfaceNodes.length; index += 1) {
      const seq = surfaceNodes[index];
      const event = session.eventAt(seq);
      const message = event === undefined ? null : session.deriveEventMessage(event);
      let bytes = this.bytesOfSeq.get(seq);
      if (bytes === undefined) {
        bytes = messageBytes(message);
        this.bytesOfSeq.set(seq, bytes);
      }
      nodes[index] = {
        seq,
        type: event?.type,
        turn: this.turnOfSeq.get(seq) ?? 0,
        message,
        bytes,
        resultOrigin: event?.type === 'tool/result' ? this.originOf(seq) : undefined,
      };
    }
    const effectiveTools = tools ?? session.requestHeader()?.tools;
    if (effectiveTools !== this.toolsBytesCache.tools) {
      this.toolsBytesCache = { tools: effectiveTools, bytes: toolsBytes(effectiveTools) };
    }
    return { nodes, toolsBytes: this.toolsBytesCache.bytes };
  }
}
