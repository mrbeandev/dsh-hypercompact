#!/usr/bin/env node
/**
 * Offline measurement and dry-run tool for dsh-hypercompact.
 *
 *   node scripts/measure-session.mjs <session.v3.jsonl.zstd> [--target 1500000] [--max 5000000]
 *     [--config '{"retainTurns":1}'] [--attachments ~/.dsh/attachments]
 *
 * 1. Loads a session log into a real `Session` from the installed dsh.
 * 2. Serializes the current surface through pi-ai's real OpenAI-completions
 *    `convertMessages` (the adapter's wire path) and reports the request body
 *    breakdown: messages by role, tool schemas, system prompt, inlined images.
 * 3. Runs one compaction with the real engine against an in-memory COPY
 *    (the file on disk is never modified) and reports bytes before/after,
 *    duration, and protocol checks (tool pairing, orphans).
 * 4. Verifies `recall` returns a tool result byte-identical to the log.
 *
 * Session files contain private conversation data. This script only reads
 * them locally; it never writes, uploads, or prints message content.
 */

import { readFileSync, existsSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { loadRuntime } from '../index.mjs';
import { findDsh } from './find-dsh.mjs';
import { createEngineClass } from '../lib/engine.mjs';
import { recall } from '../lib/recall.mjs';

const args = process.argv.slice(2);
const valueFlags = new Set(['--target', '--max', '--config', '--attachments']);
const file = args.find((arg, index) => !arg.startsWith('--') && !valueFlags.has(args[index - 1]));
const option = (key, fallback) => {
  const index = args.indexOf(`--${key}`);
  return index === -1 ? fallback : args[index + 1];
};
if (!file) {
  console.error('usage: measure-session.mjs <session.v3.jsonl.zstd> [--target bytes] [--max bytes] [--config json] [--attachments dir]');
  process.exit(2);
}

const MB = (bytes) => `${(bytes / 1e6).toFixed(2)} MB`;
const harnessEntry = findDsh();
if (harnessEntry === undefined) {
  console.error('cannot find the dsh CLI; install @deepseek-ai/dsh or set DSH_ENTRY to its lib/bin.js');
  process.exit(2);
}
const require = createRequire(harnessEntry);
const importHarness = (specifier) => import(pathToFileURL(require.resolve(specifier)).href);


// ── load the session into a real Session ──────────────────────────────────
/**
 * Decode a multi-frame zstd file. dsh appends one frame per flush, and
 * zstdDecompressSync stops after the first frame, so split on the frame
 * magic and decode each frame (growing the slice when a magic sequence
 * happens to occur inside compressed data).
 */
function decodeFrames(buffer) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts = [];
  for (let at = buffer.indexOf(magic); at !== -1; at = buffer.indexOf(magic, at + 4)) starts.push(at);
  const out = [];
  for (let index = 0; index < starts.length; index += 1) {
    let decoded = false;
    for (let next = index + 1; next <= starts.length && !decoded; next += 1) {
      const end = next < starts.length ? starts[next] : buffer.length;
      try {
        out.push(zstdDecompressSync(buffer.subarray(starts[index], end)));
        index = next - 1;
        decoded = true;
      } catch {
        /* the magic was inside the previous frame's data; extend the slice */
      }
    }
    if (!decoded) throw new Error(`cannot decode zstd frame at byte ${starts[index]}`);
  }
  return Buffer.concat(out);
}

const raw = readFileSync(file);
const text = (file.endsWith('.zstd') ? decodeFrames(raw) : raw).toString('utf8');
// Line 1 of a v3 log is the file header ({ type: 'session', version, ... }), not an event.
const events = text.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line)).filter((event) => typeof event.seq === 'number');
const { Session } = await importHarness('@deepseek-ai/dsh-session');
const loadStart = performance.now();
const session = Session.create('measure', events);
console.log(`log: ${events.length} events, ${MB(Buffer.byteLength(text))} decompressed; loaded in ${(performance.now() - loadStart).toFixed(0)} ms`);

// ── wire body through pi-ai's real serializer ──────────────────────────────
const adapterEntry = require.resolve('@deepseek-ai/dsh-llm-pi-ai');
const adapterRequire = createRequire(adapterEntry);
// pi-ai does not export its package.json or api subpaths to require(); find
// the package directory through the adapter's resolution paths instead.
const piRoot = adapterRequire.resolve.paths('@earendil-works/pi-ai').map((base) => join(base, '@earendil-works/pi-ai')).find((dir) => existsSync(join(dir, 'dist/api/openai-completions.js')));
if (!piRoot) throw new Error('cannot locate @earendil-works/pi-ai next to dsh-llm-pi-ai');
const { convertMessages } = await import(pathToFileURL(join(piRoot, 'dist/api/openai-completions.js')).href);
const attachmentsDir = resolve(option('attachments', join(homedir(), '.dsh/attachments')).replace(/^~/, homedir()));

