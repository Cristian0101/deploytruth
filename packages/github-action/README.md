# DeployTruth GitHub Action

The bundled entrypoint behind the repository's root `action.yml`. It wraps the certified
`runEnvironmentCheck` orchestration — one invocation produces one `TruthReport` — and adapts it
to GitHub Actions: inputs, Job Summary, machine-readable outputs, a sanitized CI evidence
bundle, and a configurable fail policy.

It contains no provider truth logic, no independent rule evaluation, and no second verdict.

## Layout

- `src/action.ts` — CI adapter: event trust, fail-on policy, outputs, summary ordering.
- `src/inputs.ts` — input validation and workspace-confined config resolution.
- `src/ci-metadata.ts` — strict allowlisted CI provenance schema (not infrastructure truth).
- `src/bundle.ts` — validated, atomically-published `truth-report.json` / `summary.md` /
  `ci-metadata.json` bundle under `RUNNER_TEMP`.
- `src/index.ts` — entry wiring `@actions/core`.
- `dist/index.js` — the committed bundle `action.yml` points at.

## Building

`pnpm --filter @deploytruth/github-action build` (or `pnpm build:action` from the root) bundles
`src/index.ts` with tsup — workspace packages are aliased to their TypeScript sources so the
bundle always matches what `pnpm test` certifies, and every npm runtime dependency is inlined.
`dist/` is committed on purpose: `uses: Cristian0101/deploytruth@<ref>` must work with no
install step. CI fails if the committed bundle drifts from its sources.

## Runtime

`action.yml` uses `runs.using: node24` — GitHub's JavaScript Action runtime is versioned
independently of the repository's Node.js version and supports `node20`/`node24`; `node22` was
never a valid Action runtime. The bundle is plain Node-compatible ESM with a `createRequire`
banner for CJS dependencies.

See `docs/github-action.md` for usage, security guidance, and the fail-on matrix.
