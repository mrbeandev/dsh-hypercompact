import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig, resolvePolicy, DEFAULTS } from '../lib/config.mjs';
import { utf8Bytes, base64Bytes, messageBytes } from '../lib/bytes.mjs';
import { compileCheckpoint, renderToolArgs, excerpt, headChars, tailChars, CHECKPOINT_OPEN_TAG } from '../lib/compiler.mjs';
import { selectRange, balancedCuts, requestBytes } from '../lib/select.mjs';
import { SurfaceIndex } from '../lib/surface.mjs';
import { recall, search, findOriginalResult, RecallError } from '../lib/recall.mjs';
import { planImageOffload, offloadedResultMessage } from '../lib/images.mjs';
import { buildEvents, fakeSession, FORMAT, toolResultMessage, resultContent, resultText, setResultContent, setResultError } from './helpers.mjs';

// ── config ──────────────────────────────────────────────────────────────────

test('config: defaults and hysteresis', () => {
  const config = resolveConfig();
  assert.equal(config.maxRequestBytes, 5_000_000);
  assert.equal(config.targetRequestBytes, 1_500_000);
  assert.throws(() => resolveConfig({ maxRequestBytes: 1000, targetRequestBytes: 1000 }), /must be less than/);
});

test('config: rejects unknown and malformed keys', () => {
  assert.throws(() => resolveConfig({ maxRequestByte: 1 }), /unknown key "maxRequestByte"/);
  assert.throws(() => resolveConfig({ retainTurns: -1 }), /non-negative/);
  assert.throws(() => resolveConfig({ toolResultExcerpt: { head: 1, middle: 2 } }), /unknown key "middle"/);
  assert.throws(() => resolveConfig({ keyArgTools: 'read' }), /keyArgTools/);
  assert.throws(() => resolveConfig({ contextRatio: 2 }), /contextRatio/);
});

test('config: modelPolicies override per exact route and validate hysteresis', () => {
  const config = resolveConfig({ modelPolicies: [{ provider: 'p', model: 'small', maxRequestBytes: 2_000_000, targetRequestBytes: 800_000 }] });
  assert.equal(resolvePolicy(config, { provider: 'p', model: 'small' }).maxRequestBytes, 2_000_000);
  assert.equal(resolvePolicy(config, { provider: 'p', model: 'other' }).maxRequestBytes, DEFAULTS.maxRequestBytes);
  assert.throws(() => resolveConfig({ modelPolicies: [{ provider: 'p', model: 'm', maxRequestBytes: 1_000_000 }] }), /targetRequestBytes/);
  assert.throws(() => resolveConfig({ modelPolicies: [{ provider: 'p', model: 'm' }, { provider: 'p', model: 'm' }] }), /duplicate/);
});

// ── bytes ───────────────────────────────────────────────────────────────────

test('bytes: utf8 and base64 sizing', () => {
  assert.equal(utf8Bytes('abc'), 3);
  assert.equal(utf8Bytes('é'), 2);
  assert.equal(utf8Bytes('😀'), 4);
  assert.equal(base64Bytes(3), 4);
  assert.equal(base64Bytes(4), 8);
  const withImage = toolResultMessage('a', [{ type: 'image', attachment: { bytes: 300_000 } }]);
  assert.ok(messageBytes(withImage) > 400_000, 'image priced as inline base64');
  const offloaded = toolResultMessage('a', [{ type: 'image', attachment: { bytes: 300_000 }, offloaded: true }]);
  assert.ok(messageBytes(offloaded) < 2_000, 'durably offloaded image is a bounded text placeholder, not uploaded base64');
});

// ── compiler ────────────────────────────────────────────────────────────────

test('compiler: surrogate-safe slicing', () => {
  assert.equal(headChars('a😀b', 2), 'a');
  assert.equal(tailChars('a😀b', 2), 'b');
});

test('compiler: tool args show key fields and size large payloads', () => {
  const options = { keyArgTools: null, keyArgChars: 40, largeArgBytes: 100 };
  const line = renderToolArgs('write', JSON.stringify({ content: 'x'.repeat(5000), path: 'src/a.js' }), options);
  assert.match(line, /^path="src\/a.js" content=<4\.9 KB>/);
  assert.match(renderToolArgs('bash', '{not json', options), /args=<9 B>/);
  assert.equal(renderToolArgs('secret', JSON.stringify({ path: 'x' }), { ...options, keyArgTools: ['read'] }), 'args=<12 B>');
});

test('compiler: excerpt keeps head and tail', () => {
  const text = `HEAD${'m'.repeat(1000)}TAIL`;
  const out = excerpt(text, 10, 10);
  assert.match(out, /^"HEADm+" … "m+TAIL"$/);
  assert.equal(excerpt('short', 10, 10), '"short"');
});

