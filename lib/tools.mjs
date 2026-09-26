/**
 * Model-facing `recall` / `recall_search` tools and the human-facing
 * `/recall` and `/hypercompact` commands.
 *
 * Tool names are configurable (`recallToolName`, `searchToolName`) because
 * `search` is a generic name that another plugin may already register.
 *
 * @module dsh-hypercompact/tools
 */

import { recall, search, RecallError, SEARCH_KINDS } from './recall.mjs';
import { pin } from './pins.mjs';
import { toolResultOfEvent } from './messages.mjs';
import { fmtBytes } from './engine.mjs';

export const DEFAULT_TOOL_NAMES = Object.freeze({ recall: 'recall', search: 'recall_search' });

const OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
};

/**
 * Pin what the model recalled so the next compaction keeps it at full length.
 * A tool result is shown on its CALL's checkpoint line, so the answered call
 * seq is pinned as well.
 */
function pinRecalled(session, seqs) {
  const all = new Set(seqs);
  for (const seq of seqs) {
    const event = session.eventAt(seq);
    if (event?.type !== 'tool/result') continue;
    const callId = toolResultOfEvent(event)?.toolCallId;
    for (let back = seq - 1; back >= 0 && back >= seq - 400; back -= 1) {
      const candidate = session.eventAt(back);
      if (candidate?.type === 'assistant/message' && (candidate.data?.message?.content ?? []).some((block) => block?.type === 'tool-call' && block.id === callId)) {
        all.add(back);
        break;
      }
    }
  }
  pin(session, all);
}

/**
 * Build the two tool definitions.
 * @param runtime - { defineTool, HarnessError }
 * @param config - resolved config.
 * @param names - { recall, search }.
 */
