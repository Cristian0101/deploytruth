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

## v0.1.0 first-publish authentication

The npm package does not exist before the first release. Current npm requirements create two hard
bootstrap boundaries:

- A Trusted Publisher cannot be configured until the package already exists on the registry.
- `npm stage publish` also requires an existing package, so it cannot stage `deploytruth@0.1.0`.

The v0.1.0 bootstrap therefore uses an interactive npm session protected by account 2FA. Do not
create or store a long-lived GitHub write token. On the approved release SHA:

1. Recheck that `npm view deploytruth` returns registry 404 and that the local tarball hash matches
   the certified RC evidence.
2. Authenticate interactively with `npm login` if `npm whoami` is not already the intended owner.
   Never copy the session credential, `.npmrc`, security key material, or one-time code into logs.
3. Publish exactly the certified `deploytruth-0.1.0.tgz` with `npm publish <tarball> --access public`
   and complete the human 2FA challenge.
4. Verify the registry version and remotely install `deploytruth@0.1.0` before creating release
   refs.
5. Add the future tag-gated publish workflow on protected `main`, then configure the npm Trusted
   Publisher for `Cristian0101/deploytruth` and that exact workflow filename.
6. Give the trust relationship stage-only permission. Set package publishing access to require 2FA
   and disallow traditional tokens, then revoke or remove any bootstrap credential/session that is
   no longer needed.

The first interactive publish will not carry GitHub OIDC provenance. Later public releases from
the GitHub-hosted trusted workflow receive npm provenance automatically. Do not disable it.

## Future trusted-publish workflow design

The live publish workflow is intentionally absent during release-candidate preparation: there is
no publish button or OIDC permission in the RC workflow. Add it only during an explicitly approved
release execution, after the first package exists. The final workflow must:

- run only from an exact version tag whose `vX.Y.Z` value equals the CLI package version;
- use a GitHub-hosted runner, `permissions: { contents: read, id-token: write }`, Node 22.14 or
  later, and a current npm CLI that supports Trusted Publishing;
- install from the frozen lockfile with release caching disabled and run the complete release gate;
- use an npm environment with required reviewer approval;
- run `npm stage publish`, not direct `npm publish`, under a stage-only Trusted Publisher;
- require a maintainer to inspect and approve the staged artifact with 2FA;
- verify the registry version, provenance, remote install, immutable tag, and moving `v0` ref.

The trusted publisher must name the workflow file exactly, including its `.yml` extension. npm OIDC
supports both direct and staged publishing, but DeployTruth deliberately chooses staged publishing
for the additional human review boundary.

## Release-day human checklist

1. Confirm protected `main` CI is green at the certified release SHA.
2. Run the trusted live acceptance workflow and require an honest PASS.
3. Recheck that the `deploytruth` npm name is still available.
4. Confirm the intended npm account, interactive authentication, and 2FA are ready.
5. Compare the final tarball SHA-256 and Action bundle SHA-256 with RC evidence.
6. Publish exactly `deploytruth@0.1.0` through the approved bootstrap procedure.
7. Verify `npm view deploytruth@0.1.0` and a clean `npx deploytruth@0.1.0 --version`.
8. Create and push immutable `v0.1.0` at the certified release commit.
9. Publish the prepared GitHub Release notes from `docs/releases/v0.1.0.md`.
10. Create `v0` at the same commit; for later compatible 0.x releases, move only `v0` forward.
11. Verify remote Actions at both `@v0.1.0` and `@v0` and compare their outputs.
12. Verify public installation and Action references in the rendered README and package docs.
13. Verify the rendered npm page, GitHub README, demo assets, social preview, and links.
14. Configure the future stage-only npm Trusted Publisher and disallow traditional publish tokens.
15. Post only the explicitly approved launch announcements.
16. Monitor Issues and Discussions, then run a post-release clean-install smoke.

Never move `v0.1.0`. If it is broken, publish and tag `v0.1.1`; immutable release history is not
rewritten.

## First-public-release documentation

Before certifying the first public package, make the README, package README, and Action guide use
the actual public installation and Action references. Merge that narrow documentation correction
through protected `main`, then rebuild and re-certify the exact package artifact before publishing.
The package README must never claim that its own published install command or Action reference is
unavailable.

## Notes

- The committed `packages/github-action/dist/index.js` bundle is the Action's entire runtime —
  CI enforces it stays in sync with sources; rebuild with `pnpm build` and commit the result.
- `packages/cli/LICENSE` must stay byte-identical to the root `LICENSE` (asserted by tests).
- The `.env.deploytruth.local` acceptance credentials file is gitignored and must never ship.
- Platform support today: macOS and Linux are exercised; Windows is not yet certified.
