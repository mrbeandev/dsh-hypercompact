/**
 * The dsh-hypercompact compaction engine.
 *
 * Implements the public `ctx.compaction` contract (`compactIfNeeded`,
 * `compactNow`, `compactRegion`) with the same durable transaction protocol
 * as `@deepseek-ai/dsh-compaction-basic`:
 *
 *   compaction/start → compaction/summary → user/message(replace) → compaction/end
 *
 * The only difference is how the replacement is produced: a deterministic
 * local compiler instead of an LLM call. Between the target and the trigger,
 * a lighter housekeeping pass trims old tool results and images in place
 * (content-only replacements, no checkpoint). `compaction/summary` carries the
 * same fields basic writes (`summary`, `shadowedRange`, `shadowedSeqs`,
 * `shadowedTokenCount`, `provider`, `model`), so `/compact`, the token meter
 * and dsh-context keep working unchanged.
 *
 * The harness classes are injected by `createEngineClass(runtime)` because
 * they must come from the running DSH install, never from a second copy.
 *
 * @module dsh-hypercompact/engine
 */

import { randomUUID } from 'node:crypto';
import { resolveConfig, resolvePolicy } from './config.mjs';
import { compileCheckpoint, CHECKPOINT_OPEN_TAG } from './compiler.mjs';
import {
  selectRange, selectIntraTurnRange, requestBytes, retentionLimit, firstCompactable,
  selectionCheckpointEstimate, checkpointBudgetFor,
} from './select.mjs';
import { SurfaceIndex } from './surface.mjs';
import { messageBytes, utf8Bytes } from './bytes.mjs';
import { planImageOffload, offloadedResultMessage, captionAfter } from './images.mjs';
import { planResultTrim, trimmedResultMessage } from './housekeeping.mjs';
import { toolResultsOf, toolResultOfEvent } from './messages.mjs';
import { pinsFor, releasePins } from './pins.mjs';
import { createStatsWriter } from './stats.mjs';

export const ENGINE_PROVIDER = 'dsh-hypercompact';
export const ENGINE_MODEL = 'deterministic-compiler-v1';
export const LOG_PREFIX = '[hypercompact]';

/** Failure codes pi-ai / the agent loop use for upload timeouts and body-size rejections. */
const TIMEOUT_CODES = new Set(['TIMEOUT', 'TRANSPORT']);
const PAYLOAD_TOO_LARGE_RE = /\b413\b|payload too large|request body too large|length limit exceeded/i;

/** Thrown when the surface changed between selection and commit. */
export class SurfaceChangedError extends Error {}

/** Resolve the provider/model the session last routed, if any. */
export function routedTarget(session) {
  const config = session.requestHeader()?.config;
  if (!config || !config.provider || !config.model) return undefined;
  return { provider: config.provider, model: config.model };
}

/** Scan back for an open turn, an unmatched compaction/start, and the latest end-seed. */
export function inspectEntryState(session) {
  let openTurn = null;
  let openTurnKnown = false;
  let unmatchedStart;
  let lockKnown = false;
  let latestEndSeedSeq;
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq);
    if (latestEndSeedSeq === undefined && event.type === 'session/end-seed') latestEndSeedSeq = event.seq;
    if (!lockKnown) {
      if (event.type === 'compaction/start') {
        unmatchedStart = event;
        lockKnown = true;
      } else if (event.type === 'compaction/end') lockKnown = true;
    }
    if (!openTurnKnown) {
      if (event.type === 'turn/start') {
        openTurn = event.data.turn;
        openTurnKnown = true;
      } else if (event.type === 'turn/end') openTurnKnown = true;
    }
    if (openTurnKnown && lockKnown && latestEndSeedSeq !== undefined) break;
  }
  return { openTurn, unmatchedStart, latestEndSeedSeq };
}