test('compiler: checkpoint has pointers, drops reasoning, fits budget', () => {
  const session = fakeSession(buildEvents({ turns: 4, callsPerTurn: 3 }));
  const index = new SurfaceIndex();
  const view = index.view(session);
  const nodes = view.nodes.slice(1); // skip system
  const options = { ...resolveConfig(), toolNames: { recall: 'recall', search: 'recall_search' } };
  const { framed, bytes, stats } = compileCheckpoint(nodes, options, 200_000);
  assert.ok(framed.includes(CHECKPOINT_OPEN_TAG));
  assert.match(framed, /• write path="src\/file_1_1\.js" content="x+" \[1 lines\] \(seq \d+ → result \d+ ok/);
  assert.ok(!framed.includes('thinking about it'), 'reasoning is not carried');
  assert.ok(framed.includes('RESULT-1-1'), 'result head excerpt present');
  assert.ok(framed.includes('END-1-1'), 'result tail excerpt present');
  assert.ok(framed.includes('`recall` restores one exactly'), 'recall guide present');
  assert.equal(stats.toolCalls, 12);
  assert.ok(bytes <= 200_000);
});

test('compiler: degrades deterministically under a tight budget, never below protected content', () => {
  const session = fakeSession(buildEvents({ turns: 30, callsPerTurn: 4 }));
  const nodes = new SurfaceIndex().view(session).nodes.slice(1);
  const options = { ...resolveConfig(), toolNames: {} };
  const small = compileCheckpoint(nodes, options, 6000);
  assert.match(small.body, /\d+ entries elided, seq \d+–\d+/);
  assert.equal(small.stats.degradation, 3);
  // 30 verbatim user messages + the pinned index cannot fit 6 KB: the budget
  // is exceeded (and reported) instead of dropping what the user said.
  assert.ok(small.stats.overBudget > 0);
  assert.equal(small.bytes - small.stats.overBudget, 6000);
  assert.equal(compileCheckpoint(nodes, options, 6000).framed, small.framed, 'deterministic');
});

test('compiler: meets a tight budget when protected content fits', () => {
  const session = fakeSession(buildEvents({ turns: 3, callsPerTurn: 40 }));
  const nodes = new SurfaceIndex().view(session).nodes.slice(1);
  const result = compileCheckpoint(nodes, { ...resolveConfig(), toolNames: {} }, 12_000);
  assert.ok(result.bytes <= 12_000, `checkpoint ${result.bytes} exceeds budget`);
  assert.equal(result.stats.overBudget, 0);
});

// ── selection ───────────────────────────────────────────────────────────────

test('select: balanced cuts track open tool calls', () => {
  const nodes = [
    { type: 'user/message', message: { content: [] } },
    { type: 'assistant/message', message: { content: [{ type: 'tool-call' }, { type: 'tool-call' }] } },
    { type: 'tool/result', message: { content: [] } },
    { type: 'tool/result', message: { content: [] } },
  ];
  assert.deepEqual(balancedCuts(nodes), [true, true, false, false, true]);
});

test('select: keeps retained turns, never splits a turn or a call/result pair', () => {
  const session = fakeSession(buildEvents({ turns: 8, callsPerTurn: 3, resultChars: 20_000 }));
  const view = new SurfaceIndex().view(session);
  const policy = { targetRequestBytes: 50_000, retainTurns: 2, retainBytes: 0 };
  const range = selectRange(view, policy, { checkpointBytes: 5000 });
  assert.ok(range);
  assert.equal(range.startIdx, 1, 'system prompt kept');
  const cuts = balancedCuts(view.nodes);
  assert.ok(cuts[range.endIdx + 1], 'cut is tool-pairing balanced');
  const keptFirst = view.nodes[range.endIdx + 1];
  assert.ok(keptFirst.turn !== view.nodes[range.endIdx].turn, 'cut on a turn boundary');
  const lastTurn = view.nodes.at(-1).turn;
  assert.ok(view.nodes.slice(range.endIdx + 1).some((node) => node.turn === lastTurn - 1), 'second-last turn retained');
});

test('select: hysteresis — nothing to do when already below target', () => {
  const session = fakeSession(buildEvents({ turns: 3, resultChars: 100 }));
  const view = new SurfaceIndex().view(session);
  assert.equal(selectRange(view, { targetRequestBytes: 10_000_000, retainTurns: 1, retainBytes: 0 }), null);
});

test('select: retainBytes floor is honored', () => {
  const session = fakeSession(buildEvents({ turns: 6, callsPerTurn: 2, resultChars: 10_000 }));
  const view = new SurfaceIndex().view(session);
  const range = selectRange(view, { targetRequestBytes: 1000, retainTurns: 0, retainBytes: 60_000 }, { force: true });
  const kept = view.nodes.slice(range.endIdx + 1).reduce((total, node) => total + node.bytes, 0);
  assert.ok(kept >= 60_000);
  assert.ok(requestBytes(view) > kept);
});

// ── surface index ───────────────────────────────────────────────────────────

test('surface index: folds incrementally and tracks result origins', () => {
  const events = buildEvents({ turns: 2, callsPerTurn: 1 });
  const session = fakeSession(events);
  const index = new SurfaceIndex();
  index.view(session);
  assert.equal(index.foldedSeq, events.length);
  const resultSeq = events.find((event) => event.type === 'tool/result').seq;
  events.push({ type: 'tool/result', seq: events.length, time: 0, data: events[resultSeq].data, surfaceOp: { op: 'replace', startSeq: resultSeq, endSeq: resultSeq }, sourceEventSeqs: [resultSeq] });
  index.sync({ ...session, seq: events.length });
  assert.equal(index.originOf(events.length - 1), resultSeq);
});

// ── recall and search ───────────────────────────────────────────────────────

test('recall: byte-exact tool result, from call or result seq', () => {
  const events = buildEvents({ turns: 2, callsPerTurn: 2 });
  setResultContent(events[events.findIndex((event) => event.type === 'tool/result')], [{ type: 'text', text: 'line1\r\n\x1b[31mred\x1b[0m\ttab 😀' }]);
  const session = fakeSession(events);
  const result = events.find((event) => event.type === 'tool/result');
  const original = resultText(result);
  const byResult = recall(session, { result: result.seq }, { maxChars: 1e6 }).text;
  assert.equal(byResult.slice(byResult.indexOf('\n') + 1), original);
  const call = events.find((event) => event.type === 'assistant/message' && event.data.message.content.some((block) => block.type === 'tool-call'));
  const byCall = recall(session, { result: call.seq }, { maxChars: 1e6 }).text;
  assert.equal(byCall.slice(byCall.indexOf('\n') + 1), original);
});

test('recall: follows replacement chains to the original', () => {
  const events = buildEvents({ turns: 1, callsPerTurn: 1 });
  const original = events.find((event) => event.type === 'tool/result');
  const pruned = structuredClone(original.data);
  setResultContent({ data: pruned }, [{ type: 'text', text: 'pruned' }]);
  events.push({ type: 'tool/result', seq: events.length, time: 0, data: pruned, surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq }, sourceEventSeqs: [original.seq] });
  const session = fakeSession(events);
  assert.equal(findOriginalResult(session, events.length - 1)[0].seq, original.seq);
});

