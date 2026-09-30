/**
 * Engine tests against the REAL installed harness: a real `Session`, the
 * real `dsh-compaction` pairing helpers and checkpoint source, and the real
 * `CompactionEngine` base class. The durable log the engine writes is then
 * re-validated by constructing a fresh `Session` from it, which runs the
 * harness's own surface/replace validation.
 *
 * Skipped when dsh is not installed (e.g. in CI without a harness).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync as readFile } from 'node:fs';
import { createRequire } from 'node:module';
import { findDsh } from '../scripts/find-dsh.mjs';
import { pathToFileURL } from 'node:url';
import { loadRuntime } from '../index.mjs';
import { createEngineClass, ENGINE_PROVIDER } from '../lib/engine.mjs';
import { recall } from '../lib/recall.mjs';
import { buildEvents, toolResultMessage, resultText } from './helpers.mjs';
import { toolResultsOf, isCheckpointSource } from '../lib/messages.mjs';
import { resolvePolicy } from '../lib/config.mjs';
import { requestBytes } from '../lib/select.mjs';


const entry = findDsh();
const skip = entry === undefined ? 'dsh is not installed' : false;

/** Tool-result format of the harness under test: dsh ≥ 0.1.7 uses tool-role messages. */
function harnessFormat() {
  if (entry === undefined) return 'v1';
  const require = createRequire(entry);
  const version = JSON.parse(readFile(require.resolve('@deepseek-ai/dsh-session/package.json'), 'utf8')).version;
  const [major, minor, patch] = version.split(/[.-]/).map(Number);
  return major > 0 || minor > 1 || patch >= 7 ? 'v2' : 'v1';
}
const format = harnessFormat();

async function setup(config = {}, eventOptions = {}, overrides = {}) {
  const runtime = await loadRuntime(entry, { allowUntested: true });
  const require = createRequire(entry);
  const { Session } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href);
  const { TokenMeter } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-token-meter')).href);
  const events = buildEvents({ format, ...eventOptions });
  const session = Session.create('engine-test', events, undefined, undefined, overrides.projections);
  const logs = [];
  const listeners = new Map();
  const provided = [];
  const ctx = {
    logger: { info: (line) => logs.push(line), warn: (line) => logs.push(`WARN ${line}`) },
    on: (name, listener) => listeners.set(name, listener),
    get: () => undefined,
    reflect: { provide: (name, value) => provided.push(name) },
    tokenMeter: overrides.tokenMeter ?? { measure: () => ({ totalTokens: 0 }), estimateMessage: (message) => TokenMeter.prototype.estimateMessage(message) },
    sessions: { flush: async () => {} },
  };
  const Engine = createEngineClass(runtime);
  const engine = new Engine(ctx, { contextRatio: 0, statsLog: false, ...config });
  const agent = { session, runMaintenance: (job) => job(new AbortController().signal) };
  return { runtime, Session, session, engine, agent, logs, listeners, provided, ctx };
}

/** Rebuild a Session from the log to run the harness's own validation. */
function revalidate(Session, session) {
  return Session.create('revalidate', [...session.snapshotEvents()]);
}

function pairing(messages) {
  const calls = new Set();
  const answered = new Set();
  let orphans = 0;
  for (const message of messages) {
    for (const block of message.content) if (block.type === 'tool-call') calls.add(block.id);
    for (const result of toolResultsOf(message)) {
      if (!calls.has(result.toolCallId)) orphans += 1;
      answered.add(result.toolCallId);
    }
  }
  return { orphans, unanswered: [...calls].filter((id) => !answered.has(id)).length };
}

test('engine: registers as the compaction service with the pre-step and recovery hooks', { skip }, async () => {
  const { provided, listeners } = await setup();
  assert.deepEqual(provided, ['compaction']);
  assert.ok(listeners.has('agent/pre-step'));
  assert.ok(listeners.has('agent/request-error'));
});

