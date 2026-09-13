# Releasing DeployTruth

DeployTruth is pre-1.0. This document is the release procedure for maintainers; nothing here
publishes anything by itself — every step that touches npm, tags, or GitHub Releases requires
explicit release approval.

## Version domains

Three independent version domains exist. Do not conflate them.

| Domain              | Current value | Source of truth                                 |
| ------------------- | ------------- | ----------------------------------------------- |
| Product release     | `0.1.0`       | `packages/cli/package.json` `version`           |
| TruthReport schema  | `0.2`         | `REPORT_SCHEMA_VERSION` in `packages/core`      |
| Runtime attestation | `1`           | `attestationVersion` literal in `packages/core` |
| Manifest            | `1`           | `version:` field in `deploytruth.yml`           |

`deploytruth --version` reports the product release version, read from the package manifest at
build time. Every workspace package shares the product version (`tests/release-packaging.test.ts`
enforces this).

## Consumption surfaces

| Surface       | Reference                                                       | Install story                                    |
| ------------- | --------------------------------------------------------------- | ------------------------------------------------ |
| npm CLI       | `deploytruth` (unscoped)                                        | `npm install -g deploytruth` / `npx deploytruth` |
| GitHub Action | `Cristian0101/deploytruth@v0` (moving) or `@v0.1.0` (immutable) | committed bundle; no install step                |
| Source        | `Cristian0101/deploytruth` `main`                               | contributors only: corepack + pnpm               |

The npm package bundles every workspace and npm dependency into a single `dist/index.js`
(`packages/cli/tsup.config.ts`, the same pattern as the Action bundle). The published manifest
declares zero runtime dependencies, so install cannot fail on resolution.

## Tag strategy

- `v0.1.0` — immutable version tag. Created once, on the certified `main` SHA, never moved.
- `v0` — the moving pre-1.0 Action ref. Advances only through this release procedure, always to
  a commit that has passed every gate below.

External usage after release:

```yaml
uses: Cristian0101/deploytruth@v0 # moving pre-1.0 ref
uses: Cristian0101/deploytruth@v0.1.0 # exact pin
```

## Release checklist

1. Confirm `main` is clean, synced with origin, and all CI is green on the release SHA.
2. Confirm the version field is the release version in every workspace `package.json`
   (`pnpm release:check` asserts this).
3. Finalize `CHANGELOG.md`: move Unreleased notes under the release version heading.
4. Run `pnpm release:check` — frozen install, typecheck, lint, format, unit tests, build,
   committed Action bundle freshness, `pnpm test:e2e`, npm pack validation (file allowlist,
   credential scan, self-contained bin), and the external-consumer smoke test.
5. Inspect the tarball manually: `pnpm --filter ./packages/cli pack`, review
   `tar -tzf` output, and confirm only `dist/**`, `package.json`, `README.md`, `LICENSE` ship.
6. Re-run the live acceptance certification (`DeployTruth Certify` workflow dispatch) and
   confirm PASS on the release SHA.
7. With approval, publish: `pnpm --filter ./packages/cli publish --access public --no-git-checks`
   after reviewing `pnpm pack` output once more.
8. Create the immutable annotated tag: `git tag -a v0.1.0 <certified-sha> -m "v0.1.0"` and push
   it. Never move it afterwards.
9. Create the GitHub Release from `v0.1.0` with the finalized changelog notes.
10. Create or update the moving `v0` ref to the same release commit and push it.
11. Verify remote installs:
    `npm view deploytruth version`, `npx deploytruth@0.1.0 --version`, and a consumer workflow
    run against `Cristian0101/deploytruth@v0`.
12. Post-release smoke on a clean machine: install the CLI, `init`, `doctor`, `check` against a
    safe manifest.
13. If the release is broken: `npm deprecate deploytruth@0.1.0 "broken — use the next patch"`
    or `npm unpublish` within the 72-hour window, fix on a branch, and cut `v0.1.1`. Do not
    republish a different artifact under an existing version tag, and do not repoint `v0` back
    to a broken commit — `v0` may only move forward to a certified SHA.

## Notes

- The committed `packages/github-action/dist/index.js` bundle is the Action's entire runtime —
  CI enforces it stays in sync with sources; rebuild with `pnpm build` and commit the result.
- `packages/cli/LICENSE` must stay byte-identical to the root `LICENSE` (asserted by tests).
- The `.env.deploytruth.local` acceptance credentials file is gitignored and must never ship.
- Platform support today: macOS and Linux are exercised; Windows is not yet certified.