test('recall: pagination returns everything across pages', () => {
  const session = fakeSession(buildEvents({ turns: 1, callsPerTurn: 1, resultChars: 25_000 }));
  const seq = session.eventAt(session.seq - 1) && [...Array(session.seq).keys()].find((i) => session.eventAt(i).type === 'tool/result');
  let offset = 0;
  let joined = '';
  for (let pages = 0; pages < 10; pages += 1) {
    const page = recall(session, { seq, offset }, { maxChars: 10_000 });
    joined += page.text.replace(/\n\n\[\d+ more characters; call again with offset \d+\]$/, '');
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  const full = recall(session, { seq }, { maxChars: 1e7 }).text;
  assert.equal(joined, full);
});

test('recall: input validation', () => {
  const session = fakeSession(buildEvents({ turns: 1 }));
  assert.throws(() => recall(session, {}, { maxChars: 10 }), RecallError);
  assert.throws(() => recall(session, { seq: 1, result: 2 }, { maxChars: 10 }), /exactly one/);
  assert.throws(() => recall(session, { seq: 99999 }, { maxChars: 10 }), /does not exist/);
  assert.throws(() => recall(session, { range: '1-999' }, { maxChars: 10 }), /wider than/);
  const turnStart = [...Array(session.seq).keys()].find((seq) => session.eventAt(seq).type === 'turn/start');
  assert.throws(() => recall(session, { seq: turnStart }, { maxChars: 10 }), /no recallable content/);
});

test('search: finds shadowed content, newest first, regex opt-in', () => {
  const session = fakeSession(buildEvents({ turns: 3, callsPerTurn: 1, resultChars: 40 }));
  const hit = search(session, { query: 'result-1-1' }, { maxHits: 5 });
  assert.equal(hit.total, 1);
  assert.match(hit.text, /seq \d+ tool result/);
  const regex = search(session, { query: 'END-[23]-1', regex: true }, { maxHits: 5 });
  assert.equal(regex.total, 2);
  assert.ok(regex.text.indexOf('END-3-1') < regex.text.indexOf('END-2-1'));
  assert.throws(() => search(session, { query: '(', regex: true }, { maxHits: 5 }), /invalid regular expression/);
});

// ── images ──────────────────────────────────────────────────────────────────

test('images: keeps newest N, replaces older with labels, content-only', () => {
  const session = fakeSession(buildEvents({ turns: 3, callsPerTurn: 2, withImageEvery: 1 }));
  const view = new SurfaceIndex().view(session);
  const plan = planImageOffload(view.nodes, 0, 2);
  assert.equal(plan.length, 4, '6 images, keep 2');
  const event = session.eventAt(plan[0].node.seq);
  const message = offloadedResultMessage(event, event.seq);
  const content = resultContent(message);
  assert.equal(message.toolCallId ?? message.content[0].toolCallId, event.data.message.toolCallId ?? event.data.message.content[0].toolCallId);
  assert.ok(!content.some((part) => part.type === 'image'));
  assert.match(content.at(-1).text, /image removed .*"shot-1\.png" 1280x800/);
});

// ── review 2026-09-26: required tests ──────────────────────────────────────

import { clipHeadTail, pinnedBlock, ASSISTANT_TEXT_FLOOR, diffSummary } from '../lib/compiler.mjs';
import { checkpointBudgetFor, selectIntraTurnRange } from '../lib/select.mjs';
import { planResultTrim, trimmedResultMessage, TRIM_MARKER } from '../lib/housekeeping.mjs';
import { captionAfter } from '../lib/images.mjs';
import { pin, pinsFor, releasePins } from '../lib/pins.mjs';
import { parseRecallCommand, statusText } from '../lib/tools.mjs';

/** Events with custom human messages (and a long assistant message) for protection tests. */
function withUserTexts(texts, { assistantChars = 3000 } = {}) {
  const events = buildEvents({ turns: texts.length, callsPerTurn: 6, resultChars: 6000 });
  let index = 0;
  for (const event of events) {
    if (event.type === 'user/message') event.data.content[0].text = texts[index++];
    if (event.type === 'assistant/message' && event.data.message.content.length === 1) {
      event.data.message.content[0].text = `CONCLUSION-START ${'a'.repeat(assistantChars)} CONCLUSION-END`;
    }
  }
  return events;
}

const SPEC = [
  'Build the export feature exactly as follows.',
  'Never write to the production database from tests.',
  'Do not add new dependencies without asking.',
  'Only use the v2 API for uploads, understood?',
  'The CSV header must be id,name,email in that order.',
].join('\n') + '\n' + 'Detail line. '.repeat(250);

test('review 1: tightest budget keeps every user message verbatim', () => {
  const texts = [SPEC, 'second request: rename the flag to --fast', SPEC.replace('export', 'import')];
  const nodes = new SurfaceIndex().view(fakeSession(withUserTexts(texts))).nodes.slice(1);
  const result = compileCheckpoint(nodes, { ...resolveConfig(), toolNames: {} }, 1000);
  for (const text of texts) assert.ok(result.framed.includes(`\n${text}\n`), 'user text verbatim');
  assert.equal(result.stats.degradation, 3, 'budget forced every pass and elision');
  assert.deepEqual(result.stats.userClipped, []);
});

test('review 2+5: carried checkpoints keep user blocks through three compactions', () => {
  const options = { ...resolveConfig(), toolNames: {} };
  const first = new SurfaceIndex().view(fakeSession(withUserTexts([SPEC, 'b']))).nodes.slice(1);
  let checkpoint = compileCheckpoint(first, options, 1000).framed;
  for (let round = 2; round <= 4; round += 1) {
    const more = new SurfaceIndex().view(fakeSession(withUserTexts([`round ${round} request`]))).nodes.slice(1)
      .map((node) => ({ ...node, seq: node.seq + round * 10_000 }));
    const carried = { seq: round * 10_000 - 1, type: 'user/message', message: { role: 'user', content: [{ type: 'text', text: checkpoint }], source: { kind: 'plugin', plugin: 'compact' } } };
    checkpoint = compileCheckpoint([carried, ...more], options, 1000).framed;
  }
  assert.ok(checkpoint.includes(`[user seq 2]\n${SPEC}\n[/user seq 2]`), 'first user message verbatim after 3 more compactions');
  for (const round of [2, 3, 4]) assert.ok(checkpoint.includes(`round ${round} request`));
  assert.equal((checkpoint.match(/constraint seq 2: "Never write to the production database from tests\."/g) ?? []).length, 1, 'constraint carried once');
  assert.equal((checkpoint.match(/<hypercompact-checkpoint>/g) ?? []).length, 1);
});

test('review 2: carried tool lines are elidable, so repeated compaction stays bounded', () => {
  const options = { ...resolveConfig(), toolNames: {} };
  const nodes = new SurfaceIndex().view(fakeSession(buildEvents({ turns: 20, callsPerTurn: 5 }))).nodes.slice(1);
  const big = compileCheckpoint(nodes, options, 1e7).framed;
  const carried = { seq: 99_999, type: 'user/message', message: { role: 'user', content: [{ type: 'text', text: big }], source: { kind: 'plugin', plugin: 'compact' } } };
  const again = compileCheckpoint([carried], options, 12_000);
  assert.ok(again.bytes < big.length / 3, `carried checkpoint shrank (${again.bytes} vs ${big.length})`);
  for (let turn = 1; turn <= 20; turn += 1) assert.ok(again.framed.includes(`Turn ${turn}: please work on task ${turn}.`));
});

test('review 3: degraded assistant text keeps ≥ floor, both ends, and a recall pointer', () => {
  const nodes = new SurfaceIndex().view(fakeSession(withUserTexts(['a', 'b'], { assistantChars: 5000 }))).nodes.slice(1);
  const options = { ...resolveConfig(), toolNames: {} };
  // Find a budget that forces the assistant-text pass but no elision.
  const full = compileCheckpoint(nodes, options, 1e7).bytes;
  let result;
  for (let budget = full; budget > 1000; budget -= 200) {
    result = compileCheckpoint(nodes, options, budget);
    if (result.stats.degradation === 2) break;
  }
  assert.equal(result.stats.degradation, 2);
  const block = result.framed.split('\n[assistant').find((part) => part.includes('CONCLUSION-START'));
  assert.ok(block, 'assistant text still present');
  assert.ok(block.includes('CONCLUSION-END'), 'tail kept (head + tail clip)');
  assert.match(block, /recall seq \d+/);
  const kept = block.replace(/\n…\[cut [^\]]+\]…\n/, '');
  assert.ok(kept.length >= ASSISTANT_TEXT_FLOOR - 20, `kept ${kept.length} chars`);
});

