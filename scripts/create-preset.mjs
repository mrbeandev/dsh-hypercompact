#!/usr/bin/env node
/**
 * Create (or remove) an agent preset that uses dsh-hypercompact.
 *
 *   node scripts/create-preset.mjs [--from standard] [--id hypercompact] [--profile web]
 *                                  [--force] [--print] [--no-install] [--remove]
 *
 * The preset is a copy of a SHIPPED preset (default `standard`) from the
 * installed dsh, with only the `compaction-basic` row replaced by
 * `dsh-hypercompact`. Shipped files are only read, never written. The script
 * detects which preset model the installed dsh uses:
 *
 * - dsh 0.1.5 (directory presets): writes `$DSH_HOME/.agent-presets/<id>/`
 *   (agent.cordis.yml + preset.yml), visible to every profile.
 * - dsh 0.1.7 and 0.2 (preset declarations): writes a small local bundle to
 *   `$DSH_HOME/hypercompact/preset-<id>/` whose cordis.patch.yml declares an
 *   `@deepseek-ai/dsh-agent-preset` row, then installs it into the profile
 *   with `dsh plugin --profile <profile> add` (the documented way to add a
 *   preset). `--no-install` only writes the bundle and prints the command.
 *
 * `--print` writes nothing and prints what would be written. `--remove` deletes
 * what this script created (run it BEFORE uninstalling dsh-hypercompact: a
 * preset naming a missing package cannot mount). After upgrading dsh, run the
 * script again with `--force` so the copy follows the new shipped preset.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, cpSync, rmSync, rmdirSync } from 'node:fs';
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
const noInstall = args.includes('--no-install');

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
const MARKER = 'create-preset.mjs';

function packageDir(name) {
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    return undefined;
  }
}

/** Run the installed dsh CLI (the one this script resolved, not whatever `dsh` is first on PATH). */
function dsh(commandArgs) {
  console.log(`> dsh ${commandArgs.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}`);
  const result = spawnSync(process.execPath, [entry, ...commandArgs], { stdio: 'inherit', env: process.env });
  return result.status === 0;
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

/** Delete a directory tree, then its parent if that is now empty. */
function removeTree(dir) {
  rmSync(dir, { recursive: true, force: true });
  try {
    if (readdirSync(dirname(dir)).length === 0) rmdirSync(dirname(dir));
  } catch {
    /* parent missing or not empty: leave it */
  }
}

/** A 0.1.5 preset directory this script created. */
const legacyDir = join(home, '.agent-presets', id);
const legacyExists = existsSync(join(legacyDir, 'agent.cordis.yml')) && readFileSync(join(legacyDir, 'agent.cordis.yml'), 'utf8').includes(MARKER);

const presetsPackage = packageDir('@deepseek-ai/dsh-agent-presets');
const webApp = packageDir('@deepseek-ai/dsh-web-app');
const directoryModel = presetsPackage !== undefined && existsSync(join(presetsPackage, 'presets', from, 'agent.cordis.yml'));
const declarationModel = !directoryModel && webApp !== undefined && existsSync(join(webApp, 'presets', `${from}.patch.yml`));
if (!directoryModel && !declarationModel) fail(`shipped preset "${from}" not found in this dsh install (${entry})`);

if (directoryModel) {
  // ── dsh 0.1.5: directory presets ────────────────────────────────────────
  const source = join(presetsPackage, 'presets', from);
  if (remove) {
    if (!existsSync(legacyDir)) fail(`no preset at ${legacyDir}`);
    if (!legacyExists) fail(`${legacyDir} was not created by this script; remove it by hand`);
    if (printOnly) {
      console.log(`would delete ${legacyDir}`);
      process.exit(0);
    }
    removeTree(legacyDir);
    console.log(`removed preset "${id}" (${legacyDir})`);
    process.exit(0);
  }
  const composition = `# Local copy of the shipped "${from}" preset with dsh-hypercompact as the
# compaction engine. Generated by dsh-hypercompact/scripts/${MARKER}.
# Only the compaction-basic row below was changed.

${swapCompactionRow(readFileSync(join(source, 'agent.cordis.yml'), 'utf8'), `${from}/agent.cordis.yml`)}`;
  if (printOnly) {
    process.stdout.write(composition);
    process.exit(0);
  }
  if (existsSync(legacyDir) && !force) fail(`${legacyDir} already exists; pass --force to overwrite it`);
  mkdirSync(legacyDir, { recursive: true });
  // Carry any preset-local assets (skills, etc.) along with the composition.
  for (const item of readdirSync(source, { withFileTypes: true })) {
    if (item.name === 'agent.cordis.yml' || item.name === 'preset.yml') continue;
    cpSync(join(source, item.name), join(legacyDir, item.name), { recursive: true });
  }
  writeFileSync(join(legacyDir, 'agent.cordis.yml'), composition);
  writeFileSync(join(legacyDir, 'preset.yml'), `name: Hypercompact (${from})
description: The shipped "${from}" coding agent with dsh-hypercompact — deterministic, zero-LLM, byte-budget compaction and recall of compacted history.
`);
  console.log(`created preset "${id}" at ${legacyDir}`);
  console.log('Next: restart dsh, start a NEW session, and pick "Hypercompact" in the preset picker before the first message.');
  process.exit(0);
}

// ── dsh 0.1.7 / 0.2: a local bundle declaring the preset ────────────────────
const bundleDir = join(home, 'hypercompact', `preset-${id}`);
const bundleName = id === 'hypercompact' ? 'dsh-hypercompact-preset' : `dsh-hypercompact-preset-${id}`;
const profileDir = join(home, 'profiles', profile);

function installedInProfile() {
  try {
    return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dependencies?.[bundleName] !== undefined;
  } catch {
    return false;
  }
}

if (remove) {
  const installed = installedInProfile();
  if (!installed && !existsSync(bundleDir) && !legacyExists) fail(`nothing to remove: no ${bundleName} in profile "${profile}", no ${bundleDir}`);
  if (printOnly) {
    if (installed) console.log(`would run: dsh plugin --profile ${profile} remove ${bundleName}`);
    if (existsSync(bundleDir)) console.log(`would delete ${bundleDir}`);
    if (legacyExists) console.log(`would delete the old 0.1.5 preset folder ${legacyDir}`);
    process.exit(0);
  }
  if (installed && !dsh(['plugin', '--profile', profile, 'remove', bundleName])) fail(`could not remove ${bundleName}; run: dsh plugin --profile ${profile} remove ${bundleName}`);
  if (existsSync(bundleDir)) removeTree(bundleDir);
  if (legacyExists) removeTree(legacyDir);
  console.log(`removed preset "${id}" (bundle ${bundleName}) from profile "${profile}"`);
  console.log('Restart dsh to apply.');
  process.exit(0);
}

if (!existsSync(join(profileDir, 'package.json'))) fail(`profile "${profile}" does not exist at ${profileDir}; start it once with: dsh --profile ${profile}`);
if (existsSync(bundleDir) && !force) fail(`${bundleDir} already exists; pass --force to regenerate it (for example after upgrading dsh)`);

const shipped = readFileSync(join(webApp, 'presets', `${from}.patch.yml`), 'utf8');
let declaration = shipped.split('\n').filter((line) => !line.startsWith('#')).join('\n').trim();
if (!/^- insert:\n {4}- id: preset-[a-z0-9-]+\n/.test(declaration)) fail(`unexpected layout in ${from}.patch.yml; edit the preset by hand (see README)`);
declaration = declaration
  .replace(/^( {4}- id: )preset-[a-z0-9-]+$/m, `$1preset-${id}`)
  .replace(/^( {8}id: )[a-z0-9-]+$/m, `$1${id}\n        name: Hypercompact (${from})\n        description: The shipped "${from}" coding agent with dsh-hypercompact (deterministic, zero-LLM, byte-budget compaction).`)
  .replace(/^ {8}order: \d+\n/m, '');
declaration = swapCompactionRow(`${declaration}\n`, `${from}.patch.yml`);
const patch = `# Preset "${id}": a copy of the shipped "${from}" preset with dsh-hypercompact
# as the compaction engine. Generated by dsh-hypercompact/scripts/${MARKER}.
# Only the compaction row was changed. Regenerate with --force after upgrading dsh.
${declaration}`;
const manifest = `${JSON.stringify({
  name: bundleName,
  version: '1.0.0',
  private: true,
  description: `Agent preset "${id}" using dsh-hypercompact (generated by dsh-hypercompact/scripts/${MARKER})`,
  type: 'module',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, null, 2)}\n`;

if (printOnly) {
  console.log(`# ${join(bundleDir, 'package.json')}\n${manifest}\n# ${join(bundleDir, 'cordis.patch.yml')}\n${patch}`);
  process.exit(0);
}
mkdirSync(bundleDir, { recursive: true });
writeFileSync(join(bundleDir, 'package.json'), manifest);
writeFileSync(join(bundleDir, 'cordis.patch.yml'), patch);
console.log(`wrote preset bundle ${bundleName} to ${bundleDir}`);

if (legacyExists) {
  // dsh 0.1.7+ no longer reads .agent-presets/; the old copy is dead weight.
  removeTree(legacyDir);
  console.log(`removed the old 0.1.5 preset folder ${legacyDir} (this dsh no longer reads it)`);
}

const installCommand = ['plugin', '--profile', profile, 'add', `link:${bundleDir}`];
if (noInstall) {
  console.log(`Next: dsh ${installCommand.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}`);
  process.exit(0);
}
if (installedInProfile()) {
  console.log(`${bundleName} is already installed in profile "${profile}" (linked, so the new files apply on restart)`);
} else if (!dsh(installCommand)) {
  fail(`could not install the preset bundle; run: dsh ${installCommand.join(' ')}`);
}
console.log('Next: restart dsh, start a NEW session, and pick "Hypercompact" in the preset picker before the first message.');
