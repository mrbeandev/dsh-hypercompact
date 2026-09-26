#!/usr/bin/env node
/**
 * Release gate: run by `prepublishOnly` and `npm run verify`.
 *
 * Checks package metadata, that the packed file list contains every runtime
 * file and nothing private (session logs, fixtures, credentials), that every
 * module parses, and that no forbidden mechanism (client bundle, settings
 * namespace, settings slot) crept in.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const problems = [];
const check = (condition, message) => { if (!condition) problems.push(message); };

// ── metadata ────────────────────────────────────────────────────────────────
check(pkg.name === 'dsh-hypercompact', 'package name must be dsh-hypercompact');
check(pkg.license === 'MIT', 'license must be MIT');
check(pkg.repository?.url?.includes('github.com/'), 'repository URL missing');
check(pkg.type === 'module', 'package must be ESM');
check(pkg.exports?.['.'] === './index.mjs', 'exports "." must be ./index.mjs');
check(pkg.dsh?.client === undefined, 'v1 must not declare a client bundle (dsh.client)');
check(pkg.publishConfig?.access === 'public', 'publishConfig.access must be public');
check(pkg.engines?.node !== undefined, 'engines.node is required');
check(pkg.author !== undefined, 'author is required');
for (const doc of ['README.md', 'RELEASE.md']) {
  const text = readFileSync(join(root, doc), 'utf8');
  if (/\/home\/[a-z]|\/mnt\/main_disk/.test(text)) problems.push(`${doc}: contains an absolute user path`);
  if (!text.includes(pkg.name)) problems.push(`${doc}: does not mention ${pkg.name}`);
}
check(pkg.dependencies === undefined || Object.keys(pkg.dependencies).length === 0, 'runtime dependencies are not allowed; harness packages come from the running dsh');

// ── forbidden mechanisms in source ──────────────────────────────────────────
const sources = ['index.mjs', ...readdirSync(join(root, 'lib')).map((file) => `lib/${file}`), ...readdirSync(join(root, 'scripts')).filter((file) => file.endsWith('.mjs')).map((file) => `scripts/${file}`)];
for (const file of sources) {
  const text = readFileSync(join(root, file), 'utf8');
  // Personal or machine-specific details must not ship in a public package.
  if (/\/home\/[a-z]|\/mnt\/main_disk|\/Users\/[A-Za-z]|C:\\\\Users/.test(text)) problems.push(`${file}: contains an absolute user path`);
  // The gate's own pattern list would match itself.
  for (const [pattern, reason] of file === 'scripts/check-release.mjs' ? [] : [
    [/settingsScope|settings\.plugin\.item|installSettingsSection|settingsNamespace/, 'settings UI integration is out of scope for v1'],
    [/__ModuleLoader__/, 'client module loading is out of scope for v1'],
    [/\bllm\.stream\s*\(|ctx\.llm\.stream/, 'compaction must make no LLM calls'],
    [/\beval\s*\(|new Function\s*\(/, 'no dynamic code evaluation'],
  ]) {
    check(!pattern.test(text), `${file}: ${reason}`);
  }
  try {
    execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'pipe' });
  } catch (error) {
    problems.push(`${file}: syntax error: ${error.stderr?.toString().trim()}`);
  }
}

// ── packed file list ────────────────────────────────────────────────────────
let packed = [];
try {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  packed = JSON.parse(output)[0].files.map((file) => file.path);
} catch (error) {
  problems.push(`npm pack --dry-run failed: ${error.message}`);
}
if (packed.length > 0) {
  const required = ['index.mjs', 'package.json', 'README.md', 'LICENSE', 'cordis.patch.yml', ...sources.filter((file) => file.startsWith('lib/'))];
  for (const file of required) check(packed.includes(file), `packed artifact is missing ${file}`);
  const forbidden = /\.(zstd|jsonl|tgz|log)$|(^|\/)(fixtures|\.private|\.env|\.cache)(\/|$)|\.npmrc$|REVIEW\.md$/;
  for (const file of packed) check(!forbidden.test(file), `packed artifact must not contain ${file}`);
}

if (problems.length > 0) {
  console.error(`dsh-hypercompact release check failed:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`dsh-hypercompact release check passed (${packed.length} files packed).`);
