# DeployTruth

> git status for your deployed application.

DeployTruth compares declared deployment topology with provider-normalized observations and
produces deterministic PASS, WARN, or FAIL reports. It is local-first, read-only, and does not
send telemetry by default.

This repository currently contains the v0.1 foundation, M1 local Git truth, M2 GitHub
authoritative source truth, and M3 Vercel production deployment truth: contracts, fixtures,
deterministic rules, safe reports, a working `check`/`doctor` CLI, a report-viewer boundary, and
CI. Supabase and runtime adapters begin in later milestones.

## Quick start

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
node packages/cli/dist/index.js doctor --config deploytruth.example.yml
# from inside a Git working tree containing deploytruth.yml:
node packages/cli/dist/index.js check --config deploytruth.yml --environment production
```

`check` evaluates real local Git truth (branch, HEAD, working tree, tracking ref, ahead/behind,
worktrees, in-progress operations), remote-authoritative GitHub truth (repository metadata and
the branch's live head SHA), and Vercel production deployment truth (the deployment currently
serving production and the source commit it was built from) against the declared environment.
Database and runtime providers are not implemented yet, so their evidence is reported as
unverified and the verdict stays `WARN` — never a false `PASS`. See [docs/git-truth.md](docs/git-truth.md),
[docs/github-truth.md](docs/github-truth.md), and [docs/vercel-truth.md](docs/vercel-truth.md)
for what each truth does and does not prove.

The E2E seam is available as `pnpm test:e2e`; install Playwright Chromium first when running it on
a new machine: `pnpm exec playwright install chromium`.

Copy `deploytruth.example.yml` to `deploytruth.yml` and replace only identifiers, never secret
values. See [architecture](docs/architecture.md), [security](docs/security.md), and
[provider authoring](docs/provider-authoring.md).

## Repository layout

- `packages/core` — truth domain, rules, report, topology, and safety primitives.
- `packages/config` — schema-first YAML manifest parser.
- `packages/providers` — read-only provider adapter contracts and fixture adapter.
- `packages/reporter` — safe report serialization and local report storage.
- `packages/cli` — thin command shell and orchestration seam.
- `apps/web` — report viewer foundation; it never evaluates rules.
- `fixtures` — sanitized fixture data and deterministic scenario inputs.

## Status

Foundation only. DeployTruth does **not** yet contact live providers or mutate any infrastructure.