test('review 4: checkpoint budget uses the free space under the target', () => {
  const view = { toolsBytes: 30_000, nodes: [{ bytes: 5_000_000 }, { bytes: 200_000 }] };
  const policy = { targetRequestBytes: 1_500_000, maxCheckpointBytes: 600_000 };
  const budget = checkpointBudgetFor(view, { startIdx: 0, endIdx: 0 }, policy, 16_000);
  assert.ok(budget > 300_000, `budget ${budget}`);
  assert.equal(budget, 600_000);
  assert.equal(checkpointBudgetFor(view, { startIdx: 0, endIdx: 0 }, { ...policy, maxCheckpointBytes: 5e6 }, 16_000), 1_500_000 - 200_000 - 30_000 - 512);
});

test('review 6: an oversized user paste keeps head + tail + pointer', () => {
  const huge = `HEAD-MARK ${'z'.repeat(50_000)} TAIL-MARK`;
  const nodes = new SurfaceIndex().view(fakeSession(withUserTexts([huge]))).nodes.slice(1);
  const result = compileCheckpoint(nodes, { ...resolveConfig(), toolNames: {} }, 600_000);
  assert.ok(result.framed.includes('HEAD-MARK'));
  assert.ok(result.framed.includes('TAIL-MARK'));
  assert.match(result.framed, /cut [\d.]+ KB from the middle; recall seq 2/);
  assert.deepEqual(result.stats.userClipped, [2]);
  assert.match(clipHeadTail('abcdefghij', 4, 'r'), /^ab\n…\[cut 6 B from the middle; r\]…\nij$/);
});

test('review 7: header lists every user-message seq in the span', () => {
  const nodes = new SurfaceIndex().view(fakeSession(buildEvents({ turns: 5 }))).nodes.slice(1);
  const result = compileCheckpoint(nodes, { ...resolveConfig(), toolNames: { recall: 'recall' } }, 600_000);
  const userSeqs = nodes.filter((node) => node.type === 'user/message').map((node) => node.seq);
  const header = result.framed.slice(0, result.framed.indexOf(CHECKPOINT_OPEN_TAG));
  assert.ok(header.includes(`User messages (each verbatim below between [user seq N] and [/user seq N]): ${userSeqs.join(', ')}.`));
  assert.match(header, /RULE: before editing a file, acting on a requirement/);
});

