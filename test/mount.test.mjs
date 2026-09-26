/**
 * Mount test: loads the plugin entry into a REAL cordis Context from the
 * installed dsh, with stub `tokenMeter`, `sessions`, and `tools` services,
 * and checks that it provides `ctx.compaction` exactly once, registers the
 * two tools under the configured names, and unregisters everything on
 * dispose. This catches cordis-shape mistakes that pure unit tests miss.
 *
 * Skipped when dsh is not installed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { findDsh } from '../scripts/find-dsh.mjs';
import { pathToFileURL } from 'node:url';
import * as plugin from '../index.mjs';


const entry = findDsh();
const skip = entry === undefined ? 'dsh is not installed' : false;

async function rootContext() {
  const require = createRequire(entry);
  const { Context, Service } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const ctx = new Context();
  const registered = new Map();
  const commands = new Map();
  class Stub extends Service {
    constructor(context, name, body) {
      super(context, name);
      Object.assign(this, body);
    }
  }
  ctx.plugin((context) => { new Stub(context, 'tokenMeter', { measure: () => ({ totalTokens: 0 }), estimateMessage: () => 1 }); });
  ctx.plugin((context) => { new Stub(context, 'sessions', { flush: async () => {} }); });
  ctx.plugin((context) => {
    new Stub(context, 'tools', {
      register(definition) {
        if (registered.has(definition.name)) throw new Error(`tool ${definition.name} registered twice`);
        registered.set(definition.name, definition);
        return () => registered.delete(definition.name);
      },
    });
  });
  ctx.plugin((context) => {
    new Stub(context, 'commands', {
      register(definition) {
        if (commands.has(definition.name)) throw new Error(`command ${definition.name} registered twice`);
        commands.set(definition.name, definition);
        return () => commands.delete(definition.name);
      },
    });
  });
  return { ctx, registered, commands };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test('mount: provides compaction and registers recall tools; disposes cleanly', { skip }, async () => {
  const { ctx, registered, commands } = await rootContext();
  const fiber = ctx.plugin(plugin, { harnessEntry: entry, allowUntestedHarness: true, searchToolName: 'history_search', statsLog: false });
  await fiber;
  await settle();
  assert.equal(typeof ctx.get('compaction')?.compactNow, 'function', 'ctx.compaction provided');
  assert.equal(typeof ctx.get('compaction')?.compactIfNeeded, 'function');
  assert.equal(typeof ctx.get('compaction')?.compactRegion, 'function');
  assert.deepEqual([...registered.keys()].sort(), ['history_search', 'recall']);
  assert.deepEqual([...commands.keys()].sort(), ['hypercompact', 'recall'], 'human commands registered once');
  const recallTool = registered.get('recall');
  assert.equal(recallTool.parameters.type, 'object');
  assert.ok(recallTool.parameters.properties.seq);

  await fiber.dispose();
  await settle();
  assert.equal(ctx.get('compaction'), undefined, 'compaction unregistered on dispose');
  assert.equal(registered.size, 0, 'tools unregistered on dispose');
  assert.equal(commands.size, 0, 'commands unregistered on dispose');
});

test('mount: tools and commands can be disabled', { skip }, async () => {
  const { ctx, registered, commands } = await rootContext();
  await ctx.plugin(plugin, { harnessEntry: entry, allowUntestedHarness: true, tools: false, commands: false });
  await settle();
  assert.ok(ctx.get('compaction'));
  assert.equal(registered.size, 0);
  assert.equal(commands.size, 0);
});

test('mount: invalid config fails at mount with a clear message', { skip }, async () => {
  const { ctx } = await rootContext();
  await assert.rejects(Promise.resolve(ctx.plugin(plugin, { harnessEntry: entry, maxRequestBytes: 10, targetRequestBytes: 20 })), /targetRequestBytes/);
});
