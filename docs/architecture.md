# DeployTruth architecture

## Purpose

DeployTruth compares a declared topology in `deploytruth.yml` with normalized observations and
evaluates deterministic rules locally. A provider API object is never a core truth object.

## Package boundaries

| Package                      | Owns                                                                                     | Must not own                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------- |
| `@deploytruth/core`          | Domain schemas, rules, verdicts, topology, redaction, comparison                         | Provider SDKs, filesystem I/O, CLI, React     |
| `@deploytruth/config`        | YAML parsing and manifest normalization                                                  | Provider calls, rule evaluation               |
| `@deploytruth/providers`     | Read-only adapter contracts and fixture adapters                                         | Verdict logic, report persistence             |
| `@deploytruth/reporter`      | Safe JSON serialization and local report history                                         | Raw payload parsing, rule evaluation          |
| `deploytruth` (CLI)          | Arguments, orchestration, output, exit policy                                            | Provider-specific truth logic                 |
| `@deploytruth/web`           | Rendering a supplied `TruthReport` / `RunComparison`                                     | Rule evaluation or comparison calculation     |
| `@deploytruth/github-action` | CI adapter behind the root `action.yml` (Job Summary, outputs, evidence bundle, fail-on) | Truth logic, provider calls, a second verdict |

The dependency direction is intentionally one-way:

```text
deploytruth.yml -> config ------------------+
provider APIs -> providers -> core ----------+-> reporter -> JSON files
local Git -> providers ----------------------+-> CLI / web report viewer
```

`core` has no UI or provider-SDK dependency. The UI receives an already-evaluated report or
comparison and never infers node health, severity, verdict, or what changed.

## Normalized truth model

The engine works with three models:

1. `ProjectDeclaration`: normalized declared state.
2. `ProjectObservation`: source, deployment, database, runtime, migration, and variable-presence
   evidence from adapters.
3. `TruthReport`: versioned, safe-to-store environment truth, findings, and topology.

| Provider concern               | Normalized field                               |
| ------------------------------ | ---------------------------------------------- |
| Local HEAD SHA                 | `SourceObservation.headSha`                    |
| Local branch / detached state  | `SourceObservation.branch`, `.detachedHead`    |
| Working tree state             | `SourceObservation.workingTree` + counts/lists |
| Local tracking ref SHA         | `SourceObservation.upstream.sha` (local only)  |
| Ahead/behind vs tracking ref   | `SourceObservation.aheadBy` / `.behindBy`      |
| GitHub branch SHA              | `remoteSource.remoteHeadSha`                   |
| GitHub default branch          | `remoteSource.defaultBranch`                   |
| Remote observability           | `remoteSource.availability`                    |
| Production deployment id/URL   | `deployment.deploymentId`, `.deploymentUrl`    |
| Deployment state               | `deployment.state` (ready/building/queued/…)   |
| Deployment source commit       | `deployment.commitSha`, `.sourceBranch`        |
| Deployment observability       | `deployment.availability`                      |
| Ambiguous routing evidence     | `deployment.productionAssignments`             |
| Stable domain verification     | `deployment.stableDomainVerified`              |
| Supabase project observability | `database.controlPlane`                        |
| Database connection state      | `database.connection`                          |
| Connection target evidence     | `database.connection.targetProjectRef`         |
| Observed database identity     | `database.observedProjectRef`, `.identity`     |
| Applied migration versions     | `database.appliedMigrationIds`                 |
| Migration-history readability  | `database.migrationHistory`                    |
| Expected migration source      | `repositoryMigrations` (`sourceSha`, `origin`) |
| Runtime attestation state      | `runtime.availability`, `.freshness`           |
| Runtime source/environment     | `runtime.commitSha`, `.environment`            |
| Runtime variable presence      | `runtime.environmentVariables`                 |
| Runtime database target/probe  | `runtime.databaseConnection`                   |

Only normalized observations may reach `core`. Raw responses stay inside an adapter function and
are discarded after translation.

Database truth follows the same separation discipline (ADR 006): `database.controlPlane` is
Management-API evidence, `database.connection`/`identity` is PostgreSQL evidence, and
`repositoryMigrations` is immutable Git-tree evidence. A reachable database never implies the
declared project; a healthy control plane never implies a reachable database; and an expected
catalog is authoritative only when its `sourceSha` equals the remote-authoritative head (when a
remote source is declared) — or the committed local HEAD otherwise.