test('review 8: constraint sentences survive verbatim in the pinned block under the tightest budget', () => {
  const nodes = new SurfaceIndex().view(fakeSession(withUserTexts([SPEC]))).nodes.slice(1);
  const result = compileCheckpoint(nodes, { ...resolveConfig(), toolNames: {} }, 1000);
  const pinned = result.framed.slice(result.framed.indexOf('## Pinned'), result.framed.indexOf('## End pinned'));
  for (const sentence of ['Never write to the production database from tests.', 'Do not add new dependencies without asking.', 'Only use the v2 API for uploads, understood?', 'The CSV header must be id,name,email in that order.']) {
    assert.ok(pinned.includes(JSON.stringify(sentence)), `pinned: ${sentence}`);
  }
  assert.ok(!pinned.includes('constraint seq 2: "Build the export feature'), 'non-constraint sentence is not a constraint');
});

test('re-review RR2: over the cap, the user index is trimmed before constraints', () => {
  const facts = {
    users: Array.from({ length: 300 }, (_, i) => ({ seq: i * 10, text: `request number ${i} ${'q'.repeat(100)}` })),
    constraints: Array.from({ length: 20 }, (_, i) => ({ seq: i * 10, text: `Never do thing ${i}.` })),
    files: new Map([['src/a.js', { writes: 1, lastWriteSeq: 5, diff: '+1/−0 lines' }]]),
    carried: [],
  };
  const block = pinnedBlock(facts, 30_000);
  assert.ok(Buffer.byteLength(block) <= 30_000);
  for (let i = 0; i < 20; i += 1) assert.ok(block.includes(`"Never do thing ${i}."`), `constraint ${i} kept`);
  assert.match(block, /- 260 older user messages: seq 0–2590, verbatim in history/);
  for (let i = 260; i < 300; i += 1) assert.ok(block.includes(`- user seq ${i * 10}:`), `newest index line ${i} kept`);
  assert.ok(block.includes('src/a.js'), 'files kept when they fit');
});

test('re-review RR2: under extreme pressure files go before constraints', () => {
  const facts = {
    users: [],
    constraints: Array.from({ length: 30 }, (_, i) => ({ seq: i, text: `Must keep rule ${i} ${'r'.repeat(60)}.` })),
    files: new Map(Array.from({ length: 20 }, (_, i) => [`src/${'f'.repeat(80)}${i}.js`, { writes: 1, lastWriteSeq: i, diff: '' }])),
    carried: [],
  };
  const block = pinnedBlock(facts, 3000);
  assert.ok(Buffer.byteLength(block) <= 3000);
  assert.ok(!block.includes('files changed'), 'files dropped first');
  assert.ok(block.includes('Must keep rule 29'), 'newest constraints kept');
  assert.match(block, /some pinned lines omitted/);
});

test('review 9: recall grep/head/tail return exact slices', () => {
  const events = buildEvents({ turns: 1, callsPerTurn: 1 });
  const result = events.find((event) => event.type === 'tool/result');
  const lines = Array.from({ length: 500 }, (_, i) => `line ${i}${i === 250 ? ' NEEDLE here' : ''}`);
  setResultContent(result, [{ type: 'text', text: lines.join('\n') }]);
  const session = fakeSession(events);
  const grep = recall(session, { result: result.seq, grep: 'needle', context: 1 }, { maxChars: 1e6 }).text;
  assert.match(grep, /grep "needle": 1 matching lines of 500/);
  assert.ok(grep.endsWith('250: line 249\n251: line 250 NEEDLE here\n252: line 251'));
  const text = lines.join('\n');
  const ends = recall(session, { result: result.seq, head: 20, tail: 15 }, { maxChars: 1e6 }).text;
  assert.ok(ends.endsWith(`\n${text.slice(0, 20)}\n…\n${text.slice(-15)}`));
  assert.throws(() => recall(session, { result: result.seq, grep: '(' }, { maxChars: 10 }), /invalid grep/);
});

test('review R3: search filters by kind and seq window', () => {
  const events = buildEvents({ turns: 3, callsPerTurn: 1, resultChars: 20 });
  setResultError(events.find((event) => event.type === 'tool/result'));
  const session = fakeSession(events);
  assert.equal(search(session, { query: 'turn', kind: 'user' }, { maxHits: 50 }).total, 3);
  assert.equal(search(session, { query: 'RESULT', kind: 'error' }, { maxHits: 50 }).total, 1);
  assert.equal(search(session, { query: 'RESULT', kind: 'result' }, { maxHits: 50 }).total, 3);
  const firstUser = events.find((event) => event.type === 'user/message').seq;
  assert.equal(search(session, { query: 'turn', kind: 'user', until: firstUser }, { maxHits: 50 }).total, 1);
  assert.throws(() => search(session, { query: 'x', kind: 'nope' }, { maxHits: 5 }), /kind must be one of/);
});

