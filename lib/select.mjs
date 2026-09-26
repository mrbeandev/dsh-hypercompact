/**
 * Surface measurement and compaction-range selection.
 *
 * Works on a plain "surface view" so it can be unit-tested without a live
 * session:
 *
 *   { nodes: [{ seq, type, turn, message, bytes }], toolsBytes, systemIdx }
 *
 * where `nodes` is the model-visible surface in order, `turn` is the turn
 * number that produced the node, and `bytes` is its estimated request size.
 *
 * @module dsh-hypercompact/select
 */

import { REQUEST_ENVELOPE_BYTES } from './bytes.mjs';
import { isHumanSource } from './compiler.mjs';

/** Estimated full request body for a surface view. */
export function requestBytes(view) {
  let total = REQUEST_ENVELOPE_BYTES + view.toolsBytes;
  for (const node of view.nodes) total += node.bytes;
  return total;
}

/** Number of tool calls opened by one node minus results it closes. */
function pairingDelta(node) {
  const content = node.message?.content;
  if (!Array.isArray(content)) return 0;
  if (node.type === 'assistant/message') return content.filter((block) => block?.type === 'tool-call').length;
  if (node.type === 'tool/result') return -1;
  return 0;
}

/**
 * For each index i, whether the cut immediately before node i leaves every
 * earlier tool call answered (mirrors dsh-compaction's toolPairingBalancedBefore).
 * @returns {boolean[]} length nodes.length + 1.
 */
export function balancedCuts(nodes) {
  const cuts = [true];
  let open = 0;
  for (const node of nodes) {
    open += pairingDelta(node);
    if (open < 0) open = 0; // corrupt surface; treat as balanced rather than throw here
    cuts.push(open === 0);
  }
  return cuts;
}

/**
 * Whether a surface node is a protected instruction (human input, a relayed
 * agent task, a goal round, a team message). Intra-turn compaction never
 * starts before the latest one.
 */
export function isHumanNode(node) {
  return node.type === 'user/message' && isHumanSource(node.message?.source);
}

/**
 * Earliest index that retention allows a cut at: everything from here on is
 * the newest `retainTurns` complete turns plus at least `retainBytes`.
 */
export function retentionLimit(nodes, firstIdx, policy) {
  const lastTurn = nodes.at(-1).turn;
  const retainFromTurn = policy.retainTurns > 0 && Number.isFinite(lastTurn) ? lastTurn - policy.retainTurns + 1 : Infinity;
  let keepLimit = nodes.length;
  if (Number.isFinite(retainFromTurn)) {
    for (let index = firstIdx; index < nodes.length; index += 1) {
      if (nodes[index].turn >= retainFromTurn) {
        keepLimit = index;
        break;
      }
    }
  }
  let tailBytes = 0;
  for (let index = nodes.length - 1; index >= firstIdx; index -= 1) {
    if (tailBytes >= policy.retainBytes) break;
    tailBytes += nodes[index].bytes;
    keepLimit = Math.min(keepLimit, index);
  }
  return keepLimit;
}

/** First index that may be compacted (a system prompt at node 0 never is). */
export function firstCompactable(nodes) {
  return nodes[0]?.type === 'system/message' ? 1 : 0;
}

/** Checkpoint size assumed while choosing a range, before the real budget is known. */
export function selectionCheckpointEstimate(policy, minCheckpointBytes) {
  return Math.max(minCheckpointBytes, Math.min(policy.maxCheckpointBytes, Math.floor(policy.targetRequestBytes / 2)));
}

/**
 * Checkpoint byte budget for a chosen range: whatever is actually free under
 * the target once the retained nodes (minus what image offload will free),
 * tool schemas and envelope are counted, clamped to
 * [minCheckpointBytes, maxCheckpointBytes].
 */
export function checkpointBudgetFor(view, range, policy, minCheckpointBytes, retainedSavings = 0) {
  let kept = REQUEST_ENVELOPE_BYTES + view.toolsBytes;
  view.nodes.forEach((node, index) => {
    if (index < range.startIdx || index > range.endIdx) kept += node.bytes;
  });
  // Bytes the post-commit image offload will free from the retained nodes.
  const free = policy.targetRequestBytes - (kept - retainedSavings);
  return Math.max(minCheckpointBytes, Math.min(policy.maxCheckpointBytes, free));
}

