/**
 * Recall and search over the append-only session log.
 *
 * `recall` returns the original content of earlier log events byte-exactly:
 * text is not sanitized, tool-call arguments are returned as the raw JSON
 * string the model produced, and tool-result text is joined exactly as the
 * adapter joins it. Output is paginated with `offset` rather than silently
 * truncated, so any size of result can be restored completely.
 *
 * `search` scans the log (not only the live surface), so content that an
 * earlier compaction shadowed is still found.
 *
 * Dependency-free: accepts any object with `seq` and `eventAt(seq)`.
 *
 * @module dsh-hypercompact/recall
 */

import { toolResultOfEvent, isCheckpointSource } from './messages.mjs';

/** Maximum number of seqs one range request may expand to. */
export const MAX_RANGE_SPAN = 200;

/** Error with a stable code, mapped to a tool error by the tool layer. */
export class RecallError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RecallError';
    this.code = code;
  }
}

function toolResultRaw(content) {
  if (!Array.isArray(content)) return '';
  return content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n');
}

function mediaNote(block) {
  const attachment = block.attachment ?? {};
  const name = typeof attachment.name === 'string' ? ` ${attachment.name}` : '';
  const id = typeof attachment.attachmentId === 'string' ? ` ${attachment.attachmentId}` : '';
  return `[${block.type}${name}${id}]`;
}

/**
 * Render one event's model-relevant content without alteration.
 * @returns {{ header: string, text: string } | null} null for events with no content.
 */
export function renderEvent(event) {
  if (event === undefined || event === null) return null;
  const seq = event.seq;
  switch (event.type) {
    case 'user/message': {
      const message = event.data;
      const parts = [];
      for (const block of message?.content ?? []) {
        if (block?.type === 'text') parts.push(block.text ?? '');
        else if (block?.type === 'tool-result') parts.push(toolResultRaw(block.content));
        else if (block?.type) parts.push(mediaNote(block));
      }
      const source = message?.source;
      const kind = isCheckpointSource(source) ? 'checkpoint' : (source === undefined || source?.kind === 'user') ? 'user' : 'context';
      return { header: `seq ${seq} ${kind === 'context' ? `context (${source?.kind ?? '?'})` : kind} message`, text: parts.join('\n'), kind };
    }
    case 'assistant/message':
    case 'developer/message':
    case 'system/message': {
      const message = event.data?.message;
      const parts = [];
      for (const block of message?.content ?? []) {
        if (block?.type === 'text') parts.push(block.text ?? '');
        else if (block?.type === 'reasoning') parts.push(`[reasoning]\n${block.text ?? ''}`);
        else if (block?.type === 'tool-call') {
          const args = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {});
          parts.push(`[tool-call ${block.name} id=${block.id}]\n${args}`);
        } else if (block?.type) parts.push(mediaNote(block));
      }
      const kind = event.type === 'assistant/message' ? 'assistant' : event.type === 'system/message' ? 'system' : 'context';
      return { header: `seq ${seq} ${kind} message`, text: parts.join('\n'), kind };
    }
    case 'tool/result': {
      const block = toolResultOfEvent(event);
      const media = (block?.content ?? []).filter((item) => item?.type && item.type !== 'text').map(mediaNote);
      const status = block?.isError ? 'error' : 'ok';
      const text = toolResultRaw(block?.content) + (media.length > 0 ? `\n${media.join('\n')}` : '');
      return { header: `seq ${seq} tool result (${status}, call ${block?.toolCallId ?? '?'})`, text, kind: 'result', error: block?.isError === true };
    }
    case 'tool/call': {
      const data = event.data ?? {};
      const args = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {});
      return { header: `seq ${seq} tool call ${data.name ?? '?'} (id ${data.callId ?? '?'})`, text: args, kind: 'tool' };
    }
    default:
      return null;
  }
}

function assertSeq(session, seq, name) {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new RecallError(`${name} must be a non-negative integer`, 'RECALL_INVALID');
  if (seq >= session.seq) throw new RecallError(`${name} ${seq} does not exist yet (log has ${session.seq} events)`, 'RECALL_MISSING');
}

/**
 * Find the ORIGINAL tool/result event for a pointer. Accepts the seq of a
 * tool/result (following replacement chains back to the original), or the
 * seq of an assistant message / tool/call whose call it answers.
 */
export function findOriginalResult(session, seq) {
  let event = session.eventAt(seq);
  const seen = new Set();
  while (event?.type === 'tool/result' && typeof event.surfaceOp === 'object' && Array.isArray(event.sourceEventSeqs) && !seen.has(event.seq)) {
    seen.add(event.seq);
    const source = session.eventAt(event.sourceEventSeqs[0]);
    if (source?.type !== 'tool/result') break;
    event = source;
  }
  if (event?.type === 'tool/result') return [event];
  let callIds = [];
  if (event?.type === 'assistant/message') callIds = (event.data?.message?.content ?? []).filter((block) => block?.type === 'tool-call').map((block) => block.id);
  else if (event?.type === 'tool/call') callIds = [event.data?.callId];
  callIds = callIds.filter((id) => typeof id === 'string');
  if (callIds.length === 0) return [];
  const wanted = new Set(callIds);
  const found = [];
  for (let next = seq + 1; next < session.seq && wanted.size > 0; next += 1) {
    const candidate = session.eventAt(next);
    if (candidate?.type !== 'tool/result') continue;
    const id = toolResultOfEvent(candidate)?.toolCallId;
    // Skip replacement copies: the first result for a call id is the original.
    if (wanted.has(id) && candidate.surfaceOp === 'append') {
      found.push(candidate);
      wanted.delete(id);
    }
  }
  return found;
}

