#!/usr/bin/env node
/**
 * Run the test suite once per tool-result format (see test/helpers.mjs):
 * `v1` (dsh 0.1.5 wrapped blocks) and `v2` (dsh 0.1.7 tool-role messages).
 * Real-harness tests always use the installed dsh's own format and are
 * skipped when dsh is not installed. Cross-platform (no shell env syntax).
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = readdirSync(join(root, 'test')).filter((file) => file.endsWith('.test.mjs')).map((file) => join('test', file));
const passes = [
  { format: 'v1', files },
  // The fixture-driven unit tests are the ones whose format is chosen here.
  { format: 'v2', files: files.filter((file) => file.endsWith('unit.test.mjs')) },
];
for (const pass of passes) {
  console.log(`\n# tool-result format ${pass.format}`);
  const result = spawnSync(process.execPath, ['--test', ...pass.files], { cwd: root, stdio: 'inherit', env: { ...process.env, HC_FORMAT: pass.format } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
