#!/usr/bin/env node
/**
 * Create (or remove) an agent preset that uses dsh-hypercompact.
 *
 *   node scripts/create-preset.mjs [--from standard] [--id hypercompact] [--profile web] [--force] [--print] [--remove]
 *
 * The preset is a copy of a SHIPPED preset (default `standard`) in which only
 * the `compaction-basic` row is replaced by `dsh-hypercompact`. Shipped files
 * are only read, never written. dsh has two preset models:
 *
 * - dsh 0.1.5 (directory presets): writes `$DSH_HOME/.agent-presets/<id>/`
 *   (agent.cordis.yml + preset.yml). Visible to every profile.
 * - dsh 0.1.7+ (preset declarations): appends one `@deepseek-ai/dsh-agent-preset`
 *   row to `$DSH_HOME/profiles/<profile>/cordis.patch.yml`, between marker
 *   comments, so `--remove` can delete exactly that block.
 *
 * `--print` writes nothing and prints what would be written. `--remove`
 * deletes the preset created by this script (run it BEFORE uninstalling the
 * package: a preset naming a missing package cannot mount).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, cpSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { findDsh } from './find-dsh.mjs';

const args = process.argv.slice(2);
const option = (key, fallback) => {
  const index = args.indexOf(`--${key}`);
  return index === -1 ? fallback : args[index + 1];
};
const from = option('from', 'standard');
const id = option('id', 'hypercompact');
const profile = option('profile', 'web');
const force = args.includes('--force');
const printOnly = args.includes('--print');
const remove = args.includes('--remove');

function fail(message, code = 1) {
  console.error(`create-preset: ${message}`);
  process.exit(code);
}

if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) fail(`invalid preset id "${id}" (use lowercase letters, digits, and hyphens)`, 2);
if (!/^[A-Za-z0-9._-]+$/.test(profile)) fail(`invalid profile name "${profile}"`, 2);

const home = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'));
const entry = findDsh();
if (entry === undefined) fail('cannot find the dsh CLI; install @deepseek-ai/dsh or set DSH_ENTRY to its lib/bin.js');
const require = createRequire(entry);

function packageDir(name) {
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    return undefined;
  }
}

/** The compaction row that replaces compaction-basic, at a given indentation. */
function hypercompactRow(indent) {
  return [
    `- id: hypercompact`,
    `  name: dsh-hypercompact`,
    `  # All keys are optional; these are the defaults. See the dsh-hypercompact README.`,
    `  config:`,
    `    maxRequestBytes: 5000000     # compact when the next request body would exceed this`,
    `    targetRequestBytes: 1500000  # ...and compact down to about this`,
    `    retainTurns: 2               # newest complete turns kept verbatim`,
    `    retainBytes: 400000          # newest request bytes kept verbatim`,
    `    keepRecentImages: 2          # newest inline images kept; older ones become labels`,
    `    dryRun: false`,
  ].map((line) => indent + line).join('\n');
}

/** Replace the compaction-basic row (at any indentation) with the hypercompact row. */
function swapCompactionRow(text, where) {
  const basicRow = /^( *)- id: compaction-basic\n\1  name: '@deepseek-ai\/dsh-compaction-basic'\n(?:\1  [^\n]*\n|\1    [^\n]*\n)*/m;
  if (!basicRow.test(text)) fail(`could not find the compaction-basic row in ${where}; edit the preset by hand (see README)`);
  return text.replace(basicRow, (_match, indent) => `${hypercompactRow(indent)}\n`);
}

const presetsPackage = packageDir('@deepseek-ai/dsh-agent-presets');
const webApp = packageDir('@deepseek-ai/dsh-web-app');
const directoryModel = presetsPackage !== undefined && existsSync(join(presetsPackage, 'presets', from, 'agent.cordis.yml'));
const declarationModel = !directoryModel && webApp !== undefined && existsSync(join(webApp, 'presets', `${from}.patch.yml`));
if (!directoryModel && !declarationModel) fail(`shipped preset "${from}" not found in this dsh install (${entry})`);

