# DeployTruth

**git status for your deployed application.**

Modern applications are spread across GitHub, deployment platforms, databases, auth systems,
and runtime environments. Each provider can report that its own component is healthy while the
complete application is wired incorrectly.

DeployTruth compares declared state with observed state and tells you what is actually deployed.
It is an early, pre-1.0 open-source project: useful foundations are in place, but interfaces and
configuration may still change.

```text
GitHub main
    |
    v
Vercel Production
    |
    v  runtime SHA verified
    |
Running Runtime
    |
    v  target + read probe verified
    |
Supabase
```

DeployTruth can surface findings such as `DEPLOYMENT_SHA_MISMATCH`, `WRONG_DATABASE_PROJECT`,
`DATABASE_MIGRATIONS_BEHIND`, and `STALE_TRACKING_REF`. It reports `UNKNOWN` when evidence is
missing instead of fabricating certainty.

## Principles

- Local-first: checks run from your machine and your repository.
- Read-only: provider adapters and database inspection do not mutate infrastructure.
- Deterministic: the same declaration and observations produce the same result.
- No account required: DeployTruth has no hosted account system.
- No telemetry by default: no product telemetry is collected or sent.
- No infrastructure mutation: checks observe; they do not repair or deploy.
- Honest uncertainty: unavailable evidence remains `UNKNOWN` or a warning.

## Install the CLI

The `deploytruth` package is a self-contained Node.js CLI — it needs Node.js 22 or later and
nothing else.

```bash
npm install -g deploytruth
deploytruth --help
```

or run it without installing:

```bash
npx deploytruth --help
```

DeployTruth is verified on macOS and Linux (CI). Windows is not yet certified.

## Develop DeployTruth

Contributors run from source with Node.js 22 or later and the pnpm version pinned through the
`packageManager` field.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

The E2E seam is available as `pnpm test:e2e`. On a new machine, install its browser with
`pnpm exec playwright install chromium`. `pnpm release:check` runs the full release gate,
including npm package validation and an external-consumer smoke test.

## Configuration

Copy [`deploytruth.example.yml`](deploytruth.example.yml) to `deploytruth.yml` and replace only
non-secret identifiers. Credentials belong in environment variables, never in the manifest or
Git. A smaller declaration is available at
[`examples/deploytruth.minimal.yml`](examples/deploytruth.minimal.yml).

## CLI usage

```bash
deploytruth init                                     # write a starter deploytruth.yml
deploytruth doctor                                   # validate manifest and provider access
deploytruth check --environment production           # PASS / WARN / FAIL with findings
deploytruth open --environment production            # private loopback visual report
deploytruth history --environment production         # stored local runs
deploytruth diff --environment production            # compare two runs semantically
```

From a source checkout, the same commands run as `node packages/cli/dist/index.js …` after
`pnpm build`.

`doctor` validates configuration and provider access. `check` compares local Git, authoritative
GitHub source, Vercel production deployment, fresh runtime attestation, runtime Supabase target and
connectivity, Supabase project/database identity, and committed migration history. Output is PASS,
WARN, or FAIL with evidence-backed findings.

`open` serves the same normalized report as a loopback-only Truth Map, Inspector, Report, and
History view. `history` lists stored local runs. `diff` compares two runs semantically (latest two
by default). See the [local visual report](docs/local-visual-report.md) and
[report history](docs/report-history.md).

## GitHub Action

DeployTruth ships a self-contained JavaScript Action (the root `action.yml`) that runs the same
truth engine inside CI: one invocation produces one `TruthReport`, a Job Summary,
machine-readable outputs, and a sanitized `truth-report.json` / `summary.md` /
`ci-metadata.json` evidence bundle, gated by a `fail-on` (`fail` | `warn` | `never`) policy.

```yaml
- id: deploytruth
  uses: Cristian0101/deploytruth@v0 # pre-1.0
  with:
    environment: production
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    DEPLOYTRUTH_VERCEL_TOKEN: ${{ secrets.DEPLOYTRUTH_VERCEL_TOKEN }}
    DEPLOYTRUTH_SUPABASE_ACCESS_TOKEN: ${{ secrets.DEPLOYTRUTH_SUPABASE_ACCESS_TOKEN }}
    DEPLOYTRUTH_SUPABASE_DATABASE_URL: ${{ secrets.DEPLOYTRUTH_SUPABASE_DATABASE_URL }}
```

Run it only from trusted events — `workflow_dispatch`, protected-branch pushes, or trusted
post-deployment workflows. The Action refuses `pull_request_target` outright and never forwards
secrets to fork PRs. See [`docs/github-action.md`](docs/github-action.md) for the full contract,
exit-policy matrix, artifact layout, and security model.

## Security model

DeployTruth uses GET-only provider transports and a PostgreSQL read-only transaction with a fixed
query surface. TLS verification fails closed. Reports redact credential-shaped values, and the
tool never falls back to a generic `DATABASE_URL`. See [`SECURITY.md`](SECURITY.md) for reporting
vulnerabilities and [`docs/security.md`](docs/security.md) for the implementation model.

## Current provider support

| Provider  | Current truth                                                             |
| --------- | ------------------------------------------------------------------------- |
| Local Git | Branch, HEAD, worktree, tracking ref, ahead/behind, worktrees, operations |
| GitHub    | Repository metadata and authoritative branch HEAD                         |
| Vercel    | Production deployment, serving aliases, state, and source commit          |
| Supabase  | Project access, database identity, and applied migration history          |
| Runtime   | Fresh SHA/environment attestation, env presence, and live DB connection   |

See [runtime connection truth](docs/runtime-truth.md) and the
[live acceptance environment](docs/live-acceptance.md) for the protocol and controlled dogfood
target.

## Repository layout

- `packages/core` — truth domain, rules, report, topology, comparison, and safety primitives.
- `packages/config` — schema-first YAML manifest parser.
- `packages/providers` — read-only GitHub, Vercel, Supabase, PostgreSQL, and Git adapters.
- `packages/reporter` — safe report serialization, local report history, and the shared
  human-readable report summary.
- `packages/cli` — the published `deploytruth` npm package: command shell and orchestration
  bundled into a single self-contained executable.
- `packages/github-action` — CI adapter behind the root `action.yml`; wraps `runEnvironmentCheck`
  and contains no truth logic of its own.
- `apps/web` — local report viewer; it does not evaluate rules or comparisons.
- `examples/live-acceptance` — tiny GitHub → Vercel → Supabase dogfood fixture.
- `fixtures` and `tests` — sanitized observations and deterministic certification scenarios.

## Roadmap

- M1–M5: local Git, GitHub, Vercel, Supabase identity/migrations, and fresh runtime connection
  truth — implemented.
- M6: loopback-only visual Truth Map, evidence Inspector, and local report UX — implemented.
- M7: local report history and semantic run comparison — implemented.
- M8: distributable GitHub Action — Job Summary, machine outputs, sanitized evidence bundle,
  and a `fail-on` policy over the same truth engine — implemented.
- Later: expand provider coverage and harden the pre-1.0 CLI based on real-world use.

DeployTruth is pre-1.0 software: interfaces, configuration, and report schemas may change
between minor releases. See [docs/releasing.md](docs/releasing.md) for the release procedure.

## Contributing

Issues, design discussion, documentation fixes, and focused pull requests are welcome. Read
[`CONTRIBUTING.md`](CONTRIBUTING.md), the [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md), and the
provider-authoring guide at [`docs/provider-authoring.md`](docs/provider-authoring.md) first.
