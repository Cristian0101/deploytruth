# DeployTruth architecture

## Purpose

DeployTruth compares a declared topology in `deploytruth.yml` with normalized observations and
evaluates deterministic rules locally. A provider API object is never a core truth object.

## Package boundaries

| Package                      | Owns                                                            | Must not own                              |
| ---------------------------- | --------------------------------------------------------------- | ----------------------------------------- |
| `@deploytruth/core`          | Domain schemas, rules, verdicts, topology, redaction primitives | Provider SDKs, filesystem I/O, CLI, React |
| `@deploytruth/config`        | YAML parsing and manifest normalization                         | Provider calls, rule evaluation           |
| `@deploytruth/providers`     | Read-only adapter contracts and fixture adapters                | Verdict logic, report persistence         |
| `@deploytruth/reporter`      | Safe JSON serialization and local report files                  | Raw payload parsing, rule evaluation      |
| `@deploytruth/cli`           | Arguments, orchestration, output, exit policy                   | Provider-specific truth logic             |
| `@deploytruth/web`           | Rendering a supplied `TruthReport`                              | Rule evaluation or verdict aggregation    |
| `@deploytruth/github-action` | Future CLI invocation contract                                  | A second truth engine                     |

The dependency direction is intentionally one-way:

```text
deploytruth.yml -> config ------------------+
provider APIs -> providers -> core ----------+-> reporter -> JSON files
local Git -> providers ----------------------+-> CLI / web report viewer
```

`core` has no UI or provider-SDK dependency. The UI receives an already-evaluated report and
never infers node health, severity, or verdict.

## Normalized truth model

The engine works with three models:

1. `ProjectDeclaration`: normalized declared state.
2. `ProjectObservation`: source, deployment, database, runtime, migration, and variable-presence
   evidence from adapters.
3. `TruthReport`: versioned, safe-to-store environment truth, findings, and topology.

| Provider concern              | Normalized field                               |
| ----------------------------- | ---------------------------------------------- |
| Local HEAD SHA                | `SourceObservation.headSha`                    |
| Local branch / detached state | `SourceObservation.branch`, `.detachedHead`    |
| Working tree state            | `SourceObservation.workingTree` + counts/lists |
| Local tracking ref SHA        | `SourceObservation.upstream.sha` (local only)  |
| Ahead/behind vs tracking ref  | `SourceObservation.aheadBy` / `.behindBy`      |
| GitHub branch SHA             | `SourceObservation.remoteHeadSha`              |
| Vercel deployment SHA         | `DeploymentObservation.commitSha`              |
| Vercel connected database     | `DeploymentObservation.connectedResources`     |
| Supabase project ref          | `DatabaseObservation.projectRef`               |
| Runtime `/api/version` commit | `RuntimeObservation.commitSha`                 |

Only normalized observations may reach `core`. Raw responses stay inside an adapter function and
are discarded after translation.

## Manifest

The v1 YAML shape stays deliberately small:

```yaml
version: 1
project: my-app
environments:
  production:
    kind: production
    source: { provider: github, repository: owner/my-app, branch: main }
    deployment: { provider: vercel, project: my-app }
    database: { provider: supabase, project_ref: prod-ref }
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

The foundation includes:

- `DIRTY_WORKTREE` -> warning
- `REPOSITORY_OPERATION_IN_PROGRESS` -> warning
- `DETACHED_HEAD` -> warning
- `NO_UPSTREAM_CONFIGURED` -> warning
- `LOCAL_BRANCH_AHEAD_OF_UPSTREAM` -> informational warning
- `LOCAL_BRANCH_BEHIND_UPSTREAM` -> warning
- `LOCAL_BRANCH_DIVERGED` -> high warning
- `DEPLOYMENT_SHA_MISMATCH` -> fail
- `WRONG_DATABASE_PROJECT` -> fail
- `PREVIEW_USES_PRODUCTION_DATABASE` -> critical fail
- `DATABASE_MIGRATIONS_BEHIND` -> fail
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
and finding codes. The web app can later map these to React Flow without changing truth logic.

`TruthReport` is versioned (`schemaVersion: "0.1"`) and serializable. `reporter` validates it,
runs final recursive sanitization, then writes a timestamped report and
`.deploytruth/reports/latest.json`. No historical database is introduced in v0.1.

The optional runtime endpoint contains only commit, environment, and build time:

```json
{ "commit": "d7f8ff5", "environment": "production", "buildTime": "2026-09-10T18:24:00Z" }
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
| CLI/UI coupling                | CLI emits reports; UI renders reports. Neither owns rule implementation.                         |
| Overengineering                | Four runtime packages plus one viewer; no plugin registry, accounts, database, or SDKs in M0.    |

## Milestone sequence

M0 is the foundation. M1 (current) adds local Git observations through `packages/providers/src/git/`
— an allowlisted, read-only `GitRunner` plus a `local-git` adapter producing `SourceObservation`
(`docs/git-truth.md` covers semantics). M2 GitHub, M3 Vercel, M4 Supabase,
M5 wires production rule selection, M6 makes `check` live, M7 runtime identity, M8 the local
topology UI, and M9 the action. Every adapter milestone starts with fixtures.