test('review S2: read-only runs group into one line; errors keep a larger excerpt', () => {
  const nodes = [];
  let seq = 10;
  for (const file of ['a.js', 'b.js', 'c.js']) {
    const id = `r${seq}`;
    nodes.push({ seq, type: 'assistant/message', message: { role: 'assistant', content: [{ type: 'tool-call', id, name: 'read', arguments: JSON.stringify({ file_path: file }) }] } });
    nodes.push({ seq: seq + 1, type: 'tool/result', message: toolResultMessage(id, [{ type: 'text', text: 'content' }]) });
    seq += 2;
  }
  nodes.push({ seq, type: 'assistant/message', message: { role: 'assistant', content: [{ type: 'tool-call', id: 'e', name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) }] } });
  nodes.push({ seq: seq + 1, type: 'tool/result', message: toolResultMessage('e', [{ type: 'text', text: `FAIL ${'e'.repeat(2000)} EXIT 1` }], { isError: true }) });
  const { framed, stats } = compileCheckpoint(nodes, { ...resolveConfig(), toolNames: {} }, 600_000);
  assert.match(framed, /• read ×3: "a\.js" "b\.js" "c\.js" \(seq 10–14; recall a seq for its result\)/);
  assert.equal(stats.groupedCalls, 3);
  const errorLine = framed.split('\n').findIndex((line) => line.startsWith('• bash'));
  assert.match(framed.split('\n')[errorLine], /ERROR/);
  const excerptLine = framed.split('\n')[errorLine + 1];
  assert.ok(excerptLine.length > 900, 'error excerpt uses the larger budget');
  assert.match(framed, /- unresolved error: bash "npm test" \(seq 16, result 17\)/);
  assert.equal(diffSummary('edit', { old_string: 'a\nb', new_string: 'a\nb\nc' }), '+3/−2 lines');
});

test('review S5: image captions come from the following assistant text', () => {
  const nodes = [
    { type: 'tool/result', message: {} },
    { type: 'assistant/message', message: { content: [{ type: 'text', text: 'The login button overlaps the logo. Fixing now.' }] } },
  ];
  assert.equal(captionAfter(nodes, 0), 'The login button overlaps the logo.');
  assert.equal(captionAfter([{ type: 'tool/result' }, { type: 'user/message' }, nodes[1]], 0), undefined);
});

test('image offload: already omitted images survive rewriting other images', () => {
  for (const format of ['v1', 'v2']) {
    const message = toolResultMessage('call', [
      { type: 'image', attachment: { bytes: 100_000 }, offloaded: true },
      { type: 'image', attachment: { bytes: 120_000 } },
    ], { format });
    const event = { data: { message } };
    const node = { seq: 9, type: 'tool/result', message };
    assert.equal(planImageOffload([node], 0, 0).length, 1);
    const rewritten = offloadedResultMessage(event, 9);
    assert.equal(resultContent(rewritten)[0].offloaded, true, `${format} keeps the durable omission`);
    assert.equal(resultContent(rewritten)[1].type, 'text', `${format} offloads only the inline image`);
  }
});

test('review S5: image byte cap limits kept images', () => {
  const session = fakeSession(buildEvents({ turns: 3, callsPerTurn: 2, withImageEvery: 1 }));
  const view = new SurfaceIndex().view(session);
  assert.equal(planImageOffload(view.nodes, 0, 5, Infinity).length, 1, 'count cap');
  assert.equal(planImageOffload(view.nodes, 0, 5, 500_000).length, 5, 'byte cap keeps only one 400 KB image');
});

test('review S6: housekeeping trims only old large results, content-only, once', () => {
  const session = fakeSession(buildEvents({ turns: 4, callsPerTurn: 2, resultChars: 20_000 }));
  const view = new SurfaceIndex().view(session);
  const plan = planResultTrim(view.nodes, 20, { head: 100, tail: 50 });
  assert.ok(plan.length > 0 && plan.every(({ node }) => view.nodes.indexOf(node) < 20));
  const event = session.eventAt(plan[0].node.seq);
  const message = trimmedResultMessage(event, event.seq, { head: 100, tail: 50 });
  const text = resultContent(message)[0].text;
  assert.ok(text.includes(TRIM_MARKER) && text.includes(`recall {"result": ${event.seq}}`));
  assert.equal(message.toolCallId ?? message.content[0].toolCallId, event.data.message.toolCallId ?? event.data.message.content[0].toolCallId);
  const trimmedView = { nodes: [{ ...plan[0].node, message }] };
  assert.equal(planResultTrim(trimmedView.nodes, 1, { head: 100, tail: 50 }).length, 0, 'never trimmed twice');
});

test('review F5: intra-turn range keeps the human message and the newest bytes', () => {
  const events = buildEvents({ turns: 1, callsPerTurn: 30, resultChars: 5000 });
  const view = new SurfaceIndex().view(fakeSession(events));
  const range = selectIntraTurnRange(view, { targetRequestBytes: 20_000, retainBytes: 15_000 }, { checkpointBytes: 2000 });
  assert.ok(range);
  const human = view.nodes.findIndex((node) => node.type === 'user/message');
  assert.ok(range.startIdx > human, 'human message not compacted');
  assert.ok(balancedCuts(view.nodes)[range.endIdx + 1], 'balanced cut');
  const kept = view.nodes.slice(range.endIdx + 1).reduce((total, node) => total + node.bytes, 0);
  assert.ok(kept >= 15_000);
});

test('review S9: recalled seqs are pinned until a compaction honors them', () => {
  const session = {};
  pin(session, [5, 6]);
  assert.deepEqual([...pinsFor(session)], [5, 6]);
  releasePins(session, [5]);
  assert.deepEqual([...pinsFor(session)], [6]);
  const nodes = new SurfaceIndex().view(fakeSession(buildEvents({ turns: 20, callsPerTurn: 3 }))).nodes.slice(1);
  const target = nodes.find((node) => node.type === 'assistant/message' && node.message.content.some((block) => block.type === 'tool-call'));
  const result = compileCheckpoint(nodes, { ...resolveConfig(), toolNames: {}, pinnedSeqs: new Set([target.seq]) }, 1000);
  const line = result.framed.split('\n').findIndex((text) => text.startsWith('• ') && text.includes(`(seq ${target.seq} `));
  assert.ok(line !== -1, 'pinned tool line not elided');
  assert.match(result.framed.split('\n')[line + 1], /RESULT-/, 'pinned excerpt kept');
});