/**
 * Select the head-anchored inclusive index range [startIdx, endIdx] to
 * compact so that, after replacing it with a checkpoint of about
 * `checkpointBytes`, the request fits `targetRequestBytes`.
 *
 * Retention (never compacted): the last `retainTurns` complete turns, and at
 * least `retainBytes` of the newest surface. The cut lands on a balanced
 * tool-pairing boundary, preferring a turn boundary, so no call/result pair
 * is split. A system prompt at node 0 is never included.
 *
 * @param {object} view - surface view.
 * @param {object} policy - { targetRequestBytes, retainTurns, retainBytes }.
 * @param {object} [options] - { checkpointBytes, force }.
 *   `force` ignores the target (used by /compact and overflow recovery) and
 *   compacts everything outside retention.
 * @returns {{ startIdx: number, endIdx: number } | null}
 */
export function selectRange(view, policy, options = {}) {
  const nodes = view.nodes;
  if (nodes.length === 0) return null;
  const firstIdx = firstCompactable(nodes);
  if (nodes.length - firstIdx < 2) return null;
  const cuts = balancedCuts(nodes);
  const keepLimit = retentionLimit(nodes, firstIdx, policy);

  let desiredCut = keepLimit;
  if (!options.force) {
    desiredCut = desiredCutFrom(view, policy, options.checkpointBytes ?? 0, firstIdx, keepLimit);
    if (desiredCut === null) return null;
  }
  const cut = snapCut(nodes, cuts, firstIdx, desiredCut, keepLimit, true);
  if (cut === null || cut - firstIdx < 2) return null;
  return { startIdx: firstIdx, endIdx: cut - 1 };
}

/**
 * Fallback for one long autonomous turn: when everything outside retention
 * is already compacted but the request is still over the trigger, compact
 * tool traffic INSIDE the retained region. The latest human message and
 * everything before it stay; the newest `retainBytes` stay; the cut lands
 * on a balanced tool-pairing boundary.
 * @returns {{ startIdx: number, endIdx: number } | null}
 */
export function selectIntraTurnRange(view, policy, options = {}) {
  const nodes = view.nodes;
  if (nodes.length === 0) return null;
  let start = firstCompactable(nodes);
  for (let index = nodes.length - 1; index >= start; index -= 1) {
    if (isHumanNode(nodes[index])) {
      start = index + 1;
      break;
    }
  }
  const cuts = balancedCuts(nodes);
  if (!cuts[start]) return null;
  let tailLimit = nodes.length;
  let tailBytes = 0;
  for (let index = nodes.length - 1; index >= start; index -= 1) {
    if (tailBytes >= policy.retainBytes) break;
    tailBytes += nodes[index].bytes;
    tailLimit = index;
  }
  const desiredCut = options.force ? tailLimit : desiredCutFrom(view, policy, options.checkpointBytes ?? 0, start, tailLimit);
  if (desiredCut === null) return null;
  const cut = snapCut(nodes, cuts, start, desiredCut, tailLimit, false);
  if (cut === null || cut - start < 2) return null;
  return { startIdx: start, endIdx: cut - 1 };
}

/** Smallest cut after `from` whose removal reaches the target (or null if already there). */
function desiredCutFrom(view, policy, checkpointBytes, from, limit) {
  const mustRemove = requestBytes(view) - policy.targetRequestBytes + checkpointBytes;
  if (mustRemove <= 0) return null;
  let removed = 0;
  let cut = from;
  while (cut < limit && removed < mustRemove) {
    removed += view.nodes[cut].bytes;
    cut += 1;
  }
  return cut;
}

function snapCut(nodes, cuts, firstIdx, desiredCut, keepLimit, preferTurnBoundary) {
  const upper = Math.max(firstIdx + 1, Math.min(desiredCut, keepLimit));
  const isTurnBoundary = (cut) => cut === nodes.length || nodes[cut].turn !== nodes[cut - 1].turn;
  // Compacting a little more than needed is fine (hysteresis), so first look
  // forward, up to the retention limit, for a balanced turn boundary; then
  // for any balanced boundary; then fall back to the nearest one earlier.
  if (preferTurnBoundary) {
    for (let cut = upper; cut <= keepLimit; cut += 1) {
      if (cuts[cut] && isTurnBoundary(cut)) return cut;
    }
  }
  for (let cut = upper; cut <= keepLimit; cut += 1) {
    if (cuts[cut]) return cut;
  }
  for (let cut = upper - 1; cut > firstIdx; cut -= 1) {
    if (cuts[cut]) return cut;
  }
  return null;
}
