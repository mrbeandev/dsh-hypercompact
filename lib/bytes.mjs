/**
 * Request-body byte estimation.
 *
 * The harness never exposes the exact wire body, so this module prices the
 * provider-neutral request the adapter will serialize: every surface message
 * rendered as JSON, the tool schemas, and the system prompt. It is an
 * estimate; it deliberately over-counts slightly (JSON escaping is kept,
 * envelope keys are kept) so the trigger fires early rather than late.
 *
 * Images are priced by their attachment byte count as base64 (4/3 of the raw
 * bytes), because an OpenAI-compatible adapter inlines them as data URLs.
 * Replay metadata (`source.replayState`) is priced as well, since signed
 * reasoning replay travels with each assistant message.
 *
 * @module dsh-hypercompact/bytes
 */

const encoder = new TextEncoder();

/** UTF-8 byte length of a string. */
export function utf8Bytes(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  // Fast path: pure ASCII strings are one byte per code unit.
  let ascii = true;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7f) {
      ascii = false;
      break;
    }
  }
  return ascii ? text.length : encoder.encode(text).length;
}

/** Base64 size of `bytes` raw bytes. */
export function base64Bytes(bytes) {
  return Number.isFinite(bytes) && bytes > 0 ? Math.ceil(bytes / 3) * 4 : 0;
}

/** Fixed per-image envelope ("data:image/png;base64," plus JSON keys). */
const IMAGE_ENVELOPE_BYTES = 64;

/**
 * Serialized JSON size of a value, excluding image payload fields that the
 * durable log stores by reference, which are priced separately.
 */
function jsonBytes(value) {
  const text = JSON.stringify(value);
  return text === undefined ? 0 : utf8Bytes(text);
}

/** Sum the base64 cost of every image referenced (possibly nested) in blocks. */
function imageBytes(blocks) {
  let total = 0;
  if (!Array.isArray(blocks)) return 0;
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'image') {
      const raw = block.attachment?.bytes ?? (typeof block.data === 'string' ? Math.floor(block.data.length * 0.75) : 0);
      total += base64Bytes(raw) + IMAGE_ENVELOPE_BYTES;
    } else if (block.type === 'tool-result') {
      total += imageBytes(block.content);
    }
  }
  return total;
}

/**
 * Estimate the request bytes contributed by one derived model message.
 * @param {{ role: string, content: unknown[], source?: unknown } | null} message
 * @returns {number} estimated UTF-8 bytes.
 */
export function messageBytes(message) {
  if (message === null || message === undefined) return 0;
  return jsonBytes(message) + imageBytes(message.content);
}

/**
 * Estimate the bytes of the tool schema list sent with every request.
 * @param {unknown[] | undefined} tools
 */
export function toolsBytes(tools) {
  return Array.isArray(tools) && tools.length > 0 ? jsonBytes(tools) : 0;
}

/** Fixed request envelope (model, stream flags, options). */
export const REQUEST_ENVELOPE_BYTES = 512;
