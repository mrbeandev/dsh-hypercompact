/**
 * Synthetic session builder for tests. Produces events in the exact v3 log
 * shape (turn/start, user/message, assistant/message with tool calls,
 * tool/result) without any private data.
 *
 * Two tool-result formats exist across dsh releases:
 *   - `v1` (dsh 0.1.5): a user-role message wrapping one `tool-result` block;
 *   - `v2` (dsh 0.1.7): a tool-role message with top-level toolCallId/isError.
 * The default comes from HC_FORMAT (set by `npm test` for its second pass).
 */

import { toolResultsOf } from '../lib/messages.mjs';

export const FORMAT = process.env.HC_FORMAT === 'v2' ? 'v2' : 'v1';

/** Build one tool-result message in the requested format. */
export function toolResultMessage(id, content, { isError = false, format = FORMAT, messageId = `r${id}` } = {}) {
  if (format === 'v2') return { role: 'tool', source: { kind: 'tool', callId: id }, toolCallId: id, isError, content, id: messageId };
  return { role: 'user', source: { kind: 'tool', callId: id }, content: [{ type: 'tool-result', toolCallId: id, content, isError }], id: messageId };
}

/** The result content blocks of a tool-result message, in either format. */
export function resultContent(message) {
  return toolResultsOf(message)[0]?.content ?? [];
}

/** The joined result text of a tool/result event, in either format. */
export function resultText(event) {
  return resultContent(event.data.message).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
}

/** Replace the result content of a tool/result event in place (fixtures only). */
export function setResultContent(event, content) {
  const message = event.data.message;
  if (message.role === 'tool') message.content = content;
  else message.content[0].content = content;
}

/** Mark a tool/result event as failed (fixtures only). */
export function setResultError(event) {
  const message = event.data.message;
  if (message.role === 'tool') message.isError = true;
  else message.content[0].isError = true;
}

export function buildEvents({ turns = 6, callsPerTurn = 3, resultChars = 4000, argChars = 60, withImageEvery = 0, format = FORMAT } = {}) {
  const events = [];
  const push = (type, data, extra = {}) => {
    const event = { type, seq: events.length, time: 1_700_000_000_000 + events.length, data, ...extra };
    events.push(event);
    return event;
  };
  push('system/message', { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'You are a test agent.' }], source: format === 'v2' ? { kind: 'system-prompt' } : { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }, id: 'sys' } }, { surfaceOp: 'append' });
  let imageCount = 0;
  for (let turn = 1; turn <= turns; turn += 1) {
    push('turn/start', { turn });
    push('user/message', { role: 'user', content: [{ type: 'text', text: `Turn ${turn}: please work on task ${turn}.` }], source: { kind: 'user' }, id: `u${turn}` }, { surfaceOp: 'append' });
    for (let step = 1; step <= callsPerTurn; step += 1) {
      push('step/start', { turn, step });
      const id = `call_${turn}_${step}`;
      const args = JSON.stringify({ path: `src/file_${turn}_${step}.js`, content: 'x'.repeat(argChars) });
      push('assistant/message', {
        turn, step,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'thinking about it' },
            { type: 'text', text: `Working on step ${step} of turn ${turn}.` },
            { type: 'tool-call', id, name: step % 2 ? 'write' : 'bash', arguments: args },
          ],
          source: { kind: 'model', provider: 'p', model: 'm' },
          id: `a${turn}_${step}`,
        },
        stream: [],
      }, { surfaceOp: 'append' });
      const assistantSeq = events.length - 1;
      push('tool/call', { turn, step, callId: id, name: 'write', arguments: args });
      const content = [{ type: 'text', text: `RESULT-${turn}-${step} ` + 'r'.repeat(resultChars) + ` END-${turn}-${step}` }];
      if (withImageEvery > 0 && (++imageCount % withImageEvery === 0)) {
        content.push({ type: 'image', attachment: { attachmentId: `sha256:${'0'.repeat(63)}${imageCount % 10}`, mediaType: 'image/png', bytes: 300_000, width: 1280, height: 800, name: `shot-${imageCount}.png` } });
      }
      push('tool/result', {
        turn, step,
        message: toolResultMessage(id, content, { format, messageId: `r${turn}_${step}` }),
      }, { surfaceOp: 'append', sourceEventSeqs: [assistantSeq + 1] });
      push('step/end', { turn, step });
    }
    push('assistant/message', {
      turn, step: callsPerTurn + 1,
      message: { role: 'assistant', content: [{ type: 'text', text: `Done with turn ${turn}.` }], source: { kind: 'model', provider: 'p', model: 'm' }, id: `af${turn}` },
      stream: [],
    }, { surfaceOp: 'append' });
    push('turn/end', { turn, reason: { kind: 'completed' } });
  }
  push('request/header', { header: { config: { provider: 'p', model: 'm' }, tools: [{ name: 'write', description: 'write a file', parameters: { type: 'object' } }] }, reason: 'initial' });
  return events;
}

/**
 * Minimal session over a static event list for pure-module tests: exposes
 * `seq`, `eventAt`, `surface.nodes`, `deriveEventMessage`, `requestHeader`.
 */
export function fakeSession(events) {
  const nodes = [];
  for (const event of events) {
    if (event.surfaceOp === 'append') nodes.push(event.seq);
    else if (event.surfaceOp && typeof event.surfaceOp === 'object') {
      const start = nodes.indexOf(event.surfaceOp.startSeq);
      const end = nodes.indexOf(event.surfaceOp.endSeq);
      nodes.splice(start, end - start + 1, event.seq);
    }
  }
  const header = [...events].reverse().find((event) => event.type === 'request/header')?.data.header;
  return {
    seq: events.length,
    eventAt: (seq) => events[seq],
    surface: { nodes, replaceGeneration: 0 },
    deriveEventMessage(event) {
      if (event.type === 'user/message') return event.data;
      if (event.type === 'tool/result' || event.type === 'assistant/message' || event.type === 'system/message') return event.data.message;
      return null;
    },
    requestHeader: () => header,
  };
}
