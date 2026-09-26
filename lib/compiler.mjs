/**
 * Deterministic region compiler for dsh-hypercompact.
 *
 * Turns an ordered span of model-visible messages into one compact,
 * pointer-linked text checkpoint. It never calls a model and never
 * paraphrases: every line is original text (possibly cut) plus a `seq N`
 * pointer into the append-only session log, where `recall` finds the
 * byte-exact original.
 *
 * Layout of a checkpoint body:
 *   1. Pinned facts — user-message index, user constraints (verbatim), files
 *      touched. Never degraded.
 *   2. History — the span in order: human messages VERBATIM, assistant text,
 *      one line per tool call (read-only runs grouped), context messages.
 *   3. State of work — last edits, last commands, open errors, last request.
 *
 * Budget enforcement never touches human messages or pinned entries. It
 * degrades in fixed passes (drop success excerpts → shorten assistant text
 * to a floor → elide the oldest unprotected entries behind seq-range lines),
 * and if the budget still cannot be met it is exceeded (reported in stats)
 * rather than dropping what the user said.
 *
 * Dependency-free: messages are plain `{ role, content, source }` values.
 *
 * @module dsh-hypercompact/compiler
 */

import { utf8Bytes } from './bytes.mjs';
import { toolResultsOf, isCheckpointSource } from './messages.mjs';

export { isCheckpointSource };

export const CHECKPOINT_OPEN_TAG = '<hypercompact-checkpoint>';
export const CHECKPOINT_CLOSE_TAG = '</hypercompact-checkpoint>';

export const CHECKPOINT_PREAMBLE = [
  'This is an automatically generated checkpoint that replaces an earlier span of this conversation to keep the request small.',
  'It lists that span in order, with long content cut. Treat it as established background and continue the task from the messages that follow, without acknowledging this checkpoint.',
].join(' ');

/** Model-facing guide: how to restore elided content, and when it must. */
export function recallGuide(toolNames) {
  const recall = toolNames?.recall;
  const search = toolNames?.search;
  if (!recall) return 'Pointers like (seq N) refer to the original entries in the session log.';
  const searchPart = search ? ` \`${search}\` finds other earlier entries by keyword.` : '';
  return [
    `Pointers like (seq N) refer to original entries in the append-only session log. \`${recall}\` restores one exactly: {"seq": N}, or {"result": N} for the full output of a tool call (add "grep" to fetch only matching lines of a large output).${searchPart}`,
    `RULE: before editing a file, acting on a requirement, or answering about an earlier instruction whose content here is cut, elided, or only a pointer, call \`${recall}\` first. Never guess cut content.`,
  ].join('\n');
}

