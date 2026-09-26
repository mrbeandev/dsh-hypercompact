/**
 * dsh-hypercompact — deterministic, zero-LLM, byte-budget compaction for
 * DeepSeek Harness.
 *
 * Mount this row inside an agent preset's `compaction` isolate group in place
 * of `@deepseek-ai/dsh-compaction-basic`. It provides `ctx.compaction`, keeps
 * `/compact` working, registers `recall` / `recall_search` so the agent can
 * restore anything the checkpoint cut, and adds the `/recall` and
 * `/hypercompact` commands for the human.
 *
 * Host-only: no client bundle, no settings namespace, no UI slots. All
 * configuration comes from the cordis row.
 *
 * Harness packages are resolved through the RUNNING dsh install (never a
 * second npm copy), so `CompactionEngine`, the session helpers and the tool
 * registry are the exact classes the host uses.
 *
 * @module dsh-hypercompact
 */

import { createRequire } from 'node:module';
import { realpathSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveConfig } from './lib/config.mjs';
import { createEngineClass, LOG_PREFIX } from './lib/engine.mjs';
import { defineRecallTools, registerCommands, DEFAULT_TOOL_NAMES } from './lib/tools.mjs';

export const name = 'dsh-hypercompact';
export const inject = ['tokenMeter', 'sessions'];

/**
 * dsh versions this plugin was tested against (unit, real-harness engine and
 * mount tests, plus a preset mount in a real boot). Both tool-result formats
 * are covered: 0.1.5 (wrapped `tool-result` blocks) and 0.1.7 (tool-role
 * messages).
 */
export const TESTED_DSH_VERSIONS = Object.freeze(['0.1.5-rc.2', '0.1.5-rc.3', '0.1.7-rc.2']);

/**
 * Versions accepted without `allowUntestedHarness`: the 0.1 series from the
 * first release with the compaction seam. Untested versions in this range
 * load only if the contract check passes, with a one-time warning.
 */
export const SUPPORTED_DSH_RANGE = Object.freeze({ min: '0.1.5-rc.2', below: '0.2.0' });

/** Compare two semver strings, prerelease aware (`0.1.7-rc.2` < `0.1.7`). */
export function compareVersions(left, right) {
  const parse = (version) => {
    const [core, pre] = String(version).split('-', 2);
    return { core: core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre: pre === undefined ? null : pre.split('.') };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a.core[index] ?? 0) !== (b.core[index] ?? 0)) return (a.core[index] ?? 0) < (b.core[index] ?? 0) ? -1 : 1;
  }
  if (a.pre === null || b.pre === null) return a.pre === b.pre ? 0 : a.pre === null ? 1 : -1;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const x = a.pre[index];
    const y = b.pre[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (x === y) continue;
    if (nx !== null && ny !== null) return nx < ny ? -1 : 1;
    if (nx !== null || ny !== null) return nx !== null ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * How a dsh version is treated.
 * @returns {'tested' | 'compatible' | 'unsupported' | 'unknown'}
 */
export function classifyVersion(version) {
  if (version === undefined) return 'unknown';
  if (TESTED_DSH_VERSIONS.includes(version)) return 'tested';
  // `below` excludes that release's prereleases too (0.2.0-alpha.1 is not in the 0.1 series).
  const core = String(version).split('-', 1)[0];
  const inRange = compareVersions(version, SUPPORTED_DSH_RANGE.min) >= 0 && compareVersions(core, SUPPORTED_DSH_RANGE.below) < 0;
  return inRange ? 'compatible' : 'unsupported';
}

/** Plugin-level keys handled here and stripped before engine config validation. */
const PLUGIN_KEYS = ['harnessEntry', 'allowUntestedHarness', 'recallToolName', 'searchToolName'];

function importFrom(require, specifier) {
  return import(pathToFileURL(require.resolve(specifier)).href);
}

/** Locate the dsh package root from the running CLI entry. */
function harnessRoot(entry) {
  let dir = dirname(realpathSync(entry));
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (pkg.name === '@deepseek-ai/dsh') return { dir, version: pkg.version };
    } catch {
      /* keep walking up */
    }
    dir = dirname(dir);
  }
  return undefined;
}

/**
 * Load the harness classes this plugin builds on.
 * @param {string} [harnessEntry] - path of the running dsh CLI (defaults to argv[1]).
 * @param {{ allowUntested?: boolean }} [options]
 */