test('engine: an image/offload projection updates byte pricing and survives result trimming', { skip }, async () => {
  const require = createRequire(entry);
  let projection;
  try {
    ({ imageOffloadProjection: projection } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-compaction-image-offload/projection')).href));
  } catch {
    return; // DSH 0.1.5 has no image/offload message projection.
  }
  const { Session, session, engine, agent } = await setup(
    { retainTurns: 1, retainBytes: 0, keepRecentImages: 0, maxRequestBytes: 5_000_000, targetRequestBytes: 1_500_000 },
    { turns: 3, callsPerTurn: 2, resultChars: 20_000, withImageEvery: 1 },
    { projections: [projection] },
  );
  const firstResult = session.surface.nodes.find((seq) => session.eventAt(seq)?.type === 'tool/result');
  const before = engine.index(session).view(session);
  const original = before.nodes.find((node) => node.seq === firstResult);
  assert.ok(original.bytes > 300_000, 'inline image costs base64 bytes');
  const generation = session.surface.contentGeneration;
  session.append('image/offload', { targets: [{ seq: firstResult, imageIndexes: [0] }] });
  assert.equal(session.surface.replaceGeneration, 0, 'offload did not replace the node');
  assert.ok(session.surface.contentGeneration > generation, 'content generation changed');
  const projected = engine.index(session).view(session);
  const projectedNode = projected.nodes.find((node) => node.seq === firstResult);
  assert.equal(projectedNode.message.content.find((block) => block.type === 'image')?.offloaded, true);
  assert.ok(original.bytes - projectedNode.bytes > 300_000, 'cached bytes were recalculated after offload');
  assert.equal(engine.status(session).images, 5, 'status reports only images still uploaded');
  const trimmed = engine.housekeep(session, resolvePolicy(engine.config, { provider: 'p', model: 'm' }), requestBytes(projected), 'image projection regression', true);
  assert.equal(trimmed, true);
  const rewritten = session.deriveMessages().find((message) => message.id === projectedNode.message.id);
  assert.ok(rewritten.content.some((block) => block.type === 'image' && block.offloaded === true), 'trimming did not restore the omitted image');
  revalidateWithProjection(Session, session, projection);
  void agent;
});

function revalidateWithProjection(Session, session, projection) {
  return Session.create('revalidated-offload', [...session.snapshotEvents()], undefined, undefined, [projection]);
}

test('engine: /compact commits a valid transaction and shrinks the request', { skip }, async () => {
  const { Session, session, engine, agent } = await setup({}, { turns: 10, callsPerTurn: 3, resultChars: 20_000 });
  const before = session.surface.nodes.length;
  const result = await engine.compactNow(agent, new AbortController().signal, 'cmd-1');
  assert.ok(result, 'compaction ran');
  assert.ok(result.bytesAfter < result.bytesBefore);
  assert.ok(session.surface.nodes.length < before);
  assert.equal(result.sourceCommandId, 'cmd-1');

  // Transaction shape: start, summary, replacement, end — in order.
  const types = [result.startSeq, result.summarySeq, result.summarySeq + 1, result.endSeq].map((seq) => session.eventAt(seq).type);
  assert.deepEqual(types, ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end']);
  const summary = session.eventAt(result.summarySeq).data;
  assert.equal(summary.provider, ENGINE_PROVIDER);
  assert.deepEqual(summary.shadowedSeqs, result.shadowedSeqs);
  assert.ok(summary.shadowedTokenCount > 0);
  const checkpoint = session.eventAt(result.summarySeq + 1).data;
  assert.ok(isCheckpointSource(checkpoint.source), 'standard checkpoint marker of the running release');
  assert.equal(checkpoint.source.compactionId, result.compactionId);

  // The harness accepts the log, and the request has no broken tool pairs.
  const rebuilt = revalidate(Session, session);
  assert.deepEqual(pairing(rebuilt.deriveMessages()), { orphans: 0, unanswered: 0 });
  assert.equal(rebuilt.deriveMessages()[0].role, 'system', 'system prompt stays first');
});

test('engine: pre-step pressure compacts inside an open turn only when over the byte trigger', { skip }, async () => {
  const { session, engine, agent, logs } = await setup({ maxRequestBytes: 150_000, targetRequestBytes: 60_000, retainBytes: 0 }, { turns: 8, callsPerTurn: 3, resultChars: 8_000 });
  session.append('turn/start', { turn: 99 });
  const first = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);
  assert.ok(first, `expected compaction; logs: ${logs.join(' | ')}`);
  assert.ok(first.bytesAfter <= 150_000);
  assert.equal(session.eventAt(first.startSeq).data.turn, 99, 'owned by the open turn');
  // Hysteresis: immediately after, below the trigger, nothing happens.
  const second = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);
  assert.equal(second, null);
});