test('review R2: /recall parsing and status text', () => {
  assert.deepEqual(parseRecallCommand('42'), { seq: 42 });
  assert.deepEqual(parseRecallCommand('seq 42'), { seq: 42 });
  assert.deepEqual(parseRecallCommand('10-20'), { range: '10-20' });
  assert.deepEqual(parseRecallCommand('result 7'), { result: 7 });
  assert.equal(parseRecallCommand('nope'), null);
  const text = statusText({ bytes: 2e6, nodes: 10, images: 3, tokens: 1000, policy: { maxRequestBytes: 5e6, targetRequestBytes: 1.5e6, housekeepingBytes: 3.25e6 }, last: undefined });
  assert.match(text, /Request now: ~1\.91 MB \(10 messages, 3 inline images\), ~1000 tokens\./);
  assert.match(text, /No compaction in this session/);
});

// ── re-review 2026-09-26 ───────────────────────────────────────────────────

import { isHumanSource } from '../lib/compiler.mjs';
import { isHumanNode } from '../lib/select.mjs';
import { registerCommands } from '../lib/tools.mjs';

test('re-review RR1: relayed agent tasks, goals, and team messages are protected instructions', () => {
  for (const kind of ['user', 'agent-message', 'goal', 'team-message']) assert.ok(isHumanSource({ kind }), kind);
  for (const kind of ['plugin', 'skill-invocation', 'subagent-settled', 'session-reference', 'agent-instructions']) assert.ok(!isHumanSource({ kind }), kind);
  assert.ok(isHumanNode({ type: 'user/message', message: { source: { kind: 'agent-message', form: 'relay' } } }));
  assert.ok(!isHumanNode({ type: 'tool/result', message: { source: { kind: 'tool' } } }));
});

