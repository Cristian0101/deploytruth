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

## Development and installation

DeployTruth currently runs from source and requires Node.js 22 or later. The repository pins pnpm
through the `packageManager` field.

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
`pnpm exec playwright install chromium`.

## Configuration

Copy [`deploytruth.example.yml`](deploytruth.example.yml) to `deploytruth.yml` and replace only
non-secret identifiers. Credentials belong in environment variables, never in the manifest or
Git. A smaller declaration is available at
[`examples/deploytruth.minimal.yml`](examples/deploytruth.minimal.yml).

## CLI usage

```bash
node packages/cli/dist/index.js doctor --config deploytruth.yml
node packages/cli/dist/index.js check --config deploytruth.yml --environment production
node packages/cli/dist/index.js open --config deploytruth.yml --environment production
```

`doctor` validates configuration and provider access. `check` compares local Git, authoritative
GitHub source, Vercel production deployment, fresh runtime attestation, runtime Supabase target and
connectivity, Supabase project/database identity, and committed migration history. Output is PASS,
WARN, or FAIL with evidence-backed findings.

`open` serves the same normalized report as a loopback-only Truth Map, Inspector, and detailed
Report view. See the [local visual report](docs/local-visual-report.md) for live, `--no-open`, saved
report, rerun, shutdown, and security behavior.

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

- `packages/core` — truth domain, rules, report, topology, and safety primitives.
- `packages/config` — schema-first YAML manifest parser.
- `packages/providers` — read-only GitHub, Vercel, Supabase, PostgreSQL, and Git adapters.
- `packages/reporter` — safe report serialization and local report storage.
- `packages/cli` — command shell and orchestration.
- `apps/web` — local report-viewer foundation; it does not evaluate rules.
- `examples/live-acceptance` — tiny GitHub → Vercel → Supabase dogfood fixture.
- `fixtures` and `tests` — sanitized observations and deterministic certification scenarios.

## Roadmap

- M1–M5: local Git, GitHub, Vercel, Supabase identity/migrations, and fresh runtime connection
  truth — implemented.
- M6: loopback-only visual Truth Map, evidence Inspector, and local report UX — implemented.
- Later: expand provider coverage and harden the pre-1.0 CLI based on real-world use.

DeployTruth is not yet published to npm and does not claim production maturity.

## Contributing

Issues, design discussion, documentation fixes, and focused pull requests are welcome. Read
[`CONTRIBUTING.md`](CONTRIBUTING.md), the [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md), and the
provider-authoring guide at [`docs/provider-authoring.md`](docs/provider-authoring.md) first.
