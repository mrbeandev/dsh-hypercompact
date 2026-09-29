# dsh-hypercompact

Deterministic, zero-LLM, byte-budget context compaction for DeepSeek Harness (DSH),
with byte-exact recall of everything it compacts.

[![npm version](https://img.shields.io/npm/v/dsh-hypercompact.svg)](https://www.npmjs.com/package/dsh-hypercompact)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.1.5--rc.2%20%E2%86%92%20%3C0.3.0-informational.svg)](#supported-dsh-versions)

- **Source code:** [github.com/mrbeandev/dsh-hypercompact](https://github.com/mrbeandev/dsh-hypercompact)
- **npm package:** [npmjs.com/package/dsh-hypercompact](https://www.npmjs.com/package/dsh-hypercompact)

Long DSH sessions eventually fail because every request re-uploads the whole
conversation. dsh-hypercompact keeps that request small: when it grows past a
byte limit, it compacts old history locally in milliseconds, with no extra model
call. Everything you typed stays word for word, and the agent can restore any
compacted tool output exactly with the `recall` tool.

**Contents:** [Supported DSH versions](#supported-dsh-versions) · [Installation](#installation) ·
[Check that it is working](#check-that-it-is-working) ·
[Which sessions use it?](#which-sessions-use-it) · [Uninstall](#uninstall) ·
[Why this plugin exists](#why-this-plugin-exists) · [Configuration](#configuration) ·
[How it works](#how-it-works) · [Recall tools](#recall-tools) ·
[Requirements](#requirements) · [Known limits](#known-limits)

## Supported DSH versions

**Supported range: DSH `0.1.5-rc.2` up to (not including) `0.3.0`**, with
dsh-hypercompact `0.2.0` or later. Check yours with `dsh --version`.

| DSH version | npm tag (at the time of this release) | Status | Preset created by `create-preset.mjs` |
|---|---|---|---|
| `0.2.0-rc.1` | `next` | ✅ Tested | preset bundle, installed with `dsh plugin add` |
| `0.1.7-rc.2` | `latest` | ✅ Tested | preset bundle, installed with `dsh plugin add` |
| `0.1.5-rc.3` | — | ✅ Tested | folder `~/.dsh/.agent-presets/hypercompact/` |
| `0.1.5-rc.2` | — | ✅ Tested | folder `~/.dsh/.agent-presets/hypercompact/` |
| other `0.1.5-rc.2` … `0.2.x` releases | — | ⚠️ Works, untested: loads with a warning after an API check | detected automatically |
| `0.1.5-rc.1` and older | — | ❌ Not supported: no compaction API | — |
| `0.3.0` and newer | — | ❌ Refused until tested (override: `allowUntestedHarness: true`) | — |

**Which dsh-hypercompact version do I need?**

| dsh-hypercompact | Works with DSH |
|---|---|
| `0.2.0` and later | `0.1.5-rc.2` … `<0.3.0` (0.1.5, 0.1.7, 0.2) |
| `0.1.0` | `0.1.5-rc.2` … `<0.2.0` (0.1.5, 0.1.7). **Refuses to load on DSH 0.2.** |

"Refused" means the plugin logs a clear error at startup and does not load; it
never half-loads or touches your sessions. The engine works the same on every
supported version; only the way a preset is installed differs (see Step 2
below). After upgrading DSH, see [Upgrading DSH](#upgrading-dsh).

## Installation

Installing takes **three steps**: add the package, create a preset that uses
it, and start a **new** session on that preset. The package on its own does
nothing. DSH picks a compaction engine per *preset*, so the plugin runs only in
sessions that use a preset containing it.

### Step 1: add the package to your DSH profile

```sh
dsh plugin --profile web add dsh-hypercompact
```

<details>
<summary>Install from GitHub or a local checkout instead</summary>

```sh
# GitHub
dsh plugin --profile web add github:mrbeandev/dsh-hypercompact

# Local checkout (keep the folder in place: the profile links to it)
git clone https://github.com/mrbeandev/dsh-hypercompact.git
dsh plugin --profile web add "link:$PWD/dsh-hypercompact"
```

</details>

### Step 2: create the "Hypercompact" preset

```sh
node ~/.dsh/profiles/web/node_modules/dsh-hypercompact/scripts/create-preset.mjs
```

This copies DSH's built-in `standard` preset and changes one row: the
compaction engine. Your existing presets are not touched. The script detects
your DSH version and does the right thing for it:

- **DSH 0.1.7 and 0.2:** it writes a small preset bundle to
  `~/.dsh/hypercompact/preset-hypercompact/` and installs it into the profile for
  you (it runs `dsh plugin --profile web add` itself). Output ends with:

  ```text
  + dsh-hypercompact-preset link:~/.dsh/hypercompact/preset-hypercompact
  ```

- **DSH 0.1.5:** it writes the preset folder `~/.dsh/.agent-presets/hypercompact/`:

  ```text
  created preset "hypercompact" at ~/.dsh/.agent-presets/hypercompact
  ```

Not sure which DSH you have? Run `dsh --version`.

- **Windows:** `node %USERPROFILE%\.dsh\profiles\web\node_modules\dsh-hypercompact\scripts\create-preset.mjs`
- **Custom `DSH_HOME`:** use that directory instead of `~/.dsh`.
- **Local checkout:** `node /path/to/dsh-hypercompact/scripts/create-preset.mjs`

### Step 3: restart DSH and start a new session on the preset

1. Stop DSH web and start it again (`dsh web`).
2. Click **New session**.
3. **Before you send the first message**, open the preset picker and choose
   **Hypercompact (standard)**.

To use it for **every** new session instead, make it the default:

- **DSH 0.1.7 and 0.2:** in the web UI's preset picker, set **Hypercompact
  (standard)** as your default preset.
- **DSH 0.1.5:** add this to `~/.dsh/settings.yaml` and restart DSH:

  ```yaml
  agent-presets:
    default: hypercompact
  ```

### Check that it is working

In the session, type:

```text
/hypercompact
```

- **It prints a status report** (request size, trigger values, last
  compaction): the session is using dsh-hypercompact.
- **The command is unknown:** the session is on another preset. Start a new
  session and pick **Hypercompact (standard)** before the first message.

Compaction then happens on its own when the request grows past 5 MB. You can
also run `/compact` at any time.

### Which sessions use it?

| Session | Uses dsh-hypercompact? |
|---|---|
| New session with **Hypercompact (standard)** picked before the first message | **Yes** |
| Any new session, after you make Hypercompact the default preset | **Yes** |
| New session on another preset (`standard`, `ptc`, …) | No |
| **Existing session** (already has messages) | **No.** DSH fixes a session's preset after its first message, so it can't switch compaction engines mid-conversation. |

**Moving an existing conversation over:** start a new Hypercompact session and
mention the old one with `@` (pick it from the list). DSH inserts a size-limited
snapshot of that session so the agent can continue from it.

### Upgrading DSH

After you upgrade DSH (for example 0.1.5 → 0.2), do two things:

1. **Update the plugin**, since a plugin release only accepts the DSH versions
   it knows:

   ```sh
   dsh plugin --profile web add dsh-hypercompact@latest
   ```

2. **Regenerate the preset.** It is a copy of DSH's `standard` preset **at the
   time you created it**, so re-run the script to follow the new version:

   ```sh
   node ~/.dsh/profiles/web/node_modules/dsh-hypercompact/scripts/create-preset.mjs --force
   ```

Then restart DSH.

Going from 0.1.5 to 0.1.7 or later, this is required: newer DSH no longer reads
`~/.dsh/.agent-presets/`, so the old preset silently disappears from the picker.
The script creates the new-style preset and deletes the old folder it made.

**Script options:** `--from ptc` (copy another built-in preset), `--id my-preset`,
`--profile tui` (default `web`), `--force` (overwrite / regenerate), `--print`
(preview, write nothing), `--no-install` (0.1.7+: write the bundle but don't run
`dsh plugin add`), `--remove` (delete everything the script created).

### Uninstall

Remove the preset **first**. A preset that still names the package cannot load
once the package is gone.

```sh
node ~/.dsh/profiles/web/node_modules/dsh-hypercompact/scripts/create-preset.mjs --remove
dsh plugin --profile web remove dsh-hypercompact
```

`--remove` uninstalls the preset bundle (0.1.7+) or deletes the preset folder
(0.1.5). If you made Hypercompact your default preset, pick another default (or
remove `agent-presets.default` from `settings.yaml` on 0.1.5). Sessions that were
already compacted stay readable: their checkpoints are ordinary compaction
checkpoints in the session log.

### Add it to a preset by hand

To put the plugin in your own preset instead of using the script, replace the
`compaction-basic` row inside the preset's `compaction` group. Keep the
`isolate` block: `/compact` and the engine must share that group.

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: hypercompact            # was: compaction-basic
      name: dsh-hypercompact
      config:
        maxRequestBytes: 5000000
        targetRequestBytes: 1500000
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
```

If you ever add a `dsh-hypercompact` row to a profile's `cordis.patch.yml` by
hand, delete it before uninstalling: a row naming a missing package stops the
profile from booting.

## Why this plugin exists

Every model call in a long agent session re-uploads the whole conversation. On a
slow or proxied connection the request **body size**, not the token count, is
what fails: a 20 MB request can take minutes to upload and hit a proxy's
100-second timeout before the model ever sees it. DSH then retries the same
oversized request.

The built-in engine (`@deepseek-ai/dsh-compaction-basic`) cannot help there:

- it triggers on a fraction of the model's context window, which a 1M-token
  model may never reach even while the body is far too large to upload;
- it summarizes by sending the whole history to an LLM, which is the same
  oversized upload that is already failing.

dsh-hypercompact measures the next request in **bytes** and compacts locally in
milliseconds, with no model call. Measured on real sessions, inline screenshots
were 50–92 % of the request body, and tool traffic most of the rest. The plugin
targets both.

## Overview

- **What you wrote is never cut.** Every human message stays verbatim in the
  checkpoint, through any number of later compactions. Your constraints
  ("never …", "do not …", "only …") are pinned at the top. The same protection
  covers a parent agent's task prompt in a subagent session, `/goal` round
  prompts, and team messages.
- **Old tool calls collapse to one line each:** tool name, key arguments, a
  `+N/−M lines` summary for edits, and a pointer to the original. Runs of
  read-only calls (`read ×7: a.js b.js …`) become one line.
- **Old tool results collapse** to status, size, a short head/tail excerpt, and
  a pointer. Failed results keep a larger excerpt.
- **State of work.** A block lists the last files edited, the last commands, and
  unresolved errors.
- **Images.** Older inline images become text labels, captioned with what the
  assistant said about them.
- **Housekeeping.** Between the target and the trigger, a light pass trims old
  tool results in place instead of rewriting history.
- **Recall.** The model gets `recall`, which restores any original
  **byte-exact** from the append-only session log (or just the matching lines of
  a large one), plus `recall_search`. You get `/recall` and `/hypercompact`.
- **Drop-in.** It implements the public `ctx.compaction` contract, so
  `/compact`, the token meter and context charts keep working. No client bundle,
  no settings UI, no patching of harness internals.

### Measured results

Real sessions, measured offline with `npm run measure` (see
[Development](#development)) through pi-ai's own OpenAI-completions
serializer, default configuration. No LLM calls are made.

| Session | Request before | Request after | Replaced | Checkpoint | Degradation | User messages kept verbatim | Time |
|---|---:|---:|---:|---:|:-:|---:|---:|
| A (images + tools) | 19.51 MB | 1.08 MB | 2302 | 503 KB | 1 | 31 / 31 | 149 ms |
| B (images) | 12.37 MB | 0.80 MB | 632 | 221 KB | 0 | 21 / 21 | 96 ms |
| C (images + tools) | 11.42 MB | 1.62 MB | 1337 | 278 KB | 1 | 27 / 27 | 123 ms |
| D (images) | 10.99 MB | 0.86 MB | 483 | 146 KB | 0 | 8 / 8 | 55 ms |
| E (~800k-token session) | 6.40 MB | 1.66 MB | 683 | 222 KB | 0 | 12 / 12 | 86 ms |
| F (mixed) | 3.01 MB | 1.09 MB | 581 | 195 KB | 0 | 2 / 2 | 67 ms |
| G (text only) | 1.11 MB | 0.59 MB | 809 | 229 KB | 0 | 8 / 8 | 68 ms |

Degradation 0 means only reasoning was dropped; 1 means tool-result excerpts
were dropped (call lines and pointers stay). No entry was elided in any
session. Every compacted request had 0 orphaned tool results and 0 unanswered
tool calls, and `recall` returned a sampled tool result byte-identical to the log.

## Configuration

All keys are optional. Unknown keys are rejected at mount, so a typo fails
loudly instead of silently using a default.

| Key | Default | Meaning |
|---|---|---|
| `maxRequestBytes` | `5000000` | Compact when the estimated next request body reaches this many bytes. |
| `targetRequestBytes` | `1500000` | Compact down to about this. Must be below `maxRequestBytes`. The gap is the hysteresis: each compaction costs one prompt-cache miss, so compact in big steps. |
| `housekeepingRatio` | `0.5` | Start housekeeping this fraction of the way from target to trigger (default: at 3.25 MB). Housekeeping offloads older images and trims old tool results in place; no checkpoint. `0` = off. |
| `housekeepingExcerpt` | `{ head: 2000, tail: 1000 }` | Characters a trimmed old tool result keeps. |
| `maxTokens` | `0` | Also compact at this many estimated tokens (`0` = off). |
| `contextRatio` | `0.85` | Also compact at this fraction of the routed model's `contextWindow` (`0` = off). The lower of the two token triggers wins. |
| `retainTurns` | `2` | Newest complete turns never compacted. |
| `retainBytes` | `400000` | Newest request bytes never compacted. |
| `allowIntraTurn` | `true` | When one long autonomous turn holds the bytes, compact its older tool traffic, keeping the turn's human message and the newest `retainBytes`. |
| `maxCheckpointBytes` / `minCheckpointBytes` | `600000` / `300000` | Bounds on the checkpoint. Its budget is the space actually free under the target after the retained turns (net of images about to be offloaded), clamped to these bounds. |
| `pinnedBytes` | `30000` | Cap on the pinned block. Trimmed in order: the message index (to the newest 40 lines + a summary), the files list, then the oldest constraints. |
| `userTextChars` | `20000` | Hard cap for ONE pathological human paste: above it, head + tail are kept with a recall pointer. Budget passes never cut human text. |
| `assistantTextChars` | `1500` | Assistant text length in the checkpoint (head + tail); degraded passes never go below 1000. |
| `toolResultExcerpt` | `{ head: 200, tail: 100 }` | Excerpt of each compacted successful tool result. |
| `toolErrorExcerpt` | `{ head: 600, tail: 400 }` | Excerpt of each failed tool result (never dropped by budget passes). |
| `groupTools` | `[read, read_image, grep, glob, ls, web_search, web_fetch, recall, recall_search]` | Consecutive successful calls to one of these tools collapse into one line. `[]` = off. |
| `keyArgChars` | `160` | Max characters of one argument shown on a tool-call line. |
| `largeArgBytes` | `2000` | Argument values larger than this are shown as `<N KB>`. |
| `keyArgTools` | `null` | `null` = show key arguments for every tool; or a list of tool names. Other tools show only their argument size. |
| `keepRecentImages` | `2` | Newest inline images kept; older ones become captioned labels when the request is above target. |
| `maxKeptImageBytes` | `2000000` | Byte cap (base64) on the kept images, independent of the count. |
| `recoverOnTimeout` | `true` | After a request **timeout/transport** failure with a body above the target, compact and retry once. Context-overflow and HTTP 413 failures are always recovered. |
| `maxRecoveryRetries` | `1` | Recovery compactions per agent until it next goes idle. |
| `dryRun` | `false` | Log what would be compacted; write nothing. |
| `auto` | `true` | Automatic triggers. With `false`, only `/compact` compacts. |
| `tools` | `true` | Register the `recall` and `recall_search` tools. |
| `commands` | `true` | Register the `/recall` and `/hypercompact` commands. |
| `recallToolName` / `searchToolName` | `recall` / `recall_search` | Tool names, in case another plugin already uses them. |
| `maxRecallChars` | `60000` | Page size of one `recall` answer (longer output continues with `offset`). |
| `maxSearchHits` | `30` | Max entries returned by one search. |
| `statsLog` / `statsDir` | `true` / `null` | Append one content-free JSON record per compaction to `<statsDir>/<session>.jsonl` (default `~/.dsh/hypercompact/`). |
| `modelPolicies` | `[]` | Per-route overrides: `[{ provider, model, maxRequestBytes?, targetRequestBytes?, maxTokens?, contextRatio?, retainTurns?, retainBytes?, maxCheckpointBytes?, housekeepingRatio? }]`. |
| `harnessEntry` | running dsh | Path of the dsh CLI entry, if it cannot be found from `process.argv[1]`. |
| `allowUntestedHarness` | `false` | Load on a DSH release outside the supported range, or one that fails the API contract check. |

### Why these defaults

- **5 MB trigger.** On a slow uplink (100–250 KB/s), 5 MB uploads in about
  20–50 s, inside the common 100 s proxy/CDN timeout even at the low end.
- **1.5 MB target.** About 6–15 s per request after compaction, with 3.5 MB of
  growth before the next compaction (each compaction is one cache miss).
- **`retainTurns: 2`, `retainBytes: 400000`.** The current and previous turn stay
  verbatim, so the agent never loses the work in progress.
- **`contextRatio: 0.85`.** A token safety net for a small-window model whose
  session stays under the byte trigger.
- **`keepRecentImages: 2`.** The screenshots the agent is currently looking at
  survive, and older ones, the dominant cost in measured sessions, do not.
- **`minCheckpointBytes: 300000`.** Measured: with a smaller floor, sessions
  whose retained tail is image-heavy got a tiny budget and elided hundreds of
  entries; at 300 KB every measured session compiled with degradation ≤ 1 and
  nothing elided, while still landing near the 1.5 MB target.

On a fast connection with a large-window model you can raise both byte values
(for example 20 MB → 6 MB); the token trigger still protects the context window.

**Per-model policies.** None ship by default, because provider and model IDs are
deployment-specific; `provider` and `model` must match your route exactly:

```yaml
modelPolicies:
  # a route behind a slow proxy: keep every request under ~30 s at ~100 KB/s
  - { provider: my-gateway, model: my-model, maxRequestBytes: 3000000, targetRequestBytes: 1000000 }
  # a 128K-window model: fire the token trigger early
  - { provider: deepseek, model: deepseek-chat, contextRatio: 0.7 }
```

## How it works

**Trigger.** Before every model step (`agent/pre-step`), the engine estimates
the next request body: each surface message serialized as JSON, inline images
as base64, plus the tool schemas and a fixed envelope. Per-message sizes are
cached by log seq and the log is folded incrementally, so a step costs
O(new events), not a rescan of the session. It compacts when the estimate
reaches `maxRequestBytes`, or when a token trigger fires.

**Selection.** It replaces the oldest span of the surface. The span never
includes the system prompt, never cuts between an assistant tool call and its
results, prefers turn boundaries, and never touches the newest `retainTurns`
turns or `retainBytes` bytes. It compacts enough that the result lands near
`targetRequestBytes`.

**Checkpoint.** The span is compiled into one user message with three parts:

1. **Pinned**: one line per instruction message (seq + first line), every
   constraint sentence in them, verbatim, and the files changed with the seq of
   their last write. Carried forward and merged by every later compaction. Over
   `pinnedBytes`, the index is trimmed first (newest 40 lines plus one
   "N older user messages: seq a–b" line), then the files list, and constraints
   last.
2. **History**: the span in order. Instruction messages appear **verbatim**
   between `[user seq N]` and `[/user seq N]` (or `[agent-message seq N]`,
   `[goal seq N]`, `[team-message seq N]`). Assistant text is head + tail. Each tool
   call is one line with its result's status, size and excerpt; runs of read-only
   calls are one line. Harness-injected context (agent instructions, subagent
   reports) is shortened. Reasoning is dropped.
3. **State of work**: last files edited, last commands and their status,
   errors not followed by a success, and the last human request.

If the checkpoint exceeds its budget, the compiler degrades in fixed passes:
drop success excerpts, then shorten assistant text (never below 1000 chars)
and context, then elide the oldest **unprotected** entries (tool lines,
assistant text, context) behind `[N entries elided, seq A–B]` lines. Human
text, pinned lines, failed-call excerpts, and entries the model recently
recalled are never elided. If they alone exceed the budget, the budget is
exceeded (logged, and recorded in the stats) rather than dropping what the user
said. An earlier checkpoint in the span is re-parsed, not copied: its human
blocks stay protected with their original seqs, its pinned lines merge, and its
tool lines become elidable, so repeated compactions stay bounded.

A compiled tool line looks like:

```text
• edit file_path="src/net/retry.ts" old_string="const timeout = 30_000" new_string=<3.2 KB> [+84/−1 lines] (seq 1822 → result 1824 ok 23 B)
    "Edited src/net/retry.ts"
```

**Commit.** The same durable transaction as the built-in engine:
`compaction/start` → `compaction/summary` → `user/message` (surface replace)
→ `compaction/end`, with no await in between. The summary event carries the
standard fields (`shadowedSeqs`, `shadowedTokenCount`, …) that `/compact` and
dsh-context read. The original events stay in the log. If the request is
still above target, older images in retained tool results are replaced through
the harness's content-only tool-result rewrite (the mechanism the built-in
pruner uses), each shadow-priced with `compaction/prune`.

**Housekeeping.** Between `targetRequestBytes` and `maxRequestBytes`
(starting at `housekeepingRatio`), each step first offloads older images, then
trims tool results older than the retained turns to `housekeepingExcerpt`, until
the request is back near the target. These are content-only rewrites (same
mechanism as image offload). No span is replaced and no checkpoint is written, so
the request stays flat and the full compaction, with its cache miss, is rarer.

**One long turn.** If retention holds most of the bytes (one autonomous turn
with hundreds of tool calls), compacting older history cannot reach the target.
The engine then compacts the older tool traffic *inside* the current turn,
keeping the turn's human message and the newest `retainBytes`, on a balanced
tool boundary (`allowIntraTurn`).

**Recall-aware retention.** Entries the model fetched with `recall` are pinned
for the next compaction: their lines stay at full detail and are never elided.

**Recovery.** On context overflow, HTTP 413, or (if enabled) a
timeout/transport error with a large body, it compacts and asks the agent loop
to retry the request once.

**Fail open.** Any error in the automatic path is logged and the turn
continues untouched. A failure after `compaction/start` closes the bracket with
`compaction/end` and the error, exactly like the built-in engine.

### Protocol safety

- Tool pairing is checked with `dsh-compaction`'s own
  `toolPairingBalancedBefore/After` before every commit.
- Signed or native reasoning replay (`replayState`, thinking signatures,
  redacted blocks) lives on assistant messages. Every retained message is kept
  byte-for-byte, and a compacted span is replaced as a whole by a plain text
  user message, so no partial replay state is ever sent. This is also what
  `dsh-short-tool-ids` requires.
- The checkpoint carries the running DSH's own compaction source marker (built
  by `compactCheckpointSource` from `dsh-compaction`), which every consumer
  recognizes. Earlier checkpoints from either DSH release, or from
  `compaction-basic`, are recognized when carried forward.
- Tool results are read and rewritten through one adapter covering both DSH
  message formats (0.1.5 wrapped `tool-result` blocks; 0.1.7 and 0.2 tool-role
  messages).

## Recall tools

Every checkpoint tells the model how to use these tools, and when it must:
*before editing a file, acting on a requirement, or answering about an earlier
instruction whose content is cut, elided, or only a pointer, call `recall`
first; never guess cut content.*

```text
recall({ seq: 1234 })                              one log entry, verbatim
recall({ result: 1234 })                           the original output of the tool call at (or answered at) seq 1234
recall({ result: 1234, grep: "ECONN", context: 3 }) only matching lines (numbered) of a large output
recall({ result: 1234, head: 2000, tail: 2000 })   just both ends
recall({ range: "120-140" })                       a span (max 200 seqs)
recall({ seq: 1234, offset: 60000 })               next page of a long entry
recall_search({ query: "ECONNRESET" })                         newest first, with seq pointers
recall_search({ query: "csv", kind: "user" })                  only what the human wrote
recall_search({ query: "fail", kind: "error", since: 5000 })   failed tool results after seq 5000
recall_search({ query: "fetch\\(.*timeout", regex: true })
```

`kind` is one of `user`, `assistant`, `tool`, `result`, `error`, `checkpoint`,
`context`. Recall reads the log, not the live context, so it also finds anything
shadowed by earlier compactions, trimming, or image offload. For a trimmed or
offloaded result it follows the replacement chain back to the original.

### Commands

| Command | Shows |
|---|---|
| `/recall 1234`, `/recall 120-140`, `/recall result 1234` | The original entry, in the transcript, for the human. |
| `/hypercompact` | Current request size and inline images, the triggers, and the last compaction or housekeeping pass (span, bytes before/after, degradation, entries elided, user messages kept). |

Commands register into the mounting preset's own command layer, so several
presets using dsh-hypercompact coexist. If a name is already taken (for example
another plugin's `/recall`), that command is skipped with a warning; the engine
and the tools never depend on it.

### Stats records

With `statsLog` on (the default), each compaction and housekeeping pass appends
one JSON line to `~/.dsh/hypercompact/<session-id>.jsonl`: span seqs, bytes and
tokens before/after, checkpoint size and budget, degradation, entries elided,
the seqs of user messages kept and of any over the hard cap, images offloaded,
results trimmed, and duration. Records contain numbers and seqs only, never
message content. They are what you need to answer "why did it forget X".

## Requirements

- DeepSeek Harness `0.1.5-rc.2` up to (not including) `0.3.0`. See
  [Supported DSH versions](#supported-dsh-versions) for the tested versions and
  what happens outside the range.
- Node.js `^22.19.0` or `>=24.0.0` (whatever your DSH runs on).
- Any profile with an agent-preset roster (the web profile). The headless
  profile has no preset roster; see [Add it to a preset by hand](#add-it-to-a-preset-by-hand).

The plugin has no runtime dependencies. At mount time it loads
`@deepseek-ai/dsh-compaction`, `dsh-llm` and `dsh-tools` from the **running** DSH,
never from a second copy, so the engine subclasses the host's own
`CompactionEngine`.

## Development

```sh
npm test          # both tool-result formats; real-harness tests run when dsh is installed
npm run verify    # tests + release gate (packed files, forbidden mechanisms, syntax)
npm run measure -- ~/.dsh/sessions/<project>/<session>/session.v3.jsonl.zstd
```

`npm run measure` loads a session log into a real `Session` from your DSH install,
serializes it through pi-ai's OpenAI-completions converter, and prints the
request body breakdown (messages by role, tool schemas, inline images). It
then runs one compaction on an **in-memory copy** with a real `TokenMeter` and
reports bytes and tokens before/after, checkpoint size vs budget, degradation,
user messages kept verbatim, tool pairing, and a recall byte-equality check.
Pass `--config '{"minCheckpointBytes":150000}'` to try other settings. The
session file is only read, and message content is never printed.

Set `DSH_ENTRY=/path/to/@deepseek-ai/dsh/lib/bin.js` to test against a DSH other
than the one on `PATH`.

| File | Role |
|---|---|
| `index.mjs` | Plugin entry: version policy, runtime loading, engine, tools and commands |
| `lib/engine.mjs` | `ctx.compaction` implementation: triggers, transaction, recovery, housekeeping, image offload, stats |
| `lib/compiler.mjs` | Deterministic checkpoint compiler: protected instructions, pinned and state blocks, budget passes |
| `lib/select.mjs` | Retention, tool-pairing, turn-boundary and intra-turn range selection; checkpoint budget |
| `lib/messages.mjs` | Message-shape adapter for DSH 0.1.5 and 0.1.7 / 0.2 |
| `lib/surface.mjs` | Incremental per-session surface index and byte cache |
| `lib/bytes.mjs` | Request-body byte estimation |
| `lib/images.mjs` | Image offload planning and captions |
| `lib/housekeeping.mjs` | In-place trimming of old tool results |
| `lib/pins.mjs` | Recall-aware retention |
| `lib/stats.mjs` | Content-free per-compaction records |
| `lib/recall.mjs`, `lib/tools.mjs` | Recall/search over the log, their tool definitions, and the commands |
| `lib/config.mjs` | Config validation |
| `scripts/create-preset.mjs` | Create, regenerate or remove the preset (folder preset on 0.1.5, preset bundle on 0.1.7+) |
| `scripts/measure-session.mjs` | Offline wire-body measurement and dry run |
| `scripts/check-release.mjs` | Release gate |

## Publishing

Maintainers publish manually from a clean `main` branch:

```sh
npm run verify
npm publish --dry-run --json
npm whoami
npm publish
```

`prepublishOnly` runs the tests and the release gate. The package publishes
publicly because `package.json` sets `publishConfig.access` to `public`. A dry
run does not authenticate or publish. See [RELEASE.md](./RELEASE.md) for the
full checklist.

## Known limits

- The byte estimate prices the provider-neutral request, not the adapter's exact
  wire JSON. Measured against pi-ai's real serializer it always errs high:
  +2–11 % on multi-MB bodies, up to +28 % on small text-only ones. The trigger
  therefore fires somewhat early, never late.
- The checkpoint is extractive, not a summary. Reasoning is dropped, so a
  decision made only in reasoning is not carried. The agent can `recall` it.
  An optional LLM summary is deliberately not included: it would reintroduce
  the large upload this plugin exists to avoid. If ever added, it must run on
  the compiled checkpoint (not the raw span), append only, and fail open.
- Human text is protected even when that means exceeding the checkpoint
  budget. A session with megabytes of pasted text keeps it (each paste is
  capped at `userTextChars`, head + tail); `/hypercompact` and the stats record
  show the overshoot.
- The token figure logged right after a compaction is stale for one step: the
  token meter anchors on the provider's last reported usage and subtracts the
  shadowed span at its heuristic price (images priced at vision cost by the
  provider are under-subtracted). It re-anchors on the next response. The byte
  figure is the reliable one.
- Protected instruction kinds are `user`, `agent-message`, `goal` and
  `team-message`. Other user-role context (`plugin`, `skill-invocation`,
  `subagent-settled`, `session-reference`, agent instructions) is trimmable.
- Constraint detection is a keyword match ("never", "do not", "must", "only",
  …). It over-collects rather than misses, and the full message is verbatim in
  the history anyway.
- Each compaction changes the prompt prefix and costs one cache miss. The
  default 5 MB → 1.5 MB hysteresis and housekeeping keep that rare. Housekeeping
  rewrites also change the prefix, but only from the rewritten result onward,
  and only once per result.
- Images are offloaded only from tool results. Images attached to user messages
  are kept until their turn is compacted.
- Intra-turn compaction keeps the current turn's human message and the newest
  `retainBytes`. If those alone exceed the target, the request stays above it.

## Credits

The compiler and recall design are informed by the MIT-licensed
[dsh-compaction-instant](https://github.com/TsFreddie/dsh-compaction-instant) and
[VCC](https://github.com/lllyasviel/VCC). No code is copied from either.

## License

MIT