test('engine: dry run writes nothing', { skip }, async () => {
  const { session, engine, agent, logs } = await setup({ dryRun: true }, { turns: 10, callsPerTurn: 3, resultChars: 20_000 });
  const seq = session.seq;
  assert.equal(await engine.compactNow(agent, new AbortController().signal), null);
  assert.equal(session.seq, seq);
  assert.ok(logs.some((line) => line.includes('[dry run]')));
});

test('engine: manual compaction refuses while a turn is open (busy)', { skip }, async () => {
  const { session, engine, agent, runtime } = await setup({}, { turns: 6, resultChars: 10_000 });
  session.append('turn/start', { turn: 50 });
  await assert.rejects(engine.compactNow(agent, new AbortController().signal), (error) => error instanceof runtime.ManualCompactionError && error.code === 'busy');
});

test('engine: repeated compaction carries earlier checkpoints forward', { skip }, async () => {
  const { Session, session, engine, agent } = await setup({ retainTurns: 1, retainBytes: 0 }, { turns: 10, callsPerTurn: 2, resultChars: 20_000 });
  await engine.compactNow(agent, new AbortController().signal);
  // Add two more turns, then compact again.
  let turn = 100;
  for (const _ of [0, 1]) {
    turn += 1;
    session.append('turn/start', { turn });
    session.append('user/message', { role: 'user', content: [{ type: 'text', text: `more work ${turn}` }], source: { kind: 'user' }, id: `m${turn}` }, { surfaceOp: 'append' });
    session.append('assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'p', model: 'm' }, id: `am${turn}` }, stream: [] }, { surfaceOp: 'append' });
    session.append('turn/end', { turn, reason: { kind: 'completed' } });
  }
  const second = await engine.compactNow(agent, new AbortController().signal);
  assert.ok(second);
  const text = second.summary[0].text;
  assert.match(text, /\[earlier checkpoint seq \d+ begins\]/);
  assert.equal((text.match(/<hypercompact-checkpoint>/g) ?? []).length, 1, 'no nested frames');
  assert.equal((text.match(/## Pinned/g) ?? []).length, 1, 'one merged pinned block');
  revalidate(Session, session);
});

test('engine: image offload rewrites only content and keeps pairing', { skip }, async () => {
  const { Session, session, engine, agent } = await setup({ keepRecentImages: 1, retainTurns: 3, retainBytes: 0, targetRequestBytes: 100_000, maxRequestBytes: 200_000 }, { turns: 5, callsPerTurn: 2, resultChars: 500, withImageEvery: 1 });
  const result = await engine.compactNow(agent, new AbortController().signal);
  assert.ok(result);
  const rebuilt = revalidate(Session, session);
  const messages = rebuilt.deriveMessages();
  const images = messages.flatMap((message) => toolResultsOf(message).flatMap((result) => result.content)).filter((block) => block.type === 'image');
  assert.equal(images.length, 1, 'only the newest image is still inline');
  assert.deepEqual(pairing(messages), { orphans: 0, unanswered: 0 });
  const pruneEvents = session.snapshotEvents().filter((event) => event.type === 'compaction/prune');
  assert.ok(pruneEvents.length > 0, 'each rewrite is shadow-priced');
});

test('engine: recall restores a compacted tool result byte-exactly', { skip }, async () => {
  const { session, engine, agent } = await setup({}, { turns: 8, callsPerTurn: 2, resultChars: 30_000 });
  const result = await engine.compactNow(agent, new AbortController().signal);
  const resultSeq = result.shadowedSeqs.find((seq) => session.eventAt(seq).type === 'tool/result');
  const original = resultText(session.eventAt(resultSeq));
  const text = recall(session, { result: resultSeq }, { maxChars: 1e7 }).text;
  assert.equal(text.slice(text.indexOf('\n') + 1), original);
});

test('engine: large session compacts well under one second', { skip }, async () => {
  const { engine, agent } = await setup({}, { turns: 200, callsPerTurn: 5, resultChars: 3000, argChars: 2000 });
  const started = performance.now();
  const result = await engine.compactNow(agent, new AbortController().signal);
  const elapsed = performance.now() - started;
  assert.ok(result);
  assert.ok(elapsed < 1000, `took ${elapsed.toFixed(0)} ms`);
});

test('loadRuntime: classifies versions and passes the contract check on the installed dsh', { skip }, async () => {
  const runtime = await loadRuntime(entry);
  assert.ok(['tested', 'compatible'].includes(runtime.versionStatus), `dsh ${runtime.version}: ${runtime.versionStatus}`);
});

test('engine: the real /compact command reports items collapsed', { skip }, async () => {
  const { session, engine, agent } = await setup({}, { turns: 8, callsPerTurn: 3, resultChars: 20_000 });
  const require = createRequire(entry);
  const command = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-command-compact')).href);
  let handler;
  const ctx = {
    compaction: engine,
    commands: { register: (definition) => { handler = definition.handler; return () => {}; } },
    effect: (generator) => { for (const _ of generator()) { /* run registrations */ } },
  };
  command.apply(ctx);
  const outcome = await handler({ rawInput: '', agent, signal: new AbortController().signal, commandId: 'cmd-9' });
  assert.equal(outcome.kind, 'success');
  assert.match(outcome.text, /^Compacted \d+ history items \(~\d+ tokens\)\.$/);
  assert.equal(session.eventAt(outcome.sourceEventSeq).type, 'compaction/summary');
});

test('engine: offloads images even when everything is inside retention', { skip }, async () => {
  const { Session, session, engine, agent } = await setup({ keepRecentImages: 1, retainTurns: 50, retainBytes: 0, maxRequestBytes: 200_000, targetRequestBytes: 100_000, allowIntraTurn: false }, { turns: 2, callsPerTurn: 3, resultChars: 200, withImageEvery: 1 });
  session.append('turn/start', { turn: 7 });
  const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);
  assert.equal(result, null, 'no span compacted (all retained)');
  const images = revalidate(Session, session).deriveMessages().flatMap((message) => toolResultsOf(message).flatMap((result) => result.content)).filter((block) => block.type === 'image');
  assert.ok(images.length <= 1, `expected at most 1 inline image, got ${images.length}`);
});

// ── review 2026-09-26 ──────────────────────────────────────────────────────

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pin } from '../lib/pins.mjs';
import { registerCommands } from '../lib/tools.mjs';
import { resolveConfig } from '../lib/config.mjs';

/** Append one human turn with a few tool calls to a live Session. */
function addTurn(session, turn, text, calls = 3, resultChars = 20_000) {
  session.append('turn/start', { turn });
  session.append('user/message', { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' }, id: `h${turn}` }, { surfaceOp: 'append' });
  for (let step = 1; step <= calls; step += 1) {
    const id = `t${turn}_${step}`;
    const assistant = session.append('assistant/message', { turn, step, message: { role: 'assistant', content: [{ type: 'tool-call', id, name: 'bash', arguments: JSON.stringify({ command: `echo ${turn}.${step}` }) }], source: { kind: 'model', provider: 'p', model: 'm' }, id: `am${id}` }, stream: [] }, { surfaceOp: 'append' });
    const call = session.append('tool/call', { turn, step, callId: id, name: 'bash', arguments: '{}' });
    void assistant;
    session.append('tool/result', { turn, step, message: toolResultMessage(id, [{ type: 'text', text: 'o'.repeat(resultChars) }], { format, messageId: `rm${id}` }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] });
  }
  session.append('turn/end', { turn, reason: { kind: 'completed' } });
}

test('review 5: three consecutive real compactions keep the first user message verbatim', { skip }, async () => {
  const { Session, session, engine, agent } = await setup({ retainTurns: 1, retainBytes: 0, targetRequestBytes: 60_000, maxRequestBytes: 200_000, maxCheckpointBytes: 20_000, minCheckpointBytes: 4000 }, { turns: 4, callsPerTurn: 3, resultChars: 20_000 });
  const firstUser = session.snapshotEvents().find((event) => event.type === 'user/message');
  const original = firstUser.data.content[0].text;
  let last;
  for (let round = 0; round < 3; round += 1) {
    addTurn(session, 100 + round, `follow-up ${round}: never touch config.yml`);
    last = await engine.compactNow(agent, new AbortController().signal);
    assert.ok(last, `compaction ${round + 1} ran`);
  }
  const text = last.summary[0].text;
  assert.ok(text.includes(`[user seq ${firstUser.seq}]\n${original}\n[/user seq ${firstUser.seq}]`));
  assert.ok(text.includes('constraint seq') && text.includes('never touch config.yml'));
  revalidate(Session, session);
});

test('review 10: housekeeping shrinks the request without writing a checkpoint', { skip }, async () => {
  const { Session, session, engine, agent, logs } = await setup({ maxRequestBytes: 2_000_000, targetRequestBytes: 150_000, retainTurns: 1, retainBytes: 0, housekeepingRatio: 0.05 }, { turns: 12, callsPerTurn: 3, resultChars: 20_000 });
  session.append('turn/start', { turn: 77 });
  const before = engine.status(session).bytes;
  assert.ok(before < 2_000_000 && before > 150_000 + (2_000_000 - 150_000) * 0.05);
  const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);
  assert.equal(result, null, 'no span replacement below the trigger');
  const events = session.snapshotEvents();
  assert.equal(events.filter((event) => event.type === 'compaction/start').length, 0, 'no checkpoint written');
  assert.ok(events.some((event) => event.type === 'compaction/prune'), 'content-only rewrites happened');
  const after = engine.status(session).bytes;
  assert.ok(after < before / 2, `request ${before} → ${after}`);
  assert.ok(logs.some((line) => line.includes('housekeeping')));
  revalidate(Session, session);
  // Span replacement still happens at the trigger.
  const { engine: big, agent: bigAgent, session: bigSession } = await setup({ maxRequestBytes: 200_000, targetRequestBytes: 100_000, housekeepingRatio: 0.5 }, { turns: 12, callsPerTurn: 3, resultChars: 20_000 });
  bigSession.append('turn/start', { turn: 77 });
  assert.ok(await big.compactIfNeeded(bigAgent, 'pressure', new AbortController().signal));
});

test('review F5: one long autonomous turn is compacted inside the turn', { skip }, async () => {
  const { Session, session, engine, agent } = await setup({ maxRequestBytes: 300_000, targetRequestBytes: 100_000, retainTurns: 2, retainBytes: 30_000, housekeepingRatio: 0 }, { turns: 1, callsPerTurn: 1, resultChars: 100 });
  // One human request followed by a long autonomous run, still in progress.
  session.append('turn/start', { turn: 5 });
  session.append('user/message', { role: 'user', content: [{ type: 'text', text: 'do the long migration now' }], source: { kind: 'user' }, id: 'h5' }, { surfaceOp: 'append' });
  for (let step = 1; step <= 60; step += 1) {
    const id = `m${step}`;
    session.append('assistant/message', { turn: 5, step, message: { role: 'assistant', content: [{ type: 'tool-call', id, name: 'bash', arguments: JSON.stringify({ command: `migrate ${step}` }) }], source: { kind: 'model', provider: 'p', model: 'm' }, id: `a${id}` }, stream: [] }, { surfaceOp: 'append' });
    const call = session.append('tool/call', { turn: 5, step, callId: id, name: 'bash', arguments: '{}' });
    session.append('tool/result', { turn: 5, step, message: toolResultMessage(id, [{ type: 'text', text: 'o'.repeat(8000) }], { format, messageId: `r${id}` }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] });
  }
  const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);
  assert.ok(result, 'compacted');
  assert.ok(result.bytesAfter < 300_000, `request ${result.bytesAfter}`);
  const rebuilt = revalidate(Session, session);
  const messages = rebuilt.deriveMessages();
  const human = messages.find((message) => message.content.some((block) => block.type === 'text' && block.text === 'do the long migration now'));
  assert.ok(human && human.source.kind === 'user', 'human request kept as a live message, not only in the checkpoint');
  assert.deepEqual(pairing(messages), { orphans: 0, unanswered: 0 });
});

test('review F6: a failing token meter is reported once and the byte trigger still works', { skip }, async () => {
  const { session, engine, agent, logs } = await setup({ maxRequestBytes: 150_000, targetRequestBytes: 60_000, retainBytes: 0 }, { turns: 8, callsPerTurn: 3, resultChars: 8_000 }, {
    tokenMeter: { measure: () => { throw new Error('meter offline'); }, estimateMessage: () => 1 },
  });
  session.append('turn/start', { turn: 99 });
  assert.ok(await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal));
  await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);
  assert.equal(logs.filter((line) => line.includes('token meter unavailable')).length, 1);
});

