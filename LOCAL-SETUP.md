# Local setup and testing

This document is for local development. It intentionally contains no
machine-specific paths or private session data.

## Test in a disposable DSH_HOME

Never test install/remove on your daily profile. A throwaway `DSH_HOME` gives
you an isolated profile, preset root, and session store:

```bash
export DSH_HOME=/tmp/hc-dshhome
mkdir -p "$DSH_HOME/profiles/hc"
cat > "$DSH_HOME/profiles/hc/package.json" <<'EOF'
{
  "name": "dsh-profile-hc",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"], "patchReload": "startup" } }
}
EOF
echo '[]' > "$DSH_HOME/profiles/hc/cordis.patch.yml"

dsh plugin --profile hc add "link:/absolute/path/to/dsh-hypercompact"
node scripts/create-preset.mjs --profile hc   # 0.1.5: $DSH_HOME/.agent-presets/; 0.1.7: the hc profile patch
dsh --profile hc --no-open --port 3099
```

Copy only the provider/model blocks you need into `$DSH_HOME/settings.yaml`
(keep API keys in environment variables). On DSH 0.1.5 you can set
`agent-presets: { default: hypercompact }`; otherwise pick the preset in the UI.

To test another DSH release without replacing your global install:

```bash
npm install --prefix /tmp/dsh-next @deepseek-ai/dsh@next
export DSH_ENTRY=/tmp/dsh-next/node_modules/@deepseek-ai/dsh/lib/bin.js
npm test
node "$DSH_ENTRY" --profile hc --no-open --port 3099
```

To watch it work quickly, lower the thresholds in the generated preset, for
example `maxRequestBytes: 60000`, `targetRequestBytes: 30000`, `retainBytes: 8000`,
and run a session that reads a dozen files. The host log shows one line per
compaction:

```text
[hypercompact] request 61.2 KB ≥ 58.6 KB: replaced 41 nodes (seq 9–212; 18 tool calls) request 61.2 KB → 24.9 KB, … checkpoint 6.8 KB, 3 ms
```

## Daily profile

Once validated, install into the daily profile the same way
(`dsh plugin --profile web add …`), run `scripts/create-preset.mjs` without a
`DSH_HOME` override, restart, and pick "Hypercompact (standard)" for new
sessions. Keep the checkout in place if you installed it as a `link:`.

Uninstall: `node scripts/create-preset.mjs --remove`, then
`dsh plugin --profile web remove dsh-hypercompact`.

## Private fixtures

`npm run measure` reads real session logs. Keep any copies, and any review
notes that name private sessions, under `fixtures/` or `.private/` (both
git-ignored and excluded from the tarball by the release gate). Never commit
them or paste their content into issues.
