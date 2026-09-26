/**
 * Per-compaction observability records.
 *
 * One JSON line per compaction (or housekeeping pass) is appended to
 * `<statsDir>/<sessionId>.jsonl`, default `$DSH_HOME/hypercompact/`. Records
 * hold only numbers and seqs — never message content — so they are safe to
 * attach to a bug report. Writing is best-effort: an I/O failure is logged
 * once and never affects the compaction.
 *
 * @module dsh-hypercompact/stats
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Default directory for stats records. */
export function defaultStatsDir() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'hypercompact');
}

/** Session ids are used as file names; keep only safe characters. */
function fileName(sessionId) {
  return `${String(sessionId ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)}.jsonl`;
}

/**
 * Create a writer bound to one directory.
 * @param {string | null} dir - target directory (null = default).
 * @param {(message: string) => void} warn - called once on the first failure.
 */
export function createStatsWriter(dir, warn) {
  const target = dir ?? defaultStatsDir();
  let ready;
  let warned = false;
  const last = new Map();
  return {
    dir: target,
    /** Most recent record per session id (for /hypercompact status). */
    last: (sessionId) => last.get(sessionId),
    /** Append one record; resolves when written, never rejects. */
    async write(sessionId, record) {
      const line = { time: new Date().toISOString(), sessionId, ...record };
      last.set(sessionId, line);
      try {
        ready ??= mkdir(target, { recursive: true, mode: 0o700 });
        await ready;
        await appendFile(join(target, fileName(sessionId)), `${JSON.stringify(line)}\n`, { mode: 0o600 });
      } catch (error) {
        if (!warned) {
          warned = true;
          warn(`stats log disabled: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
    /** Remember a record without writing it (statsLog: false). */
    remember(sessionId, record) {
      last.set(sessionId, { time: new Date().toISOString(), sessionId, ...record });
    },
  };
}