An environment's source evidence is a **pair**: `source` is the local observation (`git`
adapter), `remoteSource` is the remote-authoritative observation (`github` adapter). They are
never merged — rules compare the two claims (ADR 004). Deployment evidence is the separate
`deployment` observation (`vercel` adapter in M3), which identifies the deployment currently
serving production through provider control-plane assignments — never "the newest deployment",
and never a majority pick among divergent production aliases (ADR 005): only an explicitly
declared domain or unanimous production aliases resolve production; anything else is
`unavailable`/`ambiguous` evidence. Remote adapters always set `availability`, so a failed API
call produces `unavailable` evidence rather than fabricated truth.

## Manifest

The v1 YAML shape stays deliberately small:

```yaml
version: 1
project: my-app
environments:
  production:
    kind: production
    source: { provider: github, repository: owner/my-app, branch: main }
    deployment: { provider: vercel, project: my-app, target: production, domain: app.example.com }
    database:
      {
        provider: supabase,
        project_ref: prodabc123,
        migrations: { directory: supabase/migrations },
      }
    runtime: { url: https://example.com/api/version, expected_environment: production }
    required_environment_variables: [SUPABASE_URL]
    checks: { deployment_sha: true, runtime_identity: true }
```

The parser rejects unknown keys. Secret values do not belong in the manifest. If `kind` is omitted,
common names are inferred; any other name is `custom`.

Applicable checks are enabled by default. `checks.<name>: false` opts out explicitly. Explicit
`true` enables a coverage warning if the declaration cannot supply required evidence.

## Rule model and verdicts

A rule has a stable code, optional check selector, and pure `evaluate(context)` function. It
returns findings with deterministic expected/observed values, safe evidence, affected components,
severity, status, and remediation.

A `remote_source` check applies whenever a source is declared: it is covered only by an
`available` `remoteSource` observation, so absent or failed GitHub evidence blocks `PASS` through
`REQUIRED_OBSERVATION_UNAVAILABLE`.

The foundation includes:

- `DIRTY_WORKTREE` -> warning
- `REPOSITORY_OPERATION_IN_PROGRESS` -> warning
- `DETACHED_HEAD` -> warning
- `NO_UPSTREAM_CONFIGURED` -> warning
- `LOCAL_BRANCH_AHEAD_OF_UPSTREAM` -> informational warning
- `LOCAL_BRANCH_BEHIND_UPSTREAM` -> warning
- `LOCAL_BRANCH_DIVERGED` -> high warning
- `STALE_TRACKING_REF` -> warning
- `LOCAL_HEAD_DIFFERS_FROM_GITHUB` -> warning (INFO off the declared branch)
- `DECLARED_BRANCH_DIFFERS_FROM_GITHUB_DEFAULT` -> informational
- `GITHUB_REPOSITORY_UNAVAILABLE` -> warning
- `GITHUB_BRANCH_UNAVAILABLE` -> warning
- `DEPLOYMENT_SHA_MISMATCH` -> fail
- `DEPLOYMENT_SOURCE_UNVERIFIED` -> warning
- `VERCEL_PROJECT_UNAVAILABLE` -> warning
- `VERCEL_PRODUCTION_DEPLOYMENT_UNAVAILABLE` -> warning
- `VERCEL_PRODUCTION_ROUTING_AMBIGUOUS` -> warning
- `DEPLOYMENT_NOT_READY` -> warning
- `DEPLOYMENT_FAILED` -> fail
- `STABLE_DOMAIN_STALE` -> fail when positively stale, warning when inconclusive
- `WRONG_DATABASE_PROJECT` -> fail
- `PREVIEW_USES_PRODUCTION_DATABASE` -> critical fail
- `SUPABASE_PROJECT_UNAVAILABLE` -> warning
- `DATABASE_CONNECTION_UNAVAILABLE` -> warning
- `DATABASE_IDENTITY_UNVERIFIED` -> warning
- `MIGRATION_SOURCE_UNAVAILABLE` -> warning
- `MIGRATION_SOURCE_INVALID` -> warning
- `DATABASE_MIGRATION_HISTORY_UNAVAILABLE` -> warning
- `DATABASE_MIGRATIONS_BEHIND` -> fail
- `DATABASE_MIGRATION_DRIFT` -> warning
- `RUNTIME_SHA_MISMATCH` -> fail
- `ENVIRONMENT_IDENTITY_MISMATCH` -> fail
- `ENVIRONMENT_VARIABLE_MISSING` -> fail
- `REQUIRED_OBSERVATION_UNAVAILABLE` -> warning

