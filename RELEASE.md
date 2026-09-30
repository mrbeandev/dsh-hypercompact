# Release checklist

`dsh-hypercompact` `0.2.2` is published. Unpublished `0.2.3` makes
`create-preset.mjs` remove stale `preset-<id>` rows from the profile patch that
hid the preset on DSH 0.1.7+. `0.2.2` added verified
DeepSeek Harness `0.2.0-rc.2` compatibility and preserves its durable image
omissions when Hypercompact re-prices or rewrites tool results.

The repository is `https://github.com/mrbeandev/dsh-hypercompact`. The package
is MIT-licensed. `prepublishOnly` runs `npm run verify`: both test passes and
the release gate (`scripts/check-release.mjs`). The gate blocks a publish if
package metadata is wrong, a runtime file is missing from the tarball, a
forbidden mechanism (client bundle, settings UI, LLM call, `eval`) appears, a
source or doc contains an absolute user path, or anything private (session
logs, fixtures, `.env`, `.npmrc`, caches, review notes) would be packed.

1. Verify the npm name is still free (`npm view dsh-hypercompact` → 404) or
   owned by the publishing account.
2. Confirm the version in `package.json` has not been published.
3. Confirm the tested DSH versions (`TESTED_DSH_VERSIONS` in `index.mjs`) and the
   supported range (`SUPPORTED_DSH_RANGE`, `dsh.engines.dsh` in `package.json`).
   To add a release: `DSH_ENTRY=<its lib/bin.js> npm test`, then boot a
   disposable `DSH_HOME` with `create-preset.mjs` and check that the preset mounts.
4. Run `npm run verify`.
5. Run `npm run measure -- <a large local session>` and confirm PASS.
6. Run `npm pack --dry-run` and inspect every packed file.
7. Publish only on explicit owner instruction:

```sh
npm whoami
npm publish --dry-run --json
npm publish
```

After publishing:

1. `npm view dsh-hypercompact` shows the new version.
2. In a disposable `DSH_HOME`: `dsh plugin --profile web add dsh-hypercompact`,
   run `create-preset.mjs`, restart, start a session on the preset, run
   `/hypercompact`, then `create-preset.mjs --remove` and
   `dsh plugin --profile web remove dsh-hypercompact`, and confirm a clean boot.