export function defineRecallTools(runtime, config, names) {
  const { defineTool, HarnessError } = runtime;
  const toHarness = (error) => (error instanceof RecallError ? new HarnessError(error.message, error.code, { cause: error }) : error);
  const sessionOf = (exec) => {
    const session = exec?.agent?.session;
    if (session === undefined) throw new HarnessError('recall requires a calling agent with a session', 'RECALL_AGENT_REQUIRED');
    return session;
  };

  const recallTool = defineTool({
    name: names.recall,
    description: [
      'Restore the exact original content of an earlier entry in THIS conversation from the append-only session log.',
      'Call it before acting on anything a compaction checkpoint shows cut, elided, or only as a (seq N) pointer — never guess cut content.',
      'Pass exactly one of: seq (one entry), result (the full output of the tool call at or answered at that seq), or range ("120-140").',
      'For a large output, pass grep (regex; returns matching lines with line numbers and context) or head/tail (characters) to fetch only the part you need.',
      'Long output is paginated: call again with the offset it reports.',
    ].join(' '),
    parameters: {
      seq: { type: 'integer', description: 'Seq of one log entry, e.g. 1234.' },
      result: { type: 'integer', description: 'Seq of a tool call or tool result; returns the original tool output.' },
      range: { type: 'string', description: 'Inclusive seq range such as "120-140" (max 200 seqs).' },
      grep: { type: 'string', description: 'Case-insensitive regex; return only matching lines (with line numbers) plus context.' },
      context: { type: 'integer', description: 'Lines of context around each grep match (0-20, default 2).' },
      head: { type: 'integer', description: 'Return only the first N characters.' },
      tail: { type: 'integer', description: 'Return only the last N characters (combine with head for both ends).' },
      offset: { type: 'integer', description: 'Character offset for the next page of a long recall.' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    execute(args, exec) {
      try {
        const session = sessionOf(exec);
        const recalled = recall(session, args, { maxChars: config.maxRecallChars });
        pinRecalled(session, recalled.seqs);
        return recalled.text;
      } catch (error) {
        throw toHarness(error);
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Recall history',
      kind: 'read',
      rawInput: `${args.seq !== undefined ? `seq ${args.seq}` : args.result !== undefined ? `result ${args.result}` : `range ${args.range ?? ''}`}${args.grep ? ` grep ${args.grep}` : ''}`,
    }),
  });

  const searchTool = defineTool({
    name: names.search,
    description: [
      'Search THIS conversation\'s full session log, including history replaced by compaction checkpoints.',
      'Returns matching entries newest first with their (seq N) pointers; restore any hit with the recall tool.',
      'Case-insensitive substring match by default; set regex=true for a regular expression.',
      `Filter with kind (${SEARCH_KINDS.join(', ')}) and since/until (inclusive seqs).`,
    ].join(' '),
    parameters: {
      query: { type: 'string', required: true, description: 'Text (or regex) to look for.' },
      regex: { type: 'boolean', description: 'Treat query as a regular expression.' },
      kind: { type: 'string', enum: [...SEARCH_KINDS], description: 'Only entries of this kind. "user" = what the human wrote; "error" = failed tool results.' },
      since: { type: 'integer', description: 'Only entries at or after this seq.' },
      until: { type: 'integer', description: 'Only entries at or before this seq.' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    execute(args, exec) {
      try {
        return search(sessionOf(exec), args, { maxHits: config.maxSearchHits }).text;
      } catch (error) {
        throw toHarness(error);
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Search history', kind: 'read', rawInput: args.query }),
  });

  return [recallTool, searchTool];
}

/** Characters of recalled text shown in the transcript by /recall. */
const COMMAND_RECALL_CHARS = 20_000;

/** Parse `/recall` input: `123`, `120-140`, or `result 123`. */
export function parseRecallCommand(raw) {
  const text = String(raw ?? '').trim();
  let match = /^result\s+(\d+)$/i.exec(text);
  if (match) return { result: Number(match[1]) };
  match = /^(\d+)\s*(?:-|–|\.\.)\s*(\d+)$/.exec(text);
  if (match) return { range: `${match[1]}-${match[2]}` };
  match = /^(?:seq\s+)?(\d+)$/i.exec(text);
  if (match) return { seq: Number(match[1]) };
  return null;
}

/** Render the /hypercompact status report. */
export function statusText(status) {
  const { policy, last } = status;
  const lines = [
    `Request now: ~${fmtBytes(status.bytes)} (${status.nodes} messages, ${status.images} inline images)${status.tokens === undefined ? '' : `, ~${status.tokens} tokens`}.`,
    `Trigger ${fmtBytes(policy.maxRequestBytes)} → target ${fmtBytes(policy.targetRequestBytes)}${policy.housekeepingBytes > 0 ? `; housekeeping from ${fmtBytes(policy.housekeepingBytes)}` : ''}.`,
  ];
  if (last === undefined) lines.push('No compaction in this session since dsh started.');
  else if (last.kind === 'housekeeping') {
    lines.push(`Last pass (${last.time}): housekeeping, ${fmtBytes(last.bytesBefore)} → ${fmtBytes(last.bytesAfter)}, ${last.imagesOffloaded} images offloaded, ${last.resultsTrimmed} old results trimmed.`);
  } else {
    lines.push(
      `Last compaction (${last.time}): ${last.reason}; seq ${last.span.start}–${last.span.end} (${last.span.nodes} messages) → checkpoint ${fmtBytes(last.checkpointBytes)}; `
      + `request ${fmtBytes(last.bytesBefore)} → ${fmtBytes(last.bytesAfter)}; degradation ${last.degradation}, ${last.entriesElided} entries elided, `
      + `${last.userMessages.length} user messages kept verbatim${last.userMessagesClipped.length ? ` (${last.userMessagesClipped.length} over the hard cap)` : ''}, ${last.imagesOffloaded} images offloaded.`,
    );
  }
  return lines.join('\n');
}

/**
 * Register `/recall` and `/hypercompact` on a commands-injected context.
 * @param ctx - context with `commands` and `compaction` (this engine).
 * @param config - resolved config.
 */
export function registerCommands(ctx, config, warn = () => {}) {
  const disposers = [];
  // A command name can already be taken (another preset mounting this plugin
  // into the same command layer, or another plugin). Commands are a
  // convenience: a failed registration is logged and skipped, and never
  // affects the engine or the tools.
  const register = (definition) => {
    try {
      disposers.push(ctx.commands.register(definition));
    } catch (error) {
      warn(`/${definition.name} not registered: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  register({
    name: 'recall',
    description: 'Show the original of an earlier conversation entry from the session log',
    input: { hint: '<seq> | <from>-<to> | result <seq>' },
    handler(invocation) {
      const request = parseRecallCommand(invocation.rawInput);
      if (request === null) return { kind: 'error', text: 'Usage: /recall <seq> | <from>-<to> | result <seq>' };
      try {
        const recalled = recall(invocation.agent.session, request, { maxChars: COMMAND_RECALL_CHARS });
        const more = recalled.nextOffset === null ? '' : '\n(Output truncated; ask the agent to recall the rest.)';
        return { kind: 'success', text: `${recalled.text.replace(/\n\n\[\d+ more characters; call again with offset \d+\]$/, '')}${more}` };
      } catch (error) {
        if (error instanceof RecallError) return { kind: 'error', text: error.message };
        throw error;
      }
    },
  });
  register({
    name: 'hypercompact',
    description: 'Show request size and the last dsh-hypercompact compaction for this session',
    handler(invocation) {
      const engine = ctx.compaction;
      if (typeof engine?.status !== 'function') return { kind: 'error', text: 'dsh-hypercompact is not the compaction engine of this preset.' };
      const text = statusText(engine.status(invocation.agent.session));
      return { kind: 'success', text: `${text}${config.statsLog ? `\nPer-compaction records: ${engine.stats.dir}` : ''}` };
    },
  });
  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* already unregistered */
      }
    }
  };
}