function lockActive(state) {
  return state.unmatchedStart !== undefined && !(state.latestEndSeedSeq !== undefined && state.latestEndSeedSeq > state.unmatchedStart.seq);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

export function fmtBytes(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

function fmtTokens(tokens) {
  return tokens === undefined ? '?' : `~${tokens}`;
}

/**
 * Build the engine class against the running harness.
 * @param {object} runtime - { CompactionEngine, ManualCompactionError, CompactionId,
 *   compactCheckpointSource, toolPairingBalancedBefore, toolPairingBalancedAfter,
 *   createUserMessage, errorChain, CONTEXT_WINDOW_EXCEEDED_CODE, z }
 */
export function createEngineClass(runtime) {
  const {
    CompactionEngine,
    ManualCompactionError,
    CompactionId,
    compactCheckpointSource,
    toolPairingBalancedBefore,
    toolPairingBalancedAfter,
    createUserMessage,
    errorChain,
    freezeMessage,
    CONTEXT_WINDOW_EXCEEDED_CODE,
  } = runtime;

  return class HyperCompactionEngine extends CompactionEngine {
    static inject = ['tokenMeter', 'sessions'];

    constructor(ctx, config) {
      super(ctx);
      const { toolNames, ...engineConfig } = config ?? {};
      this.config = resolveConfig(engineConfig);
      this.toolNames = toolNames ?? {};
      this.indexes = new WeakMap();
      this.recoveryRetries = new WeakMap();
      this.lastDecision = new WeakMap();
      this.warned = new Set();
      this.idleHousekeeping = new WeakMap();
      this.stats = createStatsWriter(this.config.statsDir, (message) => this.warnOnce('stats', `${LOG_PREFIX} ${message}`));
      if (this.config.auto) this.registerAutomatic();
      ctx.logger.info(`${LOG_PREFIX} engine ready: trigger ${fmtBytes(this.config.maxRequestBytes)} → target ${fmtBytes(this.config.targetRequestBytes)}${this.config.dryRun ? ' (dry run)' : ''}`);
    }

    index(session) {
      let index = this.indexes.get(session);
      if (index === undefined) {
        index = new SurfaceIndex();
        this.indexes.set(session, index);
      }
      return index;
    }

    /** Register the pre-step byte trigger and timeout/overflow recovery. */
    registerAutomatic() {
      const { ctx } = this;
      ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
        if (!signal.aborted) {
          try {
            await this.compactIfNeeded(agent, 'pressure', signal);
          } catch (error) {
            // Fail open: never block a turn because of compaction.
            ctx.logger.warn(`${LOG_PREFIX} pre-step compaction skipped: ${errorText(error)}`);
          }
        }
        return next();
      });

      ctx.on('agent/status', ({ agent, status }) => {
        if (status === 'idle') this.recoveryRetries.delete(agent);
      });

      ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
        if (signal.aborted || failure === undefined) return next();
        const overflow = failure.code === CONTEXT_WINDOW_EXCEEDED_CODE;
        const tooLarge = PAYLOAD_TOO_LARGE_RE.test(failure.message ?? '');
        const timeout = this.config.recoverOnTimeout && TIMEOUT_CODES.has(failure.code);
        if (!overflow && !tooLarge && !timeout) return next();
        if (this.config.dryRun) return next();
        const retries = this.recoveryRetries.get(agent) ?? 0;
        if (retries >= this.config.maxRecoveryRetries) return next();
        const generation = agent.session.surface.replaceGeneration;
        try {
          // A timeout only warrants recovery if the body is actually large;
          // compacting a small session would not help and costs a cache miss.
          const result = await this.compactIfNeeded(agent, overflow || tooLarge ? 'context-overflow' : 'request-timeout', signal);
          if (result === null || signal.aborted || agent.session.surface.replaceGeneration <= generation) return next();
          this.recoveryRetries.set(agent, retries + 1);
          ctx.logger.info(`${LOG_PREFIX} retrying request after ${failure.code} recovery compaction`);
          return { kind: 'retry' };
        } catch (error) {
          ctx.logger.warn(`${LOG_PREFIX} recovery compaction failed: ${errorText(error)}`);
          return next();
        }
      });
    }

    /**
     * Measure the next request and, when it exceeds a trigger, compact.
     * @param agent - agent whose session is measured.
     * @param {'pressure' | 'context-overflow' | 'request-timeout'} trigger
     * @param signal - turn cancellation signal.
     * @returns the committed result, or null when nothing ran.
     */
    async compactIfNeeded(agent, trigger, signal) {
      const session = agent.session;
      const target = routedTarget(session);
      const policy = resolvePolicy(this.config, target);
      const index = this.index(session);
      const view = index.view(session);
      const bytes = requestBytes(view);
      const tokens = this.measureTokens(session);
      const tokenLimit = await this.tokenLimit(policy, target, signal);
      const overTokens = tokenLimit > 0 && tokens !== undefined && tokens >= tokenLimit;

      let reason = null;
      if (trigger === 'context-overflow') reason = 'context overflow';
      else if (bytes >= policy.maxRequestBytes) reason = `request ${fmtBytes(bytes)} ≥ ${fmtBytes(policy.maxRequestBytes)}`;
      else if (overTokens) reason = `~${tokens} tokens ≥ ${tokenLimit}`;
      else if (trigger === 'request-timeout' && bytes >= policy.targetRequestBytes) reason = `upload timeout with ${fmtBytes(bytes)} body`;
      if (reason === null) {
        if (trigger === 'pressure' && policy.housekeepingBytes > 0 && bytes >= policy.housekeepingBytes && !this.config.dryRun) {
          // Skip the O(surface) scan while nothing changed since a pass found nothing to do.
          const key = `${session.surface.replaceGeneration}:${view.nodes.length}`;
          if (this.idleHousekeeping.get(session) !== key && !lockActive(inspectEntryState(session))) {
            const done = this.housekeep(session, policy, bytes, `housekeeping: request ${fmtBytes(bytes)} ≥ ${fmtBytes(policy.housekeepingBytes)}`);
            if (!done) this.idleHousekeeping.set(session, key);
          }
        }
        return null;
      }
      // The lock scan walks the log backwards, so only pay for it once triggered.
      if (lockActive(inspectEntryState(session))) return null;

      const force = trigger !== 'pressure' || (overTokens && bytes < policy.maxRequestBytes);
      return this.runCompaction(agent, {
        owner: 'current-turn',
        view,
        policy,
        force,
        reason,
        bytesBefore: bytes,
        tokensBefore: tokens,
        signal,
      });
    }

    /**
     * Estimated request tokens. A meter failure disables only the token
     * trigger (the byte trigger still applies) and is reported once, so a
     * silently dead `contextRatio` trigger cannot go unnoticed.
     * @returns {number | undefined} undefined when the meter is unavailable.
     */
    measureTokens(session) {
      try {
        const total = this.ctx.tokenMeter.measure(session).totalTokens;
        return Number.isFinite(total) ? total : undefined;
      } catch (error) {
        this.warnOnce('token-meter', `${LOG_PREFIX} token meter unavailable (${errorText(error)}); only the byte trigger is active`);
        return undefined;
      }
    }

    warnOnce(key, message) {
      if (this.warned.has(key)) return;
      this.warned.add(key);
      this.ctx.logger.warn(message);
    }

    /** Effective token trigger: explicit maxTokens, else contextRatio × window. */
    async tokenLimit(policy, target, signal) {
      let limit = policy.maxTokens > 0 ? policy.maxTokens : 0;
      if (policy.contextRatio > 0 && target !== undefined) {
        try {
          const llm = this.ctx.get('llm');
          const info = llm === undefined ? undefined : await llm.resolveModelInfo(target.provider, target.model, signal);
          const window = info?.context?.contextWindow;
          if (Number.isInteger(window) && window > 0) {
            const byRatio = Math.floor(window * policy.contextRatio);
            limit = limit > 0 ? Math.min(limit, byRatio) : byRatio;
          }
        } catch {
          /* model info is optional; the byte trigger still applies */
        }
      }
      return limit;
    }

    /**
     * Force one compaction of everything outside retention, for /compact.
     * Resolves only after the markers are durably flushed.
     */
    compactNow(agent, signal, sourceCommandId) {
      signal.throwIfAborted();
      try {
        return agent.runMaintenance(async (agentSignal) => {
          const operationSignal = AbortSignal.any([agentSignal, signal]);
          try {
            operationSignal.throwIfAborted();
            const session = agent.session;
            const policy = resolvePolicy(this.config, routedTarget(session));
            const view = this.index(session).view(session);
            return await this.runCompaction(agent, {
              owner: null,
              view,
              policy,
              force: true,
              reason: 'manual /compact',
              bytesBefore: requestBytes(view),
              tokensBefore: this.measureTokens(session),
              signal: operationSignal,
              sourceCommandId,
              manual: true,
            });
          } catch (error) {
            if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
              throw new ManualCompactionError('cancelled', 'manual compaction was cancelled', { cause: error });
            }
            operationSignal.throwIfAborted();
            throw error;
          }
        });
      } catch (error) {
        throw new ManualCompactionError('busy', 'manual compaction requires an idle agent with no waking queued work', { cause: error });
      }
    }

    /** Compact an explicit inclusive surface range inside the open turn. */
    async compactRegion(start, end, agent, signal) {
      const session = agent.session;
      const view = this.index(session).view(session);
      const startIdx = view.nodes.findIndex((node) => node.seq === start);
      const endIdx = view.nodes.findIndex((node) => node.seq === end);
      if (startIdx === -1) throw new Error(`compactRegion: start seq ${start} not found in surface`);
      if (endIdx === -1) throw new Error(`compactRegion: end seq ${end} not found in surface`);
      if (startIdx > endIdx) throw new Error(`compactRegion: start seq ${start} is after end seq ${end}`);
      return this.runCompaction(agent, {
        owner: 'current-turn',
        view,
        policy: resolvePolicy(this.config, routedTarget(session)),
        range: { startIdx, endIdx },
        reason: 'explicit region',
        bytesBefore: requestBytes(view),
        tokensBefore: this.measureTokens(session),
        signal,
      });
    }


    /**
     * Select, compile, and commit one compaction. Synchronous from lock to
     * release (no awaits between compaction/start and compaction/end), so the
     * surface cannot change mid-transaction.
     */
    async runCompaction(agent, job) {
      const started = performance.now();
      const session = agent.session;
      const { view, policy } = job;
      if (job.manual) {
        // Report busy before doing any work, like compaction-basic.
        const entry = inspectEntryState(session);
        if (lockActive(entry)) throw new ManualCompactionError('busy', 'compaction already in progress for this session');
        if (entry.openTurn !== null) throw new ManualCompactionError('busy', 'manual compaction: the session already has an open turn');
      }
      const estimate = selectionCheckpointEstimate(policy, this.config.minCheckpointBytes);
      let range = job.range ?? selectRange(view, policy, { checkpointBytes: estimate, force: job.force });
      let scope = job.range ? 'region' : 'history';
      if (job.range === undefined && this.config.allowIntraTurn && (job.force || job.bytesBefore >= policy.maxRequestBytes)) {
        // Retention can hold most of the bytes (one long autonomous turn).
        // If compacting older history cannot reach the target, compact the
        // older tool traffic of the current turn instead, whichever frees more.
        const removable = (candidate) => (candidate === null ? 0 : view.nodes.slice(candidate.startIdx, candidate.endIdx + 1).reduce((total, node) => total + node.bytes, 0));
        const needed = job.bytesBefore - policy.targetRequestBytes + estimate;
        if (removable(range) < needed) {
          const inner = selectIntraTurnRange(view, policy, { checkpointBytes: estimate, force: job.force });
          if (removable(inner) > removable(range)) {
            range = inner;
            scope = 'current turn';
          }
        }
      }
      if (range === null) {
        // Nothing to compact, but older inline images in the retained tail
        // can still be offloaded (the usual cause of huge bodies).
        if (!this.config.dryRun && !lockActive(inspectEntryState(session))) {
          const done = this.housekeep(session, policy, job.bytesBefore, `${job.reason}: nothing compactable outside retention`, job.force);
          if (done && job.manual) await this.ctx.sessions.flush(session);
          if (done) return null;
        }
        this.logOnce(session, `${LOG_PREFIX} ${job.reason}: nothing compactable outside the retained tail`);
        return null;
      }
      const offloadPlan = planImageOffload(view.nodes, 0, this.config.keepRecentImages, this.config.maxKeptImageBytes)
        .filter(({ index }) => index > range.endIdx);
      const retainedSavings = offloadPlan.reduce((total, { node }) => total + node.bytes, 0);
      const budget = checkpointBudgetFor(view, range, policy, this.config.minCheckpointBytes, retainedSavings);
      const nodes = view.nodes.slice(range.startIdx, range.endIdx + 1);
      const shadowedSeqs = nodes.map((node) => node.seq);
      const start = shadowedSeqs[0];
      const end = shadowedSeqs.at(-1);

      // Validate against the authoritative balance helpers (throws on corrupt surface).
      if (!toolPairingBalancedBefore(session, start)) throw new Error(`hypercompact: start seq ${start} is not a balanced boundary`);
      if (!toolPairingBalancedAfter(session, end)) throw new Error(`hypercompact: end seq ${end} is not a balanced boundary`);

      const pinnedSeqs = pinsFor(session);
      const compiled = compileCheckpoint(nodes, { ...this.config, toolNames: this.toolNames, pinnedSeqs }, budget);
      if (compiled.stats.overBudget > 0) {
        this.ctx.logger.warn(`${LOG_PREFIX} checkpoint exceeds its ${fmtBytes(budget)} budget by ${fmtBytes(compiled.stats.overBudget)} to keep user messages and pinned content intact`);
      }
      const shadowedBytes = nodes.reduce((total, node) => total + node.bytes, 0);
      const summary = [{ type: 'text', text: compiled.framed }];
      const bytesAfterEstimate = job.bytesBefore - shadowedBytes + messageBytes({ role: 'user', content: summary, source: { kind: 'plugin', plugin: 'compact', compactionId: '00000000-0000-0000-0000-000000000000' } });

      if (bytesAfterEstimate >= job.bytesBefore) {
        this.logOnce(session, `${LOG_PREFIX} ${job.reason}: checkpoint would not shrink the request; skipped`);
        if (job.manual) throw new ManualCompactionError('summary', 'the compiled checkpoint is not smaller than the history it replaces');
        return null;
      }

      if (this.config.dryRun) {
        this.ctx.logger.info(`${LOG_PREFIX} [dry run] ${job.reason}: would replace ${nodes.length} nodes (seq ${start}–${end}), ${fmtBytes(job.bytesBefore)} → ~${fmtBytes(bytesAfterEstimate)}, checkpoint ${fmtBytes(compiled.bytes)}`);
        return null;
      }

      job.signal?.throwIfAborted();
      const entry = inspectEntryState(session);
      if (lockActive(entry)) throw new ManualCompactionError('busy', 'compaction already in progress for this session');
      let owner;
      if (job.owner === null) {
        if (entry.openTurn !== null) throw new ManualCompactionError('busy', 'manual compaction: the session already has an open turn');
        owner = null;
      } else {
        if (entry.openTurn === null) throw new Error('hypercompact: automatic compaction must run inside an open turn');
        owner = entry.openTurn;
      }
      // The surface must still be exactly what was measured.
      const liveNodes = session.surface.nodes;
      if (liveNodes.length !== view.nodes.length || liveNodes.some((seq, index) => seq !== view.nodes[index].seq)) {
        throw job.manual
          ? new ManualCompactionError('changed', 'the session changed before compaction could commit')
          : new SurfaceChangedError('hypercompact: surface changed before commit');
      }

      const shadowedTokenCount = nodes.reduce((total, node) => total + (node.message ? this.ctx.tokenMeter.estimateMessage(node.message) : 0), 0);
      const compactionId = CompactionId(randomUUID());
      const lifecycle = {
        compactionId,
        ...(job.sourceCommandId === undefined ? {} : { sourceCommandId: job.sourceCommandId }),
        turn: owner,
      };
      const startEvent = session.append('compaction/start', lifecycle);
      let result;
      let failure;
      try {
        const summaryEvent = session.append('compaction/summary', {
          compactionId,
          ...(job.sourceCommandId === undefined ? {} : { sourceCommandId: job.sourceCommandId }),
          summary,
          shadowedRange: { start, end },
          shadowedSeqs: [...shadowedSeqs],
          shadowedTokenCount,
          provider: ENGINE_PROVIDER,
          model: ENGINE_MODEL,
        });
        session.append('user/message', createUserMessage({
          content: summary,
          source: compactCheckpointSource(compactionId, job.sourceCommandId),
        }), {
          surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
          sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
        });
        const endEvent = session.append('compaction/end', lifecycle);
        result = {
          compactionId,
          ...(job.sourceCommandId === undefined ? {} : { sourceCommandId: job.sourceCommandId }),
          startSeq: startEvent.seq,
          summarySeq: summaryEvent.seq,
          endSeq: endEvent.seq,
          summary,
          shadowedRange: { start, end },
          shadowedSeqs: [...shadowedSeqs],
          shadowedTokenCount,
        };
      } catch (error) {
        failure = error;
        try {
          session.append('compaction/end', { ...lifecycle, error: errorChain(error) });
        } catch {
          /* a failed close leaves the unmatched start as the intended busy signal */
        }
      }
      if (failure !== undefined) {
        if (job.manual) throw new ManualCompactionError('commit', 'manual compaction did not commit cleanly', { cause: failure });
        throw failure;
      }

      releasePins(session, shadowedSeqs);
      // Still over target? Inline images in the retained tail are usually why.
      const offloaded = this.offloadImages(session, policy, job.force);

      if (job.manual) {
        try {
          await this.ctx.sessions.flush(session);
        } catch (error) {
          throw new ManualCompactionError('persistence', 'manual compaction durability checkpoint failed', { cause: error });
        }
      }

      const after = this.index(session).view(session);
      const bytesAfter = requestBytes(after);
      const tokensAfter = this.measureTokens(session);
      const elapsed = performance.now() - started;
      const stats = compiled.stats;
      this.ctx.logger.info(
        `${LOG_PREFIX} ${job.reason}: replaced ${nodes.length} nodes of ${scope} (seq ${start}–${end}; ${stats.toolCalls} tool calls, ${stats.userMessages} user messages kept verbatim) `
        + `request ${fmtBytes(job.bytesBefore)} → ${fmtBytes(bytesAfter)}, ${fmtTokens(job.tokensBefore)} → ${fmtTokens(tokensAfter)} tokens, `
        + `checkpoint ${fmtBytes(compiled.bytes)} (budget ${fmtBytes(budget)}, degradation ${stats.degradation})${offloaded > 0 ? `, ${offloaded} images offloaded` : ''}, ${elapsed.toFixed(0)} ms`,
      );
      this.record(session, {
        kind: 'compaction',
        reason: job.reason,
        scope,
        compactionId,
        span: { start, end, nodes: nodes.length },
        bytesBefore: job.bytesBefore,
        bytesAfter,
        tokensBefore: job.tokensBefore ?? null,
        tokensAfter: tokensAfter ?? null,
        checkpointBytes: compiled.bytes,
        budgetBytes: budget,
        degradation: stats.degradation,
        entriesElided: stats.entriesElided ?? 0,
        overBudgetBytes: stats.overBudget,
        userMessages: stats.userSeqs,
        userMessagesClipped: stats.userClipped,
        constraints: stats.constraints,
        toolCalls: stats.toolCalls,
        toolErrors: stats.toolErrors,
        groupedCalls: stats.groupedCalls,
        pinned: [...pinnedSeqs].filter((seq) => seq >= start && seq <= end),
        imagesOffloaded: offloaded,
        durationMs: Math.round(elapsed),
      });
      result.bytesBefore = job.bytesBefore;
      result.bytesAfter = bytesAfter;
      return result;
    }

    /**
     * Replace older inline images in retained tool results with text labels
     * until the request fits the target (or only the newest images remain).
     * Uses the harness's content-only tool/result replacement, each preceded
     * by a `compaction/prune` shadow-price event, exactly like the built-in
     * tool-result pruner. Synchronous: no await between appends.
     * @returns {number} number of image blocks removed.
     */
    offloadImages(session, policy, force) {
      const view = this.index(session).view(session);
      let bytes = requestBytes(view);
      if (!force && bytes <= policy.targetRequestBytes) return 0;
      const plan = planImageOffload(view.nodes, 0, this.config.keepRecentImages, this.config.maxKeptImageBytes);
      let removed = 0;
      for (const { index, node } of plan) {
        if (!force && bytes <= policy.targetRequestBytes) break;
        const event = session.eventAt(node.seq);
        const origin = node.resultOrigin ?? node.seq;
        const message = offloadedResultMessage({ data: { message: node.message } }, origin, freezeMessage, captionAfter(view.nodes, index));
        const images = (toolResultsOf(node.message)[0]?.content ?? []).filter((block) => block?.type === 'image' && block.offloaded !== true).length;
        if (!this.replaceResult(session, node.seq, event, message, 'image offload', node.message)) break;
        bytes -= node.bytes - messageBytes(message);
        removed += images;
      }
      return removed;
    }

    /**
     * Content-only rewrite of one tool/result, shadow-priced by an adjacent
     * `compaction/prune` event (the built-in pruner's protocol).
     * @returns {boolean} false when the session rejected the rewrite.
     */
    replaceResult(session, seq, event, message, what, original = event.data.message) {
      try {
        session.append('compaction/prune', {
          shadowedRange: { start: seq, end: seq },
          shadowedSeqs: [seq],
          shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(original),
        });
        session.append('tool/result', { ...event.data, message }, {
          surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
          sourceEventSeqs: [seq],
        });
        return true;
      } catch (error) {
        this.ctx.logger.warn(`${LOG_PREFIX} ${what} stopped at seq ${seq}: ${errorText(error)}`);
        return false;
      }
    }

    /**
     * Housekeeping pass: offload older images, then trim large tool results
     * older than the retained turns, until the request is under the target.
     * No span replacement and no checkpoint. Synchronous.
     * @returns {boolean} whether anything was rewritten.
     */
    housekeep(session, policy, bytesBefore, reason, force = false) {
      const started = performance.now();
      const images = this.offloadImages(session, policy, force);
      let view = this.index(session).view(session);
      let bytes = requestBytes(view);
      let trimmed = 0;
      if (force || bytes > policy.targetRequestBytes) {
        const limit = retentionLimit(view.nodes, firstCompactable(view.nodes), policy);
        const excerpt = this.config.housekeepingExcerpt;
        for (const { node } of planResultTrim(view.nodes, limit, excerpt)) {
          if (!force && bytes <= policy.targetRequestBytes) break;
          const event = session.eventAt(node.seq);
          const message = trimmedResultMessage({ data: { message: node.message } }, node.resultOrigin ?? node.seq, excerpt, freezeMessage);
          if (!this.replaceResult(session, node.seq, event, message, 'result trim', node.message)) break;
          bytes -= node.bytes - messageBytes(message);
          trimmed += 1;
        }
      }
      if (images === 0 && trimmed === 0) return false;
      view = this.index(session).view(session);
      const bytesAfter = requestBytes(view);
      const elapsed = performance.now() - started;
      this.ctx.logger.info(`${LOG_PREFIX} ${reason}: ${images} images offloaded, ${trimmed} old tool results trimmed, request ${fmtBytes(bytesBefore)} → ${fmtBytes(bytesAfter)}, ${elapsed.toFixed(0)} ms`);
      this.record(session, {
        kind: 'housekeeping',
        reason,
        bytesBefore,
        bytesAfter,
        imagesOffloaded: images,
        resultsTrimmed: trimmed,
        durationMs: Math.round(elapsed),
      });
      return true;
    }

    /** Write one content-free observability record (S8). Never throws. */
    record(session, data) {
      const id = session.id ?? 'unknown';
      if (this.config.statsLog) this.stats.write(id, data);
      else this.stats.remember(id, data);
    }

    /**
     * Current size picture for one session (used by /hypercompact).
     * @returns {{ bytes: number, tokens: number | undefined, policy: object, last: object | undefined, images: number }}
     */
    status(session) {
      const policy = resolvePolicy(this.config, routedTarget(session));
      const view = this.index(session).view(session);
      let images = 0;
      for (const node of view.nodes) {
        const results = toolResultsOf(node.message);
        const blocks = results.length > 0 ? results.flatMap((result) => result.content) : (node.message?.content ?? []);
        images += blocks.filter((block) => block?.type === 'image' && block.offloaded !== true).length;
      }
      return { bytes: requestBytes(view), tokens: this.measureTokens(session), policy, last: this.stats.last(session.id ?? 'unknown'), images, nodes: view.nodes.length };
    }

    /** Log a repeated informational message only when it changes. */
    logOnce(session, message) {
      if (this.lastDecision.get(session) === message) return;
      this.lastDecision.set(session, message);
      this.ctx.logger.info(message);
    }
  };
}

/** Whether a text looks like one of our checkpoints (used by tests). */
export function isHyperCheckpointText(text) {
  return typeof text === 'string' && text.includes(CHECKPOINT_OPEN_TAG) && utf8Bytes(text) > 0;
}