if (directoryModel) {
  // ── dsh 0.1.5: directory presets ────────────────────────────────────────
  const source = join(presetsPackage, 'presets', from);
  const target = join(home, '.agent-presets', id);
  if (remove) {
    if (!existsSync(target)) fail(`no preset at ${target}`);
    if (!existsSync(join(target, 'agent.cordis.yml')) || !readFileSync(join(target, 'agent.cordis.yml'), 'utf8').includes('create-preset.mjs')) {
      fail(`${target} was not created by this script; remove it by hand`);
    }
    if (printOnly) {
      console.log(`would delete ${target}`);
      process.exit(0);
    }
    rmSync(target, { recursive: true, force: true });
    console.log(`removed preset "${id}" (${target})`);
    process.exit(0);
  }
  const composition = `# Local copy of the shipped "${from}" preset with dsh-hypercompact as the
# compaction engine. Generated by dsh-hypercompact/scripts/create-preset.mjs.
# Only the compaction-basic row below was changed.

${swapCompactionRow(readFileSync(join(source, 'agent.cordis.yml'), 'utf8'), `${from}/agent.cordis.yml`)}`;
  if (printOnly) {
    process.stdout.write(composition);
    process.exit(0);
  }
  if (existsSync(target) && !force) fail(`${target} already exists; pass --force to overwrite it`);
  mkdirSync(target, { recursive: true });
  // Carry any preset-local assets (skills, etc.) along with the composition.
  for (const item of readdirSync(source, { withFileTypes: true })) {
    if (item.name === 'agent.cordis.yml' || item.name === 'preset.yml') continue;
    cpSync(join(source, item.name), join(target, item.name), { recursive: true });
  }
  writeFileSync(join(target, 'agent.cordis.yml'), composition);
  writeFileSync(join(target, 'preset.yml'), `name: Hypercompact (${from})
description: The shipped "${from}" coding agent with dsh-hypercompact — deterministic, zero-LLM, byte-budget compaction and recall of compacted history.
`);
  console.log(`created preset "${id}" at ${target}`);
  console.log('restart dsh, then select it in the web UI preset picker (or set agent-presets.default in settings.yaml)');
  process.exit(0);
}

// ── dsh 0.1.7+: preset declaration rows in the profile patch ──────────────
const patchFile = join(home, 'profiles', profile, 'cordis.patch.yml');
if (!existsSync(patchFile)) fail(`profile "${profile}" has no ${patchFile}; create the profile first (dsh --profile ${profile})`);
const BEGIN = `# >>> dsh-hypercompact preset "${id}" (managed by dsh-hypercompact/scripts/create-preset.mjs; remove with --remove)`;
const END = `# <<< dsh-hypercompact preset "${id}"`;
const current = readFileSync(patchFile, 'utf8');
const hasBlock = current.includes(BEGIN);

/** Remove our marked block; an item-less remainder becomes `[]`. */
function withoutBlock(text) {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END, start);
  if (start === -1 || end === -1) return text;
  let rest = text.slice(0, start) + text.slice(end + END.length).replace(/^\n/, '');
  const items = rest.split('\n').filter((line) => line.trim().length > 0 && !line.trimStart().startsWith('#'));
  if (items.length === 0) rest = `${rest.replace(/\s*$/, '')}\n[]\n`;
  return rest;
}

if (remove) {
  if (!hasBlock) fail(`no preset "${id}" block in ${patchFile}`);
  const next = withoutBlock(current);
  if (printOnly) {
    process.stdout.write(next);
    process.exit(0);
  }
  writeFileSync(patchFile, next);
  console.log(`removed preset "${id}" from ${patchFile}`);
  process.exit(0);
}

if (hasBlock && !force) fail(`${patchFile} already declares preset "${id}"; pass --force to replace it`);
const shipped = readFileSync(join(webApp, 'presets', `${from}.patch.yml`), 'utf8');
let declaration = shipped.split('\n').filter((line) => !line.startsWith('#')).join('\n').trim();
if (!/^- insert:\n {4}- id: preset-[a-z0-9-]+\n/.test(declaration)) fail(`unexpected layout in ${from}.patch.yml; edit the preset by hand (see README)`);
declaration = declaration
  .replace(/^( {4}- id: )preset-[a-z0-9-]+$/m, `$1preset-${id}`)
  .replace(/^( {8}id: )[a-z0-9-]+$/m, `$1${id}\n        name: Hypercompact (${from})\n        description: The shipped "${from}" coding agent with dsh-hypercompact (deterministic, zero-LLM, byte-budget compaction).`)
  .replace(/^ {8}order: \d+\n/m, '');
declaration = swapCompactionRow(`${declaration}\n`, `${from}.patch.yml`);

// Append as block-sequence items: a bare `[]` (flow empty list) is dropped.
const base = withoutBlock(current);
const lines = base.split('\n');
const content = lines.filter((line) => line.trim().length > 0 && !line.trimStart().startsWith('#'));
let head;
if (content.length === 1 && content[0].trim() === '[]') head = lines.filter((line) => line.trim() !== '[]').join('\n').replace(/\s*$/, '');
else if (content.every((line) => line.startsWith('-') || line.startsWith(' '))) head = base.replace(/\s*$/, '');
else fail(`${patchFile} is not a block-style YAML list; add the preset by hand (see README)`);
const next = `${head ? `${head}\n` : ''}${BEGIN}\n${declaration.replace(/\s*$/, '')}\n${END}\n`;
if (printOnly) {
  process.stdout.write(next);
  process.exit(0);
}
writeFileSync(patchFile, next);
console.log(`declared preset "${id}" in ${patchFile}`);
console.log(`restart dsh --profile ${profile}, then select "Hypercompact (${from})" in the preset picker`);