`FAIL` wins aggregation. Any warning makes `WARN`; strict mode promotes warnings to `FAIL`. An
enabled check without evidence produces `REQUIRED_OBSERVATION_UNAVAILABLE`, so absent observations
cannot create a false `PASS`.

## Topology and reports

Topology is a core-domain artifact, not a React Flow artifact. Nodes contain an id, provider,
component type, environment, label, health, and safe metadata. Edges carry expected/observed flags
and finding codes. The web app maps these to the local Truth Map without changing truth logic.
History comparison reuses the same topology model; it does not introduce a second graph engine.

`TruthReport` is versioned (`schemaVersion: "0.2"`) and serializable. Each report carries a ULID
`runId`. `reporter` validates it, runs final recursive sanitization, then writes an
environment-scoped historical file plus `latest.json` under `.deploytruth/reports/`. Comparison is
a pure function over two reports (`compareTruthReports`); it never calls providers. See
`docs/report-history.md` and ADR 008.

The runtime endpoint implements the strict public-safe M5 attestation protocol:

```json
{
  "version": 1,
  "nonce": "<echo>",
  "commit": "d7f8ff5",
  "environment": "production",
  "environmentVariables": { "SUPABASE_URL": true },
  "connections": {
    "database": {
      "provider": "supabase",
      "targetProjectRef": "prodabc123",
      "identity": "verified",
      "status": "connected"
    }
  }
}
```

## Risks and mitigations

| Risk                           | Mitigation                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| Provider types leak into rules | Core exposes normalized Zod schemas; boundary tests reject SDK imports.                          |
| False PASS from missing data   | Required-observation rule changes unverified enabled checks to `WARN`.                           |
| Secret disclosure              | No raw payloads in model; report serialization sanitizes again; tests cover common token forms.  |
| Provider API drift             | Fixture-tested translation boundaries localize provider changes.                                 |
| Git portability                | M1 will use a narrow injected Git runner and stable porcelain/`rev-parse` output only.           |
| Environment ambiguity          | The declaration has an environment map and optional explicit kind; runtime identity verifies it. |
| Migration portability          | M4 translates provider state to migration IDs and compares sets, not database-table layouts.     |
| CLI/UI coupling                | CLI emits reports; UI renders reports and comparisons. Neither owns rule implementation.         |
| History path traversal         | Project/environment names are sanitized keys; run IDs resolve only through the report store.     |
| Overengineering                | Filesystem history, no plugin registry, accounts, hosted dashboard, or extra providers in M7.    |

## Milestone sequence

M0 is the foundation. M1 adds local Git observations through `packages/providers/src/git/`
— an allowlisted, read-only `GitRunner` plus a `local-git` adapter producing `SourceObservation`
(`docs/git-truth.md` covers semantics). M2 (current) adds remote-authoritative GitHub truth
through `packages/providers/src/github/` — a GET-only REST transport plus a `github` adapter
producing the `remoteSource` observation (`docs/github-truth.md`, ADR 004). M3 (current) adds
Vercel production deployment truth through `packages/providers/src/vercel/` — a GET-only REST
transport plus a `vercel` adapter producing the `deployment` observation (`docs/vercel-truth.md`,
ADR 005). M4 (current) adds Supabase database and migration truth through
`packages/providers/src/supabase/` plus the `git ls-tree` migration catalog in
`packages/providers/src/git/migrations.ts` — a GET-only Management API adapter, a two-method
read-only PostgreSQL reader, and identity-gated comparison (`docs/supabase-truth.md`, ADR 006).
M5 adds fresh runtime identity, presence-only environment evidence, URL-derived Supabase target
identity, a harmless live connection probe, and distinct deployment-to-runtime and
runtime-to-database topology edges (`docs/runtime-truth.md`, ADR 007). M6 renders that topology
locally. M7 stores each completed report locally and compares runs semantically
(`docs/report-history.md`, ADR 008). M8 wraps the same `runEnvironmentCheck` orchestration in a
bundled JavaScript Action (`packages/github-action`, root `action.yml`): it emits the GitHub Job
Summary, step outputs, and an atomic `RUNNER_TEMP` evidence bundle built from the single
`TruthReport` — never a second engine (`docs/github-action.md`). Every adapter milestone starts
with fixtures.