/** Paginate text by UTF-16 offset without splitting a surrogate pair. */
function page(text, offset, limit) {
  const total = text.length;
  if (offset >= total) return { chunk: '', next: null, total };
  let end = Math.min(total, offset + limit);
  if (end < total) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return { chunk: text.slice(offset, end), next: end < total ? end : null, total };
}

/** Maximum context lines around a grep match. */
const MAX_GREP_CONTEXT = 20;

/**
 * Select part of one item's text: `grep` keeps matching lines with context,
 * `head`/`tail` keep the first/last N characters. Everything returned is an
 * exact substring (or exact lines) of the original.
 */
function sliceText(text, request) {
  const notes = [];
  let out = text;
  if (request.grep !== undefined) {
    let pattern;
    try {
      pattern = new RegExp(request.grep, 'iu');
    } catch (error) {
      throw new RecallError(`invalid grep pattern: ${error.message}`, 'RECALL_INVALID');
    }
    const context = request.context ?? 2;
    if (!Number.isSafeInteger(context) || context < 0 || context > MAX_GREP_CONTEXT) throw new RecallError(`context must be an integer 0-${MAX_GREP_CONTEXT}`, 'RECALL_INVALID');
    const lines = out.split('\n');
    const keep = new Uint8Array(lines.length);
    let matches = 0;
    lines.forEach((line, index) => {
      if (!pattern.test(line)) return;
      matches += 1;
      for (let near = Math.max(0, index - context); near <= Math.min(lines.length - 1, index + context); near += 1) keep[near] = 1;
    });
    const parts = [];
    let gap = false;
    lines.forEach((line, index) => {
      if (keep[index]) {
        if (gap && parts.length > 0) parts.push('…');
        parts.push(`${index + 1}: ${line}`);
        gap = false;
      } else gap = true;
    });
    out = parts.join('\n');
    notes.push(`grep ${JSON.stringify(request.grep)}: ${matches} matching lines of ${lines.length} (prefixed with line numbers)`);
  }
  if (request.head !== undefined || request.tail !== undefined) {
    for (const key of ['head', 'tail']) {
      if (request[key] !== undefined && (!Number.isSafeInteger(request[key]) || request[key] < 0)) throw new RecallError(`${key} must be a non-negative integer`, 'RECALL_INVALID');
    }
    const head = request.head ?? 0;
    const tail = request.tail ?? 0;
    if (head + tail < out.length) {
      const start = out.slice(0, head);
      const end = tail > 0 ? out.slice(out.length - tail) : '';
      notes.push(`showing first ${head} and last ${tail} of ${out.length} characters`);
      out = `${start}${head > 0 && tail > 0 ? '\n…\n' : ''}${end}`;
    }
  }
  return { text: out, notes };
}

/**
 * Recall original content.
 * @param session - object with `seq` and `eventAt`.
 * @param {{ seq?: number, result?: number, range?: string, offset?: number,
 *   grep?: string, context?: number, head?: number, tail?: number }} request
 * @param {{ maxChars: number }} options
 * @returns {{ text: string, events: number, seqs: number[], nextOffset: number | null, totalChars: number }}
 */
