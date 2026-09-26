/**
 * Housekeeping: light, per-step size control without a checkpoint.
 *
 * Between the target and the full-compaction trigger, the engine rewrites
 * large tool results in place instead of replacing whole spans:
 *
 *   1. older inline images become labels (see images.mjs);
 *   2. tool results OLDER than the retained turns that are larger than
 *      `housekeepingExcerpt.head + tail` keep only that head and tail, with a
 *      marker naming the original seq.
 *
 * Both use the harness's content-only `tool/result` replacement (call id,
 * error flag and all other fields unchanged), so tool pairing and replay are
 * untouched and the original stays in the log for `recall`. No span is
 * replaced and no checkpoint is written, which keeps the request flat
 * instead of saw-toothed and makes the big compaction rarer.
 *
 * @module dsh-hypercompact/housekeeping
 */

import { formatBytes, headChars, tailChars, toolResultText } from './compiler.mjs';
import { utf8Bytes } from './bytes.mjs';
import { toolResultsOf, toolResultOfEvent, withToolResultContent } from './messages.mjs';

/** Marker text that identifies an already-trimmed result (never trimmed twice). */
export const TRIM_MARKER = '…[hypercompact: middle of this tool result removed';

/**
 * Plan which old tool results to trim.
 * @param nodes - surface view nodes, in order.
 * @param {number} limitIdx - first retained index; only nodes before it are trimmed.
 * @param {{ head: number, tail: number }} excerpt - kept characters.
 * @returns {{ node: object, text: string }[]} oldest first.
 */
export function planResultTrim(nodes, limitIdx, excerpt) {
  const plan = [];
  const keep = excerpt.head + excerpt.tail;
  for (let index = 0; index < limitIdx; index += 1) {
    const node = nodes[index];
    if (node.type !== 'tool/result') continue;
    const block = toolResultsOf(node.message)[0];
    if (block === undefined) continue;
    const text = toolResultText(block.content);
    if (text.includes(TRIM_MARKER)) continue;
    // Only worth it when the saving is substantial.
    if (text.length <= keep + 1024) continue;
    plan.push({ node, text });
  }
  return plan;
}

/**
 * Replacement message for one tool/result: text blocks collapse to one
 * head + marker + tail text; non-text blocks (images) are kept as they are.
 */
export function trimmedResultMessage(event, originSeq, excerpt, freeze = (value) => value) {
  const result = toolResultOfEvent(event);
  const text = toolResultText(result.content);
  const head = headChars(text, excerpt.head);
  const tail = tailChars(text, excerpt.tail);
  const cut = utf8Bytes(text) - utf8Bytes(head) - utf8Bytes(tail);
  const trimmed = `${head}\n${TRIM_MARKER} (${formatBytes(cut)}); full original: recall {"result": ${originSeq}}]\n${tail}`;
  const content = [{ type: 'text', text: trimmed }, ...result.content.filter((block) => block?.type !== 'text')];
  return freeze(withToolResultContent(event.data.message, content));
}