function attachmentBase64(id) {
  const hash = String(id).replace(/^sha256:/, '');
  const path = join(attachmentsDir, 'v1/objects', hash.slice(0, 2), hash);
  if (!existsSync(path)) return undefined;
  return readFileSync(path).toString('base64');
}

/** Minimal harness→pi-ai conversion mirroring dsh-llm-pi-ai textOnly/images paths. */
function toPi(messages) {
  const out = [];
  const toolNames = new Map();
  let system = '';
  for (const [index, message] of messages.entries()) {
    if (message.role === 'system') {
      const flat = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
      if (index === 0) system = flat;
      else out.push({ role: 'user', content: flat, timestamp: 0 });
      continue;
    }
    if (message.role === 'assistant') {
      const content = [];
      for (const block of message.content) {
        if (block.type === 'text') content.push({ type: 'text', text: block.text });
        else if (block.type === 'reasoning') content.push({ type: 'thinking', thinking: block.text ?? '', thinkingSignature: 'reasoning_content' });
        else if (block.type === 'tool-call') {
          let parsed = {};
          try { parsed = JSON.parse(block.arguments); } catch { parsed = {}; }
          content.push({ type: 'toolCall', id: block.id, name: block.name, arguments: parsed });
          toolNames.set(block.id, block.name);
        }
      }
      out.push({ role: 'assistant', content, api: 'openai-completions', provider: 'x', model: 'x', usage: {}, stopReason: 'stop', timestamp: 0 });
      continue;
    }
    const results = message.content.filter((block) => block.type === 'tool-result');
    const rest = message.content.filter((block) => block.type !== 'tool-result');
    const userParts = rest.map((block) => block.type === 'text' ? { type: 'text', text: block.text } : block.type === 'image' ? imagePart(block) : null).filter(Boolean);
    if (userParts.length > 0 || results.length === 0) out.push({ role: 'user', content: userParts, timestamp: 0 });
    for (const result of results) {
      const parts = (result.content ?? []).map((block) => block.type === 'text' ? { type: 'text', text: block.text } : block.type === 'image' ? imagePart(block) : null).filter(Boolean);
      out.push({ role: 'toolResult', toolCallId: result.toolCallId, toolName: toolNames.get(result.toolCallId) ?? 'unknown', content: parts.length ? parts : [{ type: 'text', text: '(no output)' }], isError: result.isError ?? false, timestamp: 0 });
    }
  }
  return { system, messages: out };
}

let missingImages = 0;
function imagePart(block) {
  const data = attachmentBase64(block.attachment?.attachmentId);
  if (data === undefined) {
    missingImages += 1;
    return { type: 'text', text: '[image unavailable]' };
  }
  return { type: 'image', mimeType: block.attachment.mediaType, data };
}

function wireBody(currentSession) {
  const messages = currentSession.deriveMessages();
  const tools = currentSession.requestHeader()?.tools ?? [];
  const { system, messages: piMessages } = toPi(messages);
  const model = { id: 'x', api: 'openai-completions', provider: 'measure', baseUrl: 'http://x', input: ['text', 'image'], reasoning: true, contextWindow: 1e6, maxTokens: 32000 };
  const compat = { supportsDeveloperRole: false, requiresToolResultName: false, requiresAssistantAfterToolResult: false, requiresThinkingAsText: false, thinkingFormat: 'openai', supportsStrictMode: false };
  const params = convertMessages(model, { systemPrompt: system, messages: piMessages, tools }, compat, {});
  const toolParams = tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
  const body = { model: 'x', messages: params, tools: toolParams, stream: true };
  const total = Buffer.byteLength(JSON.stringify(body));
  const byRole = {};
  let imageBytes = 0;
  for (const param of params) {
    const size = Buffer.byteLength(JSON.stringify(param));
    byRole[param.role] = (byRole[param.role] ?? 0) + size;
    if (Array.isArray(param.content)) for (const part of param.content) if (part.type === 'image_url') imageBytes += part.image_url.url.length;
  }
  const toolsSize = Buffer.byteLength(JSON.stringify(toolParams));
  return { total, byRole, toolsSize, imageBytes, count: params.length };
}

function report(label, measured) {
  console.log(`\n${label}: request body ${MB(measured.total)} (${measured.count} messages)`);
  for (const [role, size] of Object.entries(measured.byRole).sort((a, b) => b[1] - a[1])) console.log(`  ${role.padEnd(10)} ${MB(size).padStart(10)}  ${(size * 100 / measured.total).toFixed(1)}%`);
  console.log(`  ${'tools'.padEnd(10)} ${MB(measured.toolsSize).padStart(10)}  ${(measured.toolsSize * 100 / measured.total).toFixed(1)}%`);
  console.log(`  of which inline images: ${MB(measured.imageBytes)} (${(measured.imageBytes * 100 / measured.total).toFixed(1)}%)${missingImages ? `; ${missingImages} image(s) missing locally` : ''}`);
}

const before = wireBody(session);
report('BEFORE', before);