test('review S8: one content-free stats record per compaction', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-stats-'));
  try {
    const { session, engine, agent } = await setup({ statsLog: true, statsDir: dir }, { turns: 8, callsPerTurn: 3, resultChars: 20_000 });
    await engine.compactNow(agent, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const lines = readFileSync(join(dir, 'engine-test.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.kind, 'compaction');
    assert.ok(record.bytesBefore > record.bytesAfter);
    assert.ok(Array.isArray(record.userMessages) && record.userMessages.length > 0);
    assert.equal(typeof record.degradation, 'number');
    assert.ok(!lines[0].includes('please work on task'), 'no message content in stats');
    void session;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review S9: a recalled result is kept at full detail in the next checkpoint', { skip }, async () => {
  const { session, engine, agent } = await setup({ maxCheckpointBytes: 16_000, minCheckpointBytes: 16_000, targetRequestBytes: 60_000, maxRequestBytes: 200_000, retainTurns: 1, retainBytes: 0 }, { turns: 30, callsPerTurn: 3, resultChars: 3_000 });
  const oldCall = session.snapshotEvents().find((event) => event.type === 'assistant/message' && event.data.message.content.some((block) => block.type === 'tool-call'));
  pin(session, [oldCall.seq]);
  const result = await engine.compactNow(agent, new AbortController().signal);
  const lines = result.summary[0].text.split('\n');
  const index = lines.findIndex((line) => line.startsWith('• ') && line.includes(`(seq ${oldCall.seq} `));
  assert.ok(index !== -1, 'pinned call line survived elision');
  assert.match(lines[index + 1], /RESULT-1-1/);
});

test('review R2: /recall and /hypercompact commands', { skip }, async () => {
  const { session, engine, agent } = await setup({}, { turns: 8, callsPerTurn: 3, resultChars: 20_000 });
  await engine.compactNow(agent, new AbortController().signal);
  const commands = new Map();
  registerCommands({ compaction: engine, commands: { register: (definition) => { commands.set(definition.name, definition); return () => {}; } } }, resolveConfig());
  const user = session.snapshotEvents().find((event) => event.type === 'user/message');
  const shown = commands.get('recall').handler({ rawInput: String(user.seq), agent });
  assert.equal(shown.kind, 'success');
  assert.ok(shown.text.endsWith(user.data.content[0].text));
  assert.equal(commands.get('recall').handler({ rawInput: 'x', agent }).kind, 'error');
  const status = commands.get('hypercompact').handler({ rawInput: '', agent });
  assert.match(status.text, /Last compaction .*manual \/compact; seq \d+–\d+/);
  assert.match(status.text, /user messages kept verbatim/);
});