export async function loadRuntime(harnessEntry = process.argv[1], options = {}) {
  if (!harnessEntry) throw new Error('dsh-hypercompact: cannot locate the running dsh; set harnessEntry');
  const root = harnessRoot(harnessEntry);
  const status = classifyVersion(root?.version);
  if (status === 'unsupported' && options.allowUntested !== true) {
    throw new Error(`dsh-hypercompact: dsh ${root.version} is outside the supported range (>= ${SUPPORTED_DSH_RANGE.min} and < ${SUPPORTED_DSH_RANGE.below}); refusing to load. Set allowUntestedHarness: true to override.`);
  }
  const require = createRequire(realpathSync(harnessEntry));
  const [compaction, llm, tools] = await Promise.all([
    importFrom(require, '@deepseek-ai/dsh-compaction'),
    importFrom(require, '@deepseek-ai/dsh-llm'),
    importFrom(require, '@deepseek-ai/dsh-tools'),
  ]);
  const runtime = {
    version: root?.version,
    versionStatus: status,
    CompactionEngine: compaction.CompactionEngine,
    ManualCompactionError: compaction.ManualCompactionError,
    CompactionId: compaction.CompactionId,
    compactCheckpointSource: compaction.compactCheckpointSource,
    toolPairingBalancedBefore: compaction.toolPairingBalancedBefore,
    toolPairingBalancedAfter: compaction.toolPairingBalancedAfter,
    createUserMessage: llm.createUserMessage,
    errorChain: llm.errorChain,
    freezeMessage: llm.freezeMessage,
    HarnessError: llm.HarnessError,
    CONTEXT_WINDOW_EXCEEDED_CODE: llm.CONTEXT_WINDOW_EXCEEDED_CODE,
    defineTool: tools.defineTool,
  };
  // Contract check: every export this plugin uses must exist with the right
  // shape. A dsh that renamed or removed one is refused, whatever its version.
  const missing = Object.entries(runtime)
    .filter(([key, value]) => !['version', 'versionStatus'].includes(key) && (key === 'CONTEXT_WINDOW_EXCEEDED_CODE' ? typeof value !== 'string' : typeof value !== 'function'))
    .map(([key]) => key);
  if (missing.length > 0 && options.allowUntested !== true) {
    throw new Error(`dsh-hypercompact: dsh ${root?.version ?? '(unknown)'} lacks ${missing.join(', ')}; refusing to load (this dsh is not compatible with this plugin version)`);
  }
  return runtime;
}

function splitConfig(config) {
  const plugin = {};
  const engine = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    if (PLUGIN_KEYS.includes(key)) plugin[key] = value;
    else engine[key] = value;
  }
  return { plugin, engine };
}

function toolName(value, fallback, key) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value)) {
    throw new Error(`dsh-hypercompact config: ${key} must match /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/`);
  }
  return value;
}

/**
 * Plugin entry.
 * @param ctx - cordis context (inside the preset's compaction isolate realm).
 * @param config - cordis row config.
 */
export async function apply(ctx, config = {}) {
  const { plugin, engine } = splitConfig(config);
  // Validate engine config up front so a bad row fails at mount with a clear message.
  const resolved = resolveConfig(engine);
  const names = {
    recall: toolName(plugin.recallToolName, DEFAULT_TOOL_NAMES.recall, 'recallToolName'),
    search: toolName(plugin.searchToolName, DEFAULT_TOOL_NAMES.search, 'searchToolName'),
  };
  const runtime = await loadRuntime(plugin.harnessEntry, { allowUntested: plugin.allowUntestedHarness === true });
  if (runtime.versionStatus !== 'tested') {
    ctx.logger.warn(`${LOG_PREFIX} dsh ${runtime.version ?? '(unknown version)'} has not been tested with this plugin (tested: ${TESTED_DSH_VERSIONS.join(', ')}); the API contract check passed, loading anyway`);
  }
  const Engine = createEngineClass(runtime);

  // Provide ctx.compaction. cordis constructs the class with (ctx, config) and
  // unregisters it when this fiber unloads.
  ctx.plugin(Engine, { ...engine, toolNames: resolved.tools ? names : {} });

  if (resolved.tools) {
    ctx.inject(['tools'], (toolCtx) => {
      for (const definition of defineRecallTools(runtime, resolved, names)) {
        toolCtx.effect(() => toolCtx.tools.register(definition), `${name} ${definition.name} tool`);
      }
    });
  }
  if (resolved.commands) {
    // Needs the engine (ctx.compaction) this row provides and the command registry.
    ctx.inject(['commands', 'compaction'], (commandCtx) => {
      const warn = (message) => commandCtx.logger.warn(`${LOG_PREFIX} ${message}; continuing without it`);
      commandCtx.effect(() => registerCommands(commandCtx, resolved, warn), `${name} commands`);
    });
  }
  ctx.logger.info(`${LOG_PREFIX} loaded on dsh ${runtime.version ?? '(unknown version)'}${resolved.tools ? `; tools ${names.recall}, ${names.search}` : ''}${resolved.commands ? '; commands /recall, /hypercompact' : ''}`);
}