export function recall(session, request, options) {
  const offset = request.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RecallError('offset must be a non-negative integer', 'RECALL_INVALID');
  const chosen = ['seq', 'result', 'range'].filter((key) => request[key] !== undefined && request[key] !== null && request[key] !== '');
  if (chosen.length !== 1) throw new RecallError('pass exactly one of seq, result, or range', 'RECALL_INVALID');

  let events = [];
  if (request.seq !== undefined && request.seq !== null) {
    assertSeq(session, request.seq, 'seq');
    events = [session.eventAt(request.seq)];
    if (renderEvent(events[0]) === null) throw new RecallError(`seq ${request.seq} is a ${events[0]?.type ?? 'missing'} event with no recallable content`, 'RECALL_EMPTY');
  } else if (request.result !== undefined && request.result !== null) {
    assertSeq(session, request.result, 'result');
    events = findOriginalResult(session, request.result);
    if (events.length === 0) throw new RecallError(`no tool result found for seq ${request.result}`, 'RECALL_MISSING');
  } else {
    const match = /^\s*(\d+)\s*(?:-|–|\.\.)\s*(\d+)\s*$/u.exec(String(request.range));
    if (match === null) throw new RecallError('range must look like "120-140"', 'RECALL_INVALID');
    const start = Number(match[1]);
    const requestedEnd = Number(match[2]);
    if (requestedEnd < start) throw new RecallError('range end is before its start', 'RECALL_INVALID');
    if (requestedEnd - start + 1 > MAX_RANGE_SPAN) throw new RecallError(`range is wider than ${MAX_RANGE_SPAN} seqs; split it`, 'RECALL_INVALID');
    if (start >= session.seq) throw new RecallError(`range start ${start} does not exist yet (log has ${session.seq} events)`, 'RECALL_MISSING');
    const end = Math.min(requestedEnd, session.seq - 1);
    for (let seq = start; seq <= end; seq += 1) {
      const event = session.eventAt(seq);
      // A range skips log-only bookkeeping and duplicate tool/call records.
      if (event?.type !== 'tool/call' && renderEvent(event) !== null) events.push(event);
    }
    if (events.length === 0) throw new RecallError(`no recallable content in seq ${start}-${end}`, 'RECALL_EMPTY');
  }

  const sliced = request.grep !== undefined || request.head !== undefined || request.tail !== undefined;
  const parts = events.map((event) => {
    const item = renderEvent(event);
    if (!sliced) return `${item.header}\n${item.text}`;
    const { text, notes } = sliceText(item.text, request);
    return `${item.header} [${notes.join('; ')}]\n${text}`;
  });
  // A single unsliced item is byte-exact after its header line.
  const text = parts.join('\n\n');
  const { chunk, next, total } = page(text, offset, options.maxChars);
  const trailer = next === null ? '' : `\n\n[${total - next} more characters; call again with offset ${next}]`;
  return { text: chunk + trailer, events: events.length, seqs: events.map((event) => event.seq), nextOffset: next, totalChars: total };
}

/** Kinds accepted by the search `kind` filter. */
export const SEARCH_KINDS = Object.freeze(['user', 'assistant', 'tool', 'result', 'error', 'checkpoint', 'context']);

/**
 * Search the whole log for a literal (case-insensitive) substring or regex.
 * Optional filters: `kind` (see SEARCH_KINDS), `since` / `until` (inclusive seqs).
 * @returns {{ text: string, hits: number, total: number }}
 */
export function search(session, request, options) {
  const query = typeof request.query === 'string' ? request.query : '';
  if (query.trim().length === 0) throw new RecallError('query must be a non-empty string', 'SEARCH_INVALID');
  if (request.kind !== undefined && !SEARCH_KINDS.includes(request.kind)) throw new RecallError(`kind must be one of ${SEARCH_KINDS.join(', ')}`, 'SEARCH_INVALID');
  for (const key of ['since', 'until']) {
    if (request[key] !== undefined && (!Number.isSafeInteger(request[key]) || request[key] < 0)) throw new RecallError(`${key} must be a non-negative integer seq`, 'SEARCH_INVALID');
  }
  const since = request.since ?? 0;
  const until = Math.min(request.until ?? session.seq - 1, session.seq - 1);
  let test;
  if (request.regex === true) {
    let pattern;
    try {
      pattern = new RegExp(query, 'iu');
    } catch (error) {
      throw new RecallError(`invalid regular expression: ${error.message}`, 'SEARCH_INVALID');
    }
    test = (line) => pattern.test(line);
  } else {
    const needle = query.toLowerCase();
    test = (line) => line.toLowerCase().includes(needle);
  }
  const maxHits = options.maxHits;
  const hits = [];
  let total = 0;
  // Newest first: recent context is usually what the agent wants.
  for (let seq = until; seq >= since; seq -= 1) {
    const event = session.eventAt(seq);
    if (event?.type === 'tool/call' && request.kind !== 'tool') continue;
    if (event?.type === 'assistant/message' && request.kind === 'tool') continue;
    // Replacement copies duplicate an original; search the originals only.
    if (event?.type === 'tool/result' && typeof event.surfaceOp === 'object') continue;
    if (event?.type === 'user/message' && typeof event.surfaceOp === 'object') continue;
    const item = renderEvent(event);
    if (item === null) continue;
    if (request.kind !== undefined) {
      const kind = item.kind === 'result' && item.error ? 'error' : item.kind;
      if (!(kind === request.kind || (request.kind === 'result' && kind === 'error'))) continue;
    }
    const lines = item.text.split('\n');
    const matched = [];
    for (const line of lines) {
      if (test(line)) {
        const trimmed = line.trim();
        matched.push(trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed);
        if (matched.length >= 3) break;
      }
    }
    if (matched.length === 0) continue;
    total += 1;
    if (hits.length < maxHits) hits.push(`${item.header}\n  ${matched.join('\n  ')}`);
  }
  const text = hits.length === 0
    ? `No matches for ${JSON.stringify(query)}.`
    : `${total} matching events (newest first)${total > hits.length ? `, showing ${hits.length}` : ''}:\n\n${hits.join('\n\n')}`;
  return { text, hits: hits.length, total };
}