test('re-review RR1: a subagent task prompt survives the tightest budget verbatim and across compactions', () => {
  const task = `Audit every file under src/api. Do not modify tests. Report findings as a table.\n${'Context detail. '.repeat(400)}`;
  const events = buildEvents({ turns: 3, callsPerTurn: 6, resultChars: 6000 });
  const first = events.find((event) => event.type === 'user/message');
  first.data.content[0].text = task;
  first.data.source = { kind: 'agent-message', form: 'relay', senderSessionId: 'parent-1' };
  const options = { ...resolveConfig(), toolNames: {} };
  const nodes = new SurfaceIndex().view(fakeSession(events)).nodes.slice(1);
  const once = compileCheckpoint(nodes, options, 1000);
  assert.ok(once.framed.includes(`[agent-message seq ${first.seq}]\n${task}\n[/agent-message seq ${first.seq}]`));
  assert.match(once.framed, /- agent-message seq \d+: "Audit every file under src\/api\./);
  assert.match(once.framed, /constraint seq \d+: "Do not modify tests\."/);
  const carried = { seq: 50_000, type: 'user/message', message: { role: 'user', content: [{ type: 'text', text: once.framed }], source: { kind: 'plugin', plugin: 'compact' } } };
  const twice = compileCheckpoint([carried], options, 1000);
  assert.ok(twice.framed.includes(`[agent-message seq ${first.seq}]\n${task}\n[/agent-message seq ${first.seq}]`), 'carried verbatim');
  assert.equal((twice.framed.match(/- agent-message seq \d+:/g) ?? []).length, 1, 'index line carried once');
});

test('re-review RR1: intra-turn compaction never starts before a relayed task', () => {
  const events = buildEvents({ turns: 1, callsPerTurn: 30, resultChars: 5000 });
  events.find((event) => event.type === 'user/message').data.source = { kind: 'agent-message', form: 'relay', senderSessionId: 'p' };
  const view = new SurfaceIndex().view(fakeSession(events));
  const range = selectIntraTurnRange(view, { targetRequestBytes: 20_000, retainBytes: 15_000 }, { checkpointBytes: 2000 });
  const task = view.nodes.findIndex((node) => node.type === 'user/message');
  assert.ok(range && range.startIdx > task);
});

test('re-review RR3: a taken command name is logged and skipped, never thrown', () => {
  const warnings = [];
  const taken = new Set(['recall']);
  const registered = [];
  const ctx = {
    commands: { register: (definition) => { if (taken.has(definition.name)) throw new Error(`command "${definition.name}" is already registered`); registered.push(definition.name); return () => {}; } },
  };
  const dispose = registerCommands(ctx, resolveConfig(), (message) => warnings.push(message));
  assert.deepEqual(registered, ['hypercompact']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\/recall not registered: command "recall" is already registered/);
  dispose();
});

test('re-review minor: only real write tools count as file changes', () => {
  const call = (name) => ({ seq: 1, type: 'assistant/message', message: { role: 'assistant', content: [{ type: 'tool-call', id: name, name, arguments: JSON.stringify({ file_path: `${name}.js` }) }] } });
  const { framed } = compileCheckpoint([call('editor_view'), call('edit'), call('write_file')], { ...resolveConfig(), toolNames: {} }, 600_000);
  const files = framed.split('\n').find((line) => line.startsWith('- files changed')) ?? '';
  assert.ok(files.includes('edit.js') && files.includes('write_file.js'));
  assert.ok(!files.includes('editor_view.js'));
});

// ── dsh 0.1.7 message format ───────────────────────────────────────────────

import { toolResultsOf, withToolResultContent, isCheckpointSource as isCheckpoint } from '../lib/messages.mjs';

test('messages: both tool-result formats read and rewrite the same way', () => {
  for (const format of ['v1', 'v2']) {
    const message = toolResultMessage('c1', [{ type: 'text', text: 'hello' }], { isError: true, format });
    assert.deepEqual(toolResultsOf(message), [{ toolCallId: 'c1', content: [{ type: 'text', text: 'hello' }], isError: true }], format);
    const rewritten = withToolResultContent(message, [{ type: 'text', text: 'x' }]);
    assert.deepEqual(toolResultsOf(rewritten)[0].content, [{ type: 'text', text: 'x' }]);
    const { content: _a, ...restBefore } = message;
    const { content: _b, ...restAfter } = rewritten;
    assert.deepEqual(restAfter, restBefore, `${format}: only content changes`);
  }
  assert.deepEqual(toolResultsOf({ role: 'user', content: [{ type: 'text', text: 'hi' }] }), []);
});

test('messages: checkpoint markers from both releases are recognized', () => {
  assert.ok(isCheckpoint({ kind: 'plugin', plugin: 'compact', compactionId: 'x' }));
  assert.ok(isCheckpoint({ kind: 'compact-checkpoint', compactionId: 'x' }));
  assert.ok(!isCheckpoint({ kind: 'plugin', plugin: 'other' }));
  const body = `x\n<hypercompact-checkpoint>\n## History\n[user seq 7]\nkeep me\n[/user seq 7]\n</hypercompact-checkpoint>`;
  const carried = { seq: 9, type: 'user/message', message: { role: 'user', content: [{ type: 'text', text: body }], source: { kind: 'compact-checkpoint', compactionId: 'c' } } };
  assert.ok(compileCheckpoint([carried], { ...resolveConfig(), toolNames: {} }, 600_000).framed.includes('[user seq 7]\nkeep me\n[/user seq 7]'));
});

test('messages: developer-role nodes compile as context', () => {
  const node = { seq: 3, type: 'developer/message', message: { role: 'developer', content: [{ type: 'text', text: 'tools added: foo' }], source: { kind: 'tool-registry' } } };
  assert.match(compileCheckpoint([node], { ...resolveConfig(), toolNames: {} }, 600_000).framed, /\[developer seq 3\] tools added: foo/);
});

// ── version policy ─────────────────────────────────────────────────────────

import { compareVersions, classifyVersion } from '../index.mjs';

test('version policy: tested, compatible, and unsupported releases', () => {
  assert.equal(compareVersions('0.1.7-rc.2', '0.1.7'), -1);
  assert.equal(compareVersions('0.1.7-alpha.2', '0.1.7-rc.1'), -1);
  assert.equal(compareVersions('0.1.5-rc.10', '0.1.5-rc.9'), 1);
  assert.equal(compareVersions('0.1.6', '0.1.6'), 0);
  assert.equal(classifyVersion('0.1.5-rc.3'), 'tested');
  assert.equal(classifyVersion('0.1.7-rc.2'), 'tested');
  assert.equal(classifyVersion('0.1.8'), 'compatible');
  assert.equal(classifyVersion('0.1.6-alpha.1'), 'compatible');
  assert.equal(classifyVersion('0.1.5-rc.1'), 'unsupported');
  assert.equal(classifyVersion('0.2.0-rc.1'), 'tested');
  assert.equal(classifyVersion('0.2.0-rc.2'), 'tested');
  assert.equal(classifyVersion('0.2.0'), 'compatible');
  assert.equal(classifyVersion('0.2.5'), 'compatible');
  assert.equal(classifyVersion('0.3.0-alpha.1'), 'unsupported');
  assert.equal(classifyVersion('0.3.0'), 'unsupported');
  assert.equal(classifyVersion(undefined), 'unknown');
});

// ── create-preset: stale rows in the profile patch ─────────────────────────

import { cleanProfilePatch } from '../scripts/profile-patch.mjs';

test('create-preset: removes a stale inline declaration and a disabling override, keeps other rows', () => {
  const profile = [
    '- id: ui-conversation',
    '  config:',
    '    busyEnter: steer',
    '# >>> dsh-hypercompact preset "hypercompact" (managed by dsh-hypercompact/scripts/create-preset.mjs; remove with --remove)',
    '- insert:',
    '    - id: preset-hypercompact',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: hypercompact',
    '        plugins:',
    '          - id: persona',
    '- id: better-sidebar',
    '  config:',
    '    tabs: true',
    '- id: preset-hypercompact',
    '  disabled: true',
    '',
    '# <<< dsh-hypercompact preset "hypercompact"',
    '',
  ].join('\n');
  const { text, removed } = cleanProfilePatch(profile, 'hypercompact');
  assert.equal(removed.length, 3);
  assert.ok(!text.includes('preset-hypercompact'), 'no preset row is left');
  assert.ok(!text.includes('dsh-hypercompact preset'), 'no marker is left');
  assert.ok(text.includes('- id: ui-conversation\n  config:\n    busyEnter: steer'), 'rows before the block are kept');
  assert.ok(text.includes('- id: better-sidebar\n  config:\n    tabs: true'), 'rows placed inside the markers are kept');
});

test('create-preset: profile patch cleanup leaves unrelated patches untouched', () => {
  const untouched = '- id: preset-standard\n  disabled: true\n- id: preset-hypercompact\n  config:\n    id: hypercompact\n';
  assert.deepEqual(cleanProfilePatch(untouched, 'hypercompact'), { text: untouched, removed: [] }, 'a real override is not a stale disable');
  const onlyStale = '# Your patch layer.\n- id: preset-hypercompact\n  disabled: true\n';
  const cleaned = cleanProfilePatch(onlyStale, 'hypercompact');
  assert.equal(cleaned.text, '# Your patch layer.\n[]\n', 'an emptied patch is still a YAML list');
});