/** Argument fields shown first on a tool-call line, in priority order. */
const KEY_ARG_FIELDS = [
  'path', 'file_path', 'filePath', 'file', 'paths', 'files',
  'command', 'cmd', 'script',
  'query', 'queries', 'pattern', 'regex', 'glob', 'include',
  'url', 'urls',
  'name', 'id', 'pluginId', 'packageId', 'agent_id', 'job_id',
  'description', 'title', 'mode', 'action', 'workdir',
];
const KEY_ARG_RANK = new Map(KEY_ARG_FIELDS.map((field, index) => [field, index]));
const MAX_ARGS_PER_LINE = 4;

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Strip carriage returns, ANSI escapes, and control bytes. */
export function sanitize(text) {
  if (typeof text !== 'string') return '';
  let out = text;
  if (out.includes('\r')) out = out.replaceAll('\r', '');
  if (out.includes('\x1b')) out = out.replace(ANSI_RE, '');
  return out.replace(CTRL_RE, '');
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** First `limit` UTF-16 units without splitting a surrogate pair. */
export function headChars(text, limit) {
  if (limit <= 0) return '';
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  return isHighSurrogate(cut.charCodeAt(cut.length - 1)) ? cut.slice(0, -1) : cut;
}

/** Last `limit` UTF-16 units without splitting a surrogate pair. */
export function tailChars(text, limit) {
  if (limit <= 0) return '';
  if (text.length <= limit) return text;
  const cut = text.slice(text.length - limit);
  return isLowSurrogate(cut.charCodeAt(0)) ? cut.slice(1) : cut;
}

/** Cut text to `limit` chars (head only), with a marker naming what was cut. */
export function clip(text, limit, ref) {
  if (text.length <= limit) return text;
  const kept = headChars(text, limit).replace(/\s+$/u, '');
  return `${kept} …[cut ${formatBytes(utf8Bytes(text) - utf8Bytes(kept))}; ${ref}]`;
}

/**
 * Cut text to about `limit` chars keeping both ends (conclusions are often
 * at the end), with a marker in the middle naming what was cut.
 */
export function clipHeadTail(text, limit, ref, headShare = 0.6) {
  if (text.length <= limit) return text;
  const headLength = Math.floor(limit * headShare);
  const head = headChars(text, headLength).replace(/\s+$/u, '');
  const tail = tailChars(text, limit - headLength).replace(/^\s+/u, '');
  const cut = utf8Bytes(text) - utf8Bytes(head) - utf8Bytes(tail);
  return `${head}\n…[cut ${formatBytes(cut)} from the middle; ${ref}]…\n${tail}`;
}

/** Human-readable byte size. */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Collapse whitespace so a value fits on one line. */
export function oneLine(text) {
  return text.replace(/\s+/gu, ' ').trim();
}

/** Parse raw tool-call arguments; returns null when not a JSON object. */
export function parseArguments(raw) {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Render one argument value compactly, replacing large strings with their size. */
function renderArgValue(value, options) {
  if (typeof value === 'string') {
    const bytes = utf8Bytes(value);
    if (bytes > options.largeArgBytes) return `<${formatBytes(bytes)}>`;
    return JSON.stringify(headChars(oneLine(value), options.keyArgChars) + (value.length > options.keyArgChars ? '…' : ''));
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  const json = JSON.stringify(value) ?? '';
  const bytes = utf8Bytes(json);
  if (bytes > options.largeArgBytes) return `<${formatBytes(bytes)}>`;
  return headChars(oneLine(json), options.keyArgChars) + (json.length > options.keyArgChars ? '…' : '');
}

/**
 * Render the key arguments of one tool call.
 * @returns {string} e.g. `path="src/a.ts" content=<4.1 KB>`, or a size note.
 */
export function renderToolArgs(name, rawArguments, options) {
  const argBytes = typeof rawArguments === 'string' ? utf8Bytes(rawArguments) : utf8Bytes(JSON.stringify(rawArguments ?? {}) ?? '');
  const allowed = options.keyArgTools === null || options.keyArgTools.includes(name);
  const parsed = parseArguments(rawArguments);
  if (!allowed || parsed === null) return argBytes > 2 ? `args=<${formatBytes(argBytes)}>` : '';
  const keys = Object.keys(parsed).sort((left, right) => {
    const a = KEY_ARG_RANK.get(left) ?? KEY_ARG_FIELDS.length;
    const b = KEY_ARG_RANK.get(right) ?? KEY_ARG_FIELDS.length;
    return a - b;
  });
  const parts = [];
  for (const key of keys) {
    if (parts.length >= MAX_ARGS_PER_LINE) break;
    const value = parsed[key];
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) continue;
    parts.push(`${key}=${renderArgValue(value, options)}`);
  }
  if (keys.length > parts.length && argBytes > options.largeArgBytes) parts.push(`(args ${formatBytes(argBytes)})`);
  return parts.join(' ');
}

/** Join the text blocks of tool-result content (images become labels). */
export function toolResultText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

function mediaLabel(block) {
  const attachment = block.attachment ?? {};
  const bits = [block.type];
  if (typeof attachment.name === 'string') bits.push(JSON.stringify(headChars(attachment.name, 80)));
  if (Number.isFinite(attachment.width) && Number.isFinite(attachment.height)) bits.push(`${attachment.width}x${attachment.height}`);
  if (Number.isFinite(attachment.bytes)) bits.push(formatBytes(attachment.bytes));
  return `[${bits.join(' ')}]`;
}

/** Labels for the images/documents inside tool-result content. */
function resultMediaLabels(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block?.type === 'image' || block?.type === 'document').map(mediaLabel);
}

/** Head/tail excerpt of a tool result on one line. */
export function excerpt(text, head, tail) {
  const flat = oneLine(sanitize(text));
  if (flat.length === 0) return '';
  if (flat.length <= head + tail + 8) return JSON.stringify(flat);
  const start = headChars(flat, head);
  const end = tailChars(flat, tail);
  if (tail <= 0) return `${JSON.stringify(start)}…`;
  if (head <= 0) return `…${JSON.stringify(end)}`;
  return `${JSON.stringify(start)} … ${JSON.stringify(end)}`;
}



/**
 * User-role message sources whose text is an INSTRUCTION to this agent and
 * is therefore protected like human text (never cut by budget passes, never
 * elided, carried verbatim across compactions):
 *   - `user`          what the human typed (web UI input is also kind `user`);
 *   - `agent-message` a parent agent's task prompt relayed to a subagent —
 *                     for the subagent, the human's words;
 *   - `goal`          a `/goal` round prompt, embedding the goal the user wrote;
 *   - `team-message`  a message from a teammate agent.
 * Everything else (`plugin`, `skill-invocation`, `subagent-settled`,
 * `session-reference`, agent instructions, …) is trimmable context.
 */
export const INSTRUCTION_SOURCE_KINDS = Object.freeze(['user', 'agent-message', 'goal', 'team-message']);

/** Whether a user-role message source is a protected instruction (see above). */
export function isHumanSource(source) {
  return source === undefined || source === null || INSTRUCTION_SOURCE_KINDS.includes(source.kind);
}

/** Delimiter label for a protected instruction: `user` for human input, else its source kind. */
function instructionLabel(source) {
  return source === undefined || source === null || source.kind === 'user' ? 'user' : source.kind;
}

/** Short label for an injected-context message source. */
function contextLabel(source) {
  if (source?.kind === 'plugin' && typeof source.plugin === 'string') return source.plugin.replace(/^@deepseek-ai\//, '');
  return typeof source?.kind === 'string' ? source.kind : 'context';
}

/** Assistant text floor in degraded passes (conclusions and decisions live here). */
export const ASSISTANT_TEXT_FLOOR = 1000;
/** Harness-injected context floor in degraded passes. */
const CONTEXT_TEXT_FLOOR = 400;

/** Kinds that the budget passes may never cut or elide. */
const PROTECTED_KINDS = new Set(['user', 'checkpoint', 'marker']);

/** File-path argument fields, for the files-touched index. */
const PATH_FIELDS = ['path', 'file_path', 'filePath', 'file'];
/** Tools that change a file (exact names; `editor_view` is not a write). */
const WRITE_TOOLS = /^(write|write_file|edit|edit_file|multi_edit|multiedit|apply_patch|patch|str_replace|str_replace_editor|str_replace_based_edit_tool|create|create_file|notebook_edit|delete|delete_file|rm)$/i;

/** Sentences in human text that state a rule the agent must keep following. */
const CONSTRAINT_RE = /\b(never|do not|don't|dont|must not|mustn't|must|always|only|avoid|make sure|ensure|important|required?|no need to|stop|understood\?)\b/i;

/** Split human text into sentence-ish units, keeping them verbatim. */
function sentences(text) {
  return text.split(/(?<=[.!?])\s+|\n+/u).map((part) => part.trim()).filter((part) => part.length > 0);
}

/** Count added/removed lines implied by edit arguments (a 1-line diff summary). */
export function diffSummary(name, parsed) {
  if (parsed === null) return '';
  const lines = (value) => (typeof value === 'string' && value.length > 0 ? value.split('\n').length : 0);
  if (typeof parsed.old_string === 'string' || typeof parsed.new_string === 'string') {
    return `+${lines(parsed.new_string)}/−${lines(parsed.old_string)} lines`;
  }
  if (Array.isArray(parsed.edits)) {
    const added = parsed.edits.reduce((total, edit) => total + lines(edit?.new_string ?? edit?.newText), 0);
    const removed = parsed.edits.reduce((total, edit) => total + lines(edit?.old_string ?? edit?.oldText), 0);
    return `${parsed.edits.length} edits +${added}/−${removed} lines`;
  }
  if (typeof parsed.content === 'string' && WRITE_TOOLS.test(name)) return `${lines(parsed.content)} lines`;
  if (typeof parsed.patch === 'string' || typeof parsed.input === 'string') {
    const patch = parsed.patch ?? parsed.input;
    const added = patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
    const removed = patch.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
    return `+${added}/−${removed} lines`;
  }
  return '';
}

function pathOf(parsed) {
  if (parsed === null) return undefined;
  for (const field of PATH_FIELDS) if (typeof parsed[field] === 'string' && parsed[field].length > 0) return parsed[field];
  return undefined;
}

/**
 * Compile nodes into ordered entries (before budget enforcement), plus the
 * facts that feed the pinned and state-of-work blocks.
 * @param {{ seq: number, message: object | null, resultOrigin?: number }[]} nodes
 * @param {object} options - resolved compiler options (+ optional `pinnedSeqs`).
 * @returns {{ entries: object[], stats: object, facts: object }}
 */
export function compileEntries(nodes, options) {
  const entries = [];
  const pinnedSeqs = options.pinnedSeqs ?? new Set();
  const groupTools = new Set(options.groupTools ?? []);
  const stats = {
    nodes: nodes.length,
    userMessages: 0,
    assistantMessages: 0,
    contextMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    toolErrors: 0,
    groupedCalls: 0,
    media: 0,
    reasoningDropped: 0,
    checkpointsCarried: 0,
  };
  const facts = {
    users: [], // { seq, text }
    constraints: [], // { seq, text }
    files: new Map(), // path -> { lastSeq, writes, reads, lastWriteSeq }
    commands: [], // { seq, command, status }
    errors: [], // { seq, name, callSeq, resolvedBy? }
    carried: [], // { seq, text } earlier checkpoints' pinned/user lines
  };

  // Map each tool-call id to its result node, so the call line can carry
  // the result's status, size, excerpt, and pointer.
  const resultByCallId = new Map();
  for (const node of nodes) {
    for (const block of toolResultsOf(node.message)) resultByCallId.set(block.toolCallId, { node, block });
  }
  const renderedResultIds = new Set();
  let group = null; // open run of grouped read-only calls

  const closeGroup = () => {
    if (group === null) return;
    if (group.items.length === 1) entries.push(group.items[0].entry);
    else {
      stats.groupedCalls += group.items.length;
      const targets = group.items.map((item) => item.target).filter(Boolean);
      const unique = [...new Set(targets)];
      const shown = unique.slice(0, 8).map((target) => JSON.stringify(headChars(target, 80))).join(' ');
      const errors = group.items.filter((item) => item.error).length;
      entries.push({
        seq: group.items[0].seq,
        first: group.items[0].seq,
        last: group.items.at(-1).seq,
        kind: 'tool',
        line: `• ${group.name} ×${group.items.length}${shown ? `: ${shown}` : ''}${unique.length > 8 ? ` +${unique.length - 8} more` : ''} (seq ${group.items[0].seq}–${group.items.at(-1).seq}${errors ? `, ${errors} errors` : ''}; recall a seq for its result)`,
        excerpt: '',
      });
    }
    group = null;
  };

  const push = (entry) => {
    if (pinnedSeqs.has(entry.seq)) entry.pinned = true;
    entries.push(entry);
  };

  for (const node of nodes) {
    const message = node.message;
    if (message === null || message === undefined || !Array.isArray(message.content)) continue;
    const seq = node.seq;
    const ref = `seq ${seq}`;

    if (message.role === 'system' || message.role === 'developer') {
      closeGroup();
      const text = sanitize(message.content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n'));
      if (text.trim().length > 0) push({ seq, kind: 'context', label: `[${message.role} ${ref}]`, full: text });
      continue;
    }

    if (message.role === 'assistant') {
      stats.assistantMessages += 1;
      for (const block of message.content) {
        if (block?.type === 'text') {
          const text = sanitize(block.text ?? '').trim();
          if (text.length === 0) continue;
          closeGroup();
          push({ seq, kind: 'assistant', label: `[assistant ${ref}]`, full: text });
        } else if (block?.type === 'reasoning') {
          stats.reasoningDropped += 1;
        } else if (block?.type === 'tool-call') {
          stats.toolCalls += 1;
          const call = toolCall(seq, block, resultByCallId.get(block.id), options, stats, renderedResultIds, facts);
          if (pinnedSeqs.has(seq)) call.entry.pinned = true;
          if (groupTools.has(call.name) && !call.error && !call.entry.pinned) {
            if (group !== null && group.name !== call.name) closeGroup();
            group ??= { name: call.name, items: [] };
            group.items.push({ seq, target: call.target, error: call.error, entry: call.entry });
          } else {
            closeGroup();
            entries.push(call.entry);
          }
        } else if (block?.type === 'image' || block?.type === 'document') {
          closeGroup();
          stats.media += 1;
          push({ seq, kind: 'media', line: `[assistant ${ref}] ${mediaLabel(block)}` });
        }
      }
      continue;
    }

    // tool result (either format), checkpoint, human text, or injected context
    const results = toolResultsOf(message);
    if (results.length > 0) {
      for (const block of results) {
        stats.toolResults += 1;
        if (renderedResultIds.has(block.toolCallId)) continue;
        // A result whose call is outside this span (not expected with a
        // balanced cut) still gets its own line so nothing is silently lost.
        closeGroup();
        const text = toolResultText(block.content);
        const origin = node.resultOrigin ?? seq;
        const budget = block.isError ? options.toolErrorExcerpt : options.toolResultExcerpt;
        push({
          seq,
          kind: block.isError ? 'error' : 'result',
          line: `  ⤷ result (seq ${origin}) ${block.isError ? 'error' : 'ok'} ${formatBytes(utf8Bytes(text))}`,
          excerpt: excerpt(text, budget.head, budget.tail),
        });
      }
      continue;
    }
    closeGroup();
    if (isCheckpointSource(message.source)) {
      stats.checkpointsCarried += 1;
      const text = message.content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n');
      entries.push({ seq, kind: 'marker', line: `[earlier checkpoint seq ${seq} begins]` });
      for (const entry of carriedEntries(text, facts, seq)) entries.push(entry);
      entries.push({ seq, kind: 'marker', line: `[earlier checkpoint seq ${seq} ends]` });
      continue;
    }
    const human = isHumanSource(message.source);
    let text = '';
    for (const block of message.content) {
      if (block?.type === 'text') text += (text ? '\n' : '') + sanitize(block.text ?? '');
      else if (block?.type === 'image' || block?.type === 'document') {
        stats.media += 1;
        push({ seq, kind: 'media', line: `[${human ? instructionLabel(message.source) : contextLabel(message.source)} ${ref}] ${mediaLabel(block)}` });
      }
    }
    // Human text is kept exactly (no trim); injected context is trimmed.
    if (text.trim().length === 0) continue;
    if (!human) text = text.trim();
    if (human) {
      stats.userMessages += 1;
      const label = instructionLabel(message.source);
      facts.users.push({ seq, text, label });
      for (const sentence of sentences(text)) if (CONSTRAINT_RE.test(sentence)) facts.constraints.push({ seq, text: sentence });
      push({ seq, kind: 'user', label, full: text });
    } else {
      stats.contextMessages += 1;
      push({ seq, kind: 'context', label: `[${contextLabel(message.source)} ${ref}]`, full: text });
    }
  }
  closeGroup();
  return { entries, stats, facts };
}

function toolCall(seq, block, result, options, stats, renderedResultIds, facts) {
  const name = typeof block.name === 'string' && block.name.length > 0 ? block.name : 'unknown';
  const parsed = parseArguments(block.arguments);
  const args = renderToolArgs(name, block.arguments, options);
  const target = pathOf(parsed) ?? (typeof parsed?.command === 'string' ? oneLine(parsed.command) : undefined)
    ?? (typeof parsed?.pattern === 'string' ? parsed.pattern : undefined) ?? (typeof parsed?.query === 'string' ? parsed.query : undefined)
    ?? (typeof parsed?.url === 'string' ? parsed.url : undefined);
  const diff = diffSummary(name, parsed);
  let status = '→ no result in span';
  let excerptText = '';
  let error = false;
  let resultSeq;
  if (result !== undefined) {
    renderedResultIds.add(block.id);
    const text = toolResultText(result.block.content);
    const media = resultMediaLabels(result.block.content);
    if (media.length > 0) stats.media += media.length;
    resultSeq = result.node.resultOrigin ?? result.node.seq;
    error = result.block.isError === true;
    if (error) stats.toolErrors += 1;
    status = `→ result ${resultSeq} ${error ? 'ERROR' : 'ok'} ${formatBytes(utf8Bytes(text))}${media.length > 0 ? ` ${media.join(' ')}` : ''}`;
    const budget = error ? options.toolErrorExcerpt : options.toolResultExcerpt;
    excerptText = excerpt(text, budget.head, budget.tail);
  }

  // Facts for the pinned and state blocks.
  const path = pathOf(parsed);
  if (path !== undefined) {
    const file = facts.files.get(path) ?? { reads: 0, writes: 0, lastSeq: seq, lastWriteSeq: undefined, diff: '' };
    file.lastSeq = seq;
    if (WRITE_TOOLS.test(name)) {
      file.writes += 1;
      file.lastWriteSeq = seq;
      file.diff = diff;
    } else file.reads += 1;
    facts.files.set(path, file);
  }
  if (typeof parsed?.command === 'string') facts.commands.push({ seq, command: oneLine(parsed.command), status: result === undefined ? 'no result' : error ? 'ERROR' : 'ok' });
  if (error) facts.errors.push({ seq, name, target: path ?? target, resultSeq });
  else if (result !== undefined) {
    // A later success of the same tool on the same target resolves an earlier error.
    for (const open of facts.errors) if (open.resolvedBy === undefined && open.name === name && open.target === (path ?? target)) open.resolvedBy = seq;
  }

  return {
    name,
    target,
    error,
    entry: {
      seq,
      kind: error ? 'error' : 'tool',
      line: `• ${name}${args ? ` ${args}` : ''}${diff ? ` [${diff}]` : ''} (seq ${seq} ${status})`,
      excerpt: excerptText,
    },
  };
}

/** Merge an earlier checkpoint's files-changed list into the facts (older than this span). */
function carryFiles(line, facts) {
  const re = /("(?:[^"\\]|\\.)*") \(last write seq (\d+)(?:, ([^)]*))?\)/g;
  for (const match of line.matchAll(re)) {
    let path;
    try {
      path = JSON.parse(match[1]);
    } catch {
      continue;
    }
    if (facts.files.has(path)) continue;
    const seq = Number(match[2]);
    facts.files.set(path, { reads: 0, writes: 1, lastSeq: seq, lastWriteSeq: seq, diff: match[3] ?? '' });
  }
}

/** Delimiters that make protected instruction text unambiguous inside a checkpoint. */
function userOpen(seq, label = 'user') {
  return `[${label} seq ${seq}]`;
}
function userClose(seq, label = 'user') {
  return `[/${label} seq ${seq}]`;
}
const USER_OPEN_RE = new RegExp(`^\\[(${INSTRUCTION_SOURCE_KINDS.join('|')}) seq (\\d+)\\]$`);
/** Lines that start a new entry when a carried checkpoint is re-parsed. */
const ENTRY_START_RE = /^(\[(assistant|system|context|\S+) seq \d+\]|\[[^\]]* seq \d+\]|• |  ⤷ |\[\d+ entries elided|\[earlier checkpoint)/;

/**
 * Re-parse an earlier checkpoint into entries, so a later compaction treats
 * it like fresh history: human blocks stay protected and verbatim (with
 * their original seq), everything else becomes elidable, and the old pinned
 * lines are merged into the new pinned block. This keeps repeated
 * compactions bounded without ever dropping what the user said.
 */
function carriedEntries(text, facts, checkpointSeq) {
  let body = text;
  const open = body.indexOf(CHECKPOINT_OPEN_TAG);
  const close = body.lastIndexOf(CHECKPOINT_CLOSE_TAG);
  if (open !== -1 && close > open) body = body.slice(open + CHECKPOINT_OPEN_TAG.length, close);
  else {
    // A checkpoint from another backend (e.g. compaction-basic): carry it
    // whole and protected; its structure is unknown.
    return [{ seq: checkpointSeq, kind: 'checkpoint', full: body.trim() }];
  }
  const lines = body.split('\n');
  const entries = [];
  let section = 'history';
  let current = null;
  const flush = () => {
    if (current !== null && current.full.trim().length > 0) entries.push(current);
    current = null;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === PINNED_OPEN) { flush(); section = 'pinned'; continue; }
    if (line === STATE_OPEN) { flush(); section = 'state'; continue; }
    if (line === PINNED_CLOSE || line === STATE_CLOSE) { section = 'history'; continue; }
    if (line === HISTORY_HEADING) continue;
    if (section === 'pinned') {
      if (PINNED_INDEX_RE.test(line) || /^- constraint seq \d+:/.test(line)) facts.carried.push({ seq: checkpointSeq, text: line });
      else if (line.startsWith('- files changed')) carryFiles(line, facts);
      continue;
    }
    if (section === 'state') continue; // stale by definition
    const userMatch = USER_OPEN_RE.exec(line);
    if (userMatch) {
      flush();
      const label = userMatch[1];
      const userSeq = Number(userMatch[2]);
      const closeLine = userClose(userSeq, label);
      const closeIndex = lines.indexOf(closeLine, index + 1);
      const endIndex = closeIndex === -1 ? lines.length : closeIndex;
      entries.push({ seq: userSeq, kind: 'user', label, full: lines.slice(index + 1, endIndex).join('\n'), carried: true });
      index = endIndex;
      continue;
    }
    if (ENTRY_START_RE.test(line) || current === null) {
      flush();
      const seqMatch = /seq (\d+)/.exec(line);
      const rangeMatch = /seq (\d+)–(\d+)/.exec(line);
      const seq = seqMatch ? Number(seqMatch[1]) : checkpointSeq;
      current = { seq, first: rangeMatch ? Number(rangeMatch[1]) : seq, last: rangeMatch ? Number(rangeMatch[2]) : seq, kind: 'carried', full: line };
    } else {
      current.full += `\n${line}`;
    }
  }
  flush();
  return entries;
}

const PINNED_OPEN = '## Pinned (user messages, constraints, files — never cut)';
const HISTORY_HEADING = '## History';
const PINNED_CLOSE = '## End pinned';
const STATE_OPEN = '## State of work at this checkpoint';
const STATE_CLOSE = '## End state';

const MAX_PINNED_FILES = 20;
/** User-index lines kept when the pinned block is over its cap. */
export const PINNED_INDEX_KEEP = 40;
/** A pinned user-index line (`- user seq N: …`, or another instruction kind). */
const PINNED_INDEX_RE = new RegExp(`^- (${INSTRUCTION_SOURCE_KINDS.join('|')}) seq (\\d+):`);

/**
 * Build the pinned block: instruction index, constraints (verbatim), files
 * changed. When over `capBytes`, trim in order of least value: the index
 * first (its full text is verbatim in History and its seqs are in the
 * header) down to the newest PINNED_INDEX_KEEP lines plus one summary line,
 * then the files list, and constraints last (oldest first).
 */
export function pinnedBlock(facts, capBytes) {
  const seen = new Set();
  const index = [];
  const constraints = [];
  const add = (list, line) => {
    if (seen.has(line)) return;
    seen.add(line);
    list.push(line);
  };
  for (const item of facts.carried) add(PINNED_INDEX_RE.test(item.text) ? index : constraints, item.text);
  for (const user of facts.users) {
    const first = oneLine(user.text.split('\n').find((line) => line.trim().length > 0) ?? '');
    add(index, `- ${user.label ?? 'user'} seq ${user.seq}: ${JSON.stringify(headChars(first, 160) + (first.length > 160 ? '…' : ''))}`);
  }
  for (const constraint of facts.constraints) add(constraints, `- constraint seq ${constraint.seq}: ${JSON.stringify(constraint.text)}`);
  const files = [...facts.files.entries()].filter(([, file]) => file.writes > 0).sort((a, b) => b[1].lastWriteSeq - a[1].lastWriteSeq);
  let filesLine = null;
  if (files.length > 0) {
    const shown = files.slice(0, MAX_PINNED_FILES).map(([path, file]) => `${JSON.stringify(path)} (last write seq ${file.lastWriteSeq}${file.diff ? `, ${file.diff}` : ''})`);
    filesLine = `- files changed (newest first): ${shown.join(', ')}${files.length > MAX_PINNED_FILES ? `, +${files.length - MAX_PINNED_FILES} more (recall_search to find them)` : ''}`;
  }

  const render = (indexLines, fileLine, constraintLines, note) => [
    PINNED_OPEN, ...indexLines, ...constraintLines, ...(fileLine ? [fileLine] : []), ...(note ? [note] : []), PINNED_CLOSE,
  ].join('\n');
  let text = render(index, filesLine, constraints);
  if (utf8Bytes(text) <= capBytes) return text;

  // 1. Trim the instruction index to its newest lines plus one summary line.
  let indexLines = index;
  if (index.length > PINNED_INDEX_KEEP) {
    const older = index.slice(0, index.length - PINNED_INDEX_KEEP);
    const seqs = older.map((line) => Number(PINNED_INDEX_RE.exec(line)?.[2])).filter(Number.isFinite);
    const range = seqs.length > 0 ? `seq ${Math.min(...seqs)}–${Math.max(...seqs)}` : 'earlier seqs';
    indexLines = [`- ${older.length} older user messages: ${range}, verbatim in history`, ...index.slice(-PINNED_INDEX_KEEP)];
  }
  text = render(indexLines, filesLine, constraints);
  if (utf8Bytes(text) <= capBytes) return text;
  // 2. Drop the files list.
  const note = '- (some pinned lines omitted to fit; use recall_search)';
  text = render(indexLines, null, constraints, note);
  if (utf8Bytes(text) <= capBytes) return text;
  // 3. Drop the oldest constraints.
  let kept = constraints;
  while (kept.length > 0 && utf8Bytes(render(indexLines, null, kept, note)) > capBytes) kept = kept.slice(1);
  return render(indexLines, null, kept, note);
}

/** Build the state-of-work block (placed last, right before the retained turns). */
export function stateBlock(facts) {
  const lines = [STATE_OPEN];
  const edited = [...facts.files.entries()].filter(([, file]) => file.writes > 0).sort((a, b) => b[1].lastWriteSeq - a[1].lastWriteSeq).slice(0, 8);
  if (edited.length > 0) lines.push(`- last files edited: ${edited.map(([path, file]) => `${JSON.stringify(path)} (seq ${file.lastWriteSeq})`).join(', ')}`);
  const commands = facts.commands.slice(-5);
  for (const command of commands) lines.push(`- ran seq ${command.seq}: ${JSON.stringify(headChars(command.command, 160))} → ${command.status}`);
  const open = facts.errors.filter((error) => error.resolvedBy === undefined).slice(-5);
  for (const error of open) lines.push(`- unresolved error: ${error.name}${error.target ? ` ${JSON.stringify(headChars(String(error.target), 120))}` : ''} (seq ${error.seq}${error.resultSeq !== undefined ? `, result ${error.resultSeq}` : ''})`);
  const last = facts.users.at(-1);
  if (last !== undefined) lines.push(`- last user request in this span: seq ${last.seq} (verbatim above)`);
  if (lines.length === 1) return '';
  lines.push(STATE_CLOSE);
  return lines.join('\n');
}

/** Render entries under one set of per-kind limits. */
function renderEntries(entries, limits) {
  const lines = [];
  for (const entry of entries) {
    const recallRef = `recall seq ${entry.seq}`;
    switch (entry.kind) {
      case 'elision':
        lines.push(entry.line);
        break;
      case 'user':
        // Human text is never cut by budget passes; only a single pathological
        // paste above the hard cap is reduced to head + tail with a pointer.
        // Carried blocks were already capped when first compiled.
        lines.push(userOpen(entry.seq, entry.label), entry.carried ? entry.full : clipHeadTail(entry.full, limits.userTextChars, recallRef, 0.7), userClose(entry.seq, entry.label));
        break;
      case 'carried':
        // Excerpt continuation lines drop in the same pass as fresh excerpts.
        lines.push(limits.excerpts ? entry.full : entry.full.split('\n').filter((line) => !line.startsWith('    "') && !line.startsWith('    …"')).join('\n'));
        break;
      case 'marker':
        lines.push(entry.line);
        break;
      case 'assistant':
        lines.push(`${entry.label} ${entry.pinned ? entry.full : clipHeadTail(entry.full, limits.assistantTextChars, recallRef)}`);
        break;
      case 'context':
        lines.push(`${entry.label} ${entry.pinned ? entry.full : clip(entry.full, limits.contextTextChars, recallRef)}`);
        break;
      case 'checkpoint':
        lines.push(`[earlier checkpoint seq ${entry.seq} (other engine)]\n${entry.full}`);
        break;
      case 'error':
        lines.push(entry.excerpt ? `${entry.line}\n    ${entry.excerpt}` : entry.line);
        break;
      default:
        lines.push((limits.excerpts || entry.pinned) && entry.excerpt ? `${entry.line}\n    ${entry.excerpt}` : entry.line);
    }
  }
  return lines.join('\n');
}

/** Whether budget elision may drop an entry. */
function elidable(entry) {
  return !PROTECTED_KINDS.has(entry.kind) && entry.kind !== 'elision' && entry.pinned !== true;
}

/**
 * Elide the oldest `count` elidable entries. Protected entries (human text,
 * carried checkpoints, pinned) stay in place; each run of dropped entries
 * becomes one line naming its seq range.
 */
function elideOldest(entries, count) {
  if (count <= 0) return entries;
  const out = [];
  let remaining = count;
  let run = null;
  const flush = () => {
    if (run === null) return;
    out.push({ kind: 'elision', line: `[${run.count} entries elided, seq ${run.first}–${run.last}; use recall or search to restore]` });
    run = null;
  };
  for (const entry of entries) {
    if (remaining > 0 && elidable(entry)) {
      remaining -= 1;
      const first = entry.first ?? entry.seq;
      const last = entry.last ?? entry.seq;
      if (run === null) run = { count: 0, first, last };
      run.count += 1;
      run.first = Math.min(run.first, first);
      run.last = Math.max(run.last, last);
      continue;
    }
    flush();
    out.push(entry);
  }
  flush();
  return out;
}

/**
 * Compile nodes into one checkpoint that fits `budgetBytes` when possible.
 * Protected content (human text, carried checkpoints, pinned entries, the
 * pinned and state blocks) is never degraded; if it alone exceeds the budget,
 * the budget is exceeded and `stats.overBudget` reports by how much.
 * @param {{ seq: number, message: object | null }[]} nodes - ordered span.
 * @param {object} options - resolved config plus `toolNames` and optional `pinnedSeqs`.
 * @param {number} budgetBytes - target maximum UTF-8 bytes of the framed checkpoint.
 * @returns {{ body: string, framed: string, bytes: number, stats: object }}
 */
export function compileCheckpoint(nodes, options, budgetBytes) {
  const { entries: raw, stats, facts } = compileEntries(nodes, options);
  const first = nodes[0]?.seq;
  const last = nodes.at(-1)?.seq;
  const userSeqs = [...new Set(raw.filter((entry) => entry.kind === 'user').map((entry) => entry.seq))].sort((a, b) => a - b);
  const header = [
    CHECKPOINT_PREAMBLE,
    recallGuide(options.toolNames),
    `Span: seq ${first}–${last}, ${nodes.length} entries. User messages (each verbatim below between [user seq N] and [/user seq N]): ${userSeqs.length > 0 ? userSeqs.join(', ') : 'none'}.`,
  ].join('\n');
  const pinned = pinnedBlock(facts, options.pinnedBytes ?? 30_000);
  const state = stateBlock(facts);
  const frame = (history) => `${header}\n${CHECKPOINT_OPEN_TAG}\n${pinned}\n${HISTORY_HEADING}\n${history}${state ? `\n${state}` : ''}\n${CHECKPOINT_CLOSE_TAG}`;

  const userCap = options.userTextChars;
  const assistantFloor = Math.min(options.assistantTextChars, ASSISTANT_TEXT_FLOOR);
  const passes = [
    { excerpts: true, userTextChars: userCap, assistantTextChars: options.assistantTextChars, contextTextChars: 4000 },
    { excerpts: false, userTextChars: userCap, assistantTextChars: options.assistantTextChars, contextTextChars: 2000 },
    { excerpts: false, userTextChars: userCap, assistantTextChars: assistantFloor, contextTextChars: CONTEXT_TEXT_FLOOR },
  ];

  let entries = raw;
  let limits = passes[0];
  let framed = '';
  let degradation = 0;
  for (const [index, pass] of passes.entries()) {
    limits = pass;
    framed = frame(renderEntries(entries, limits));
    degradation = index;
    if (utf8Bytes(framed) <= budgetBytes) break;
  }

  const elidableCount = entries.filter(elidable).length;
  if (utf8Bytes(framed) > budgetBytes && elidableCount > 0) {
    // Binary-search the smallest number of oldest elidable entries to drop.
    let low = 1;
    let high = elidableCount;
    let best = elidableCount;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (utf8Bytes(frame(renderEntries(elideOldest(entries, mid), limits))) <= budgetBytes) {
        best = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    entries = elideOldest(entries, best);
    framed = frame(renderEntries(entries, limits));
    stats.entriesElided = best;
    degradation = passes.length;
  }

  const bytes = utf8Bytes(framed);
  stats.degradation = degradation;
  stats.userSeqs = userSeqs;
  stats.userClipped = facts.users.filter((user) => user.text.length > userCap).map((user) => user.seq);
  stats.constraints = facts.constraints.length;
  stats.overBudget = Math.max(0, bytes - budgetBytes);
  return { body: framed.slice(framed.indexOf(CHECKPOINT_OPEN_TAG)), framed, bytes, stats };
}
