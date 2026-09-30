/**
 * Image offload for retained tool results.
 *
 * Measured on real sessions, inline images (screenshots) are often the
 * majority of the request body: an OpenAI-compatible adapter base64-encodes
 * every image in history on every request. Text compaction cannot remove an
 * image that sits in the retained tail, so this pass rewrites older image
 * blocks in retained `tool/result` nodes into short text labels.
 *
 * It uses the harness's own content-only tool-result replacement (the same
 * mechanism as `dsh-compaction-tool-result-pruner`): the call id, error flag,
 * and every other field stay identical, pairing is untouched, and the
 * original event remains in the log, so `recall` still returns it.
 *
 * The newest `keepRecentImages` images are kept, as long as together they
 * stay under `maxKeptImageBytes`. Each label carries a one-sentence caption
 * taken from the assistant text that followed the image (when there is one),
 * so `[image removed …]` still says what the image showed.
 *
 * @module dsh-hypercompact/images
 */

import { formatBytes, headChars, oneLine } from './compiler.mjs';
import { base64Bytes } from './bytes.mjs';
import { toolResultsOf, toolResultOfEvent, withToolResultContent } from './messages.mjs';

/** Label that replaces one image block. */
export function imageLabel(block, originSeq, caption) {
  const attachment = block.attachment ?? {};
  const bits = [];
  if (typeof attachment.name === 'string') bits.push(JSON.stringify(attachment.name.slice(0, 80)));
  if (Number.isFinite(attachment.width) && Number.isFinite(attachment.height)) bits.push(`${attachment.width}x${attachment.height}`);
  if (Number.isFinite(attachment.bytes)) bits.push(formatBytes(attachment.bytes));
  const described = caption ? `; assistant then noted: ${JSON.stringify(caption)}` : '';
  return `[image removed to keep the request small${bits.length ? `: ${bits.join(' ')}` : ''}${described}; original in log seq ${originSeq}]`;
}

function imagesOf(content) {
  return Array.isArray(content) ? content.filter((block) => block?.type === 'image' && block.offloaded !== true) : [];
}

function imageCost(block) {
  return base64Bytes(block.attachment?.bytes ?? 0);
}

/**
 * First sentence of the next assistant text after `index`, as a caption.
 * Stops at the next user-authored message so an unrelated reply is not used.
 */
export function captionAfter(nodes, index) {
  for (let next = index + 1; next < nodes.length && next <= index + 12; next += 1) {
    const node = nodes[next];
    if (node.type === 'user/message') return undefined;
    if (node.type !== 'assistant/message') continue;
    const text = (node.message?.content ?? []).filter((block) => block?.type === 'text').map((block) => block.text ?? '').join(' ');
    const flat = oneLine(text);
    if (flat.length === 0) continue;
    const sentence = flat.split(/(?<=[.!?])\s/u)[0];
    return headChars(sentence, 200) + (sentence.length > 200 ? '…' : '');
  }
  return undefined;
}

/**
 * Plan which retained tool-result nodes to rewrite.
 * Walking newest to oldest, a node's images are kept while both the count
 * (`keepRecent`) and byte (`maxKeptBytes`) budgets allow; every older image
 * node is rewritten.
 * @param nodes - surface view nodes (from SurfaceIndex.view), in order.
 * @param {number} fromIdx - first index considered.
 * @param {number} keepRecent - newest images kept.
 * @param {number} [maxKeptBytes] - base64 byte cap on the kept images.
 * @returns {{ index: number, node: object }[]} nodes to rewrite, oldest first.
 */
export function planImageOffload(nodes, fromIdx, keepRecent, maxKeptBytes = Infinity) {
  const plan = [];
  let kept = 0;
  let keptBytes = 0;
  let full = false;
  for (let index = nodes.length - 1; index >= fromIdx; index -= 1) {
    const node = nodes[index];
    if (node.type !== 'tool/result') continue;
    const images = imagesOf(toolResultsOf(node.message)[0]?.content);
    if (images.length === 0) continue;
    const bytes = images.reduce((total, block) => total + imageCost(block), 0);
    if (!full && kept < keepRecent && keptBytes + bytes <= maxKeptBytes) {
      kept += images.length;
      keptBytes += bytes;
      continue;
    }
    full = true;
    plan.push({ index, node });
  }
  return plan.reverse();
}

/**
 * Build the replacement message for one tool/result event (content only).
 * @param event - the current tool/result event.
 * @param originSeq - seq of the original result (for the label pointer).
 * @param freeze - `freezeMessage` from dsh-llm (optional).
 * @param [caption] - one-sentence description to carry in the label.
 */
export function offloadedResultMessage(event, originSeq, freeze = (value) => value, caption = undefined) {
  const result = toolResultOfEvent(event);
  const content = result.content.map((block) => (block?.type === 'image' && block.offloaded !== true ? { type: 'text', text: imageLabel(block, originSeq, caption) } : block));
  return freeze(withToolResultContent(event.data.message, content));
}