// ── run one compaction with the real engine ───────────────────────────────
const runtime = await loadRuntime(harnessEntry);
const { TokenMeter } = await importHarness('@deepseek-ai/dsh-token-meter');
const { Context, Service } = await importHarness('@deepseek-ai/cordis');
// A real TokenMeter in a throwaway cordis context (it needs sessionProjections
// to register into; a no-op stub is enough for measure()).
const meterRoot = new Context();
class ProjectionsStub extends Service {
  constructor(context) {
    super(context, 'sessionProjections');
  }
  register() {
    return () => {};
  }
}
meterRoot.plugin((context) => { new ProjectionsStub(context); });
await meterRoot.plugin(TokenMeter);
await new Promise((resolve) => setTimeout(resolve, 20));
const tokenMeter = meterRoot.get('tokenMeter');
if (tokenMeter === undefined) throw new Error('could not start a real TokenMeter');
const Engine = createEngineClass({ ...runtime, CompactionEngine: class { constructor(context) { this.ctx = context; } } });
const logs = [];
const ctx = {
  logger: { info: (line) => logs.push(line), warn: (line) => logs.push(`WARN ${line}`) },
  on() {},
  get: () => undefined,
  tokenMeter,
  sessions: { flush: async () => {} },
};
const engine = new Engine(ctx, {
  maxRequestBytes: Number(option('max', 5_000_000)),
  targetRequestBytes: Number(option('target', 1_500_000)),
  contextRatio: 0,
  statsLog: false,
  ...JSON.parse(option('config', '{}')),
});
const tokensBefore = tokenMeter.measure(session).totalTokens;

// Close any dangling turn/compaction so the engine can run as a manual compaction.
const agent = {
  session,
  runMaintenance: (job) => job(new AbortController().signal),
};
const open = (() => {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const type = session.eventAt(seq).type;
    if (type === 'turn/end') return false;
    if (type === 'turn/start') return true;
  }
  return false;
})();
if (open) session.append('turn/end', { turn: -1, reason: { kind: 'aborted' } });

const t0 = performance.now();
let result;
try {
  result = await engine.compactNow(agent, new AbortController().signal, undefined);
} catch (error) {
  console.error('compaction failed:', error.message, error.cause?.message ?? '');
  process.exit(1);
}
const elapsed = performance.now() - t0;
if (result === null) {
  console.log('\nno compaction performed:', logs.join(' | '));
  process.exit(0);
}

const after = wireBody(session);
report('AFTER', after);
const tokensAfter = tokenMeter.measure(session).totalTokens;
console.log(`tokens (real TokenMeter): ~${tokensBefore} → ~${tokensAfter}; contextRatio 0.85 of a 1M window would trigger at 850000`);
console.log(`\ncompaction: ${result.shadowedSeqs.length} nodes replaced, ${elapsed.toFixed(0)} ms, zero LLM calls`);
const record = engine.stats.last('measure');
if (record !== undefined) {
  console.log(`checkpoint: ${(record.checkpointBytes / 1e3).toFixed(1)} KB of ${(record.budgetBytes / 1e3).toFixed(1)} KB budget, degradation ${record.degradation}, ${record.entriesElided} entries elided, over budget ${record.overBudgetBytes} B`);
  console.log(`user messages: ${record.userMessages.length} kept verbatim, ${record.userMessagesClipped.length} over the ${engine.config.userTextChars}-char hard cap; ${record.constraints} constraint sentences pinned; ${record.groupedCalls} read-only calls grouped; ${record.toolErrors} tool errors`);
}
for (const line of logs) console.log(`  log: ${line.replace(/\[hypercompact\] /, '')}`);

// ── protocol checks on the compacted request ──────────────────────────────
const messages = session.deriveMessages();
const calls = new Set();
const answered = new Set();
let orphans = 0;
for (const message of messages) {
  for (const block of message.content) {
    if (block.type === 'tool-call') calls.add(block.id);
    if (block.type === 'tool-result') {
      if (!calls.has(block.toolCallId)) orphans += 1;
      answered.add(block.toolCallId);
    }
  }
}
const unanswered = [...calls].filter((id) => !answered.has(id)).length;
console.log(`protocol: ${orphans} orphaned results, ${unanswered} unanswered calls`);

// ── recall byte-exactness ────────────────────────────────────────────────
const sampleSeq = result.shadowedSeqs.find((seq) => session.eventAt(seq).type === 'tool/result' && session.eventAt(seq).surfaceOp === 'append');
if (sampleSeq !== undefined) {
  const original = session.eventAt(sampleSeq).data.message.content[0].content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  const recalled = recall(session, { result: sampleSeq }, { maxChars: 10_000_000 }).text;
  const body = recalled.slice(recalled.indexOf('\n') + 1);
  console.log(`recall: seq ${sampleSeq} ${body === original ? 'byte-identical' : 'MISMATCH'} (${Buffer.byteLength(original)} bytes)`);
}
const ok = after.total <= 5_000_000 && orphans === 0 && unanswered === 0;
console.log(ok ? '\nPASS' : '\nFAIL');
process.exit(ok ? 0 : 1);
