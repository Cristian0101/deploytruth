# DeployTruth GitHub Action

DeployTruth runs in CI as a JavaScript Action that wraps the exact same certified
`runEnvironmentCheck` orchestration as `deploytruth check`. One Action invocation produces one
`TruthReport` — there is no separate "CI truth". The Action then adapts that single report into
four surfaces:

1. the GitHub Job Summary (human-readable),
2. machine-readable step outputs,
3. a sanitized evidence bundle under `RUNNER_TEMP` for upload as a workflow artifact, and
4. a step result controlled by the explicit `fail-on` policy.

DeployTruth is pre-1.0. The Action's inputs, outputs, and evidence schemas may still change.

## Usage

```yaml
name: DeployTruth

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  certify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - id: deploytruth
        uses: Cristian0101/deploytruth@v0
        with:
          environment: production
          config: deploytruth.yml # optional; repository-relative
          fail-on: fail # optional; fail | warn | never
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          DEPLOYTRUTH_VERCEL_TOKEN: ${{ secrets.DEPLOYTRUTH_VERCEL_TOKEN }}
          DEPLOYTRUTH_SUPABASE_ACCESS_TOKEN: ${{ secrets.DEPLOYTRUTH_SUPABASE_ACCESS_TOKEN }}
          DEPLOYTRUTH_SUPABASE_DATABASE_URL: ${{ secrets.DEPLOYTRUTH_SUPABASE_DATABASE_URL }}

      - name: Upload DeployTruth evidence
        if: always() && steps.deploytruth.outputs.artifact-directory != ''
        uses: actions/upload-artifact@v7
        with:
          name: deploytruth-${{ steps.deploytruth.outputs.run-id }}
          path: ${{ steps.deploytruth.outputs.artifact-directory }}
          retention-days: 14
```

The Action requires no install step: the shipped entrypoint at
`packages/github-action/dist/index.js` is a self-contained bundle of the truth engine and its
runtime dependencies.

Two refs serve the Action: `v0` is the moving compatible pre-1.0 ref that tracks certified
releases, and `v0.1.0`-style tags are immutable version pins. Use `@v0` for the normal
consumption path; pin `@v0.1.0` (or a commit SHA) when a workflow needs an exact, unchanging
artifact. Contributors can use `uses: ./` inside this repository. See
[docs/releasing.md](releasing.md) for the release procedure that advances the moving ref.

## Inputs

| Input         | Required | Default           | Meaning                                                       |
| ------------- | -------- | ----------------- | ------------------------------------------------------------- |
| `environment` | yes      | —                 | Declared environment to certify (must exist in the manifest). |
| `config`      | no       | `deploytruth.yml` | Repository-relative manifest path.                            |
| `fail-on`     | no       | `fail`            | Verdict exit policy: `fail`, `warn`, or `never`.              |

`config` is resolved strictly under `GITHUB_WORKSPACE`; absolute paths, `..` segments,
backslashes, NUL, and control characters are rejected. An Action input can never become
arbitrary filesystem access.

Provider credentials are **environment variables**, never Action inputs. Use the same variable
names the providers already expect: `DEPLOYTRUTH_GITHUB_TOKEN` or the workflow's `GITHUB_TOKEN`,
`DEPLOYTRUTH_VERCEL_TOKEN` (or `VERCEL_TOKEN`), `DEPLOYTRUTH_SUPABASE_ACCESS_TOKEN` (or
`SUPABASE_ACCESS_TOKEN`), and `DEPLOYTRUTH_SUPABASE_DATABASE_URL`. Scope them to the step — not
the workflow — and never commit them.

### Verified Supabase CA trust

The maintained acceptance workflow uses the public
`.github/trust/supabase-root-2021-ca.crt` only for its certification step through
`NODE_EXTRA_CA_CERTS`. This is an **additional** Node trust anchor; it does not disable normal
certificate-chain or hostname verification. Before the Action runs, the workflow verifies that
the file has no private-key block, has the pinned SHA-256 fingerprint
`80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`,
and remains valid for at least one day.

Supabase directs users to download the database root certificate from the project's Database
Settings when using `verify-full` TLS. The committed root is public trust material from that
source, not a credential. Never replace it with a private key, database URL, password, access
token, or an insecure TLS override.

## Outputs

| Output               | Example                                              | Meaning                                |
| -------------------- | ---------------------------------------------------- | -------------------------------------- |
| `verdict`            | `PASS`                                               | Truth verdict: `PASS`, `WARN`, `FAIL`. |
| `run-id`             | `01J9X8W0…`                                          | The TruthReport run ID (ULID).         |
| `verified`           | `7`                                                  | Enabled checks with no findings.       |
| `warnings`           | `0`                                                  | WARN finding count.                    |
| `failures`           | `0`                                                  | FAIL finding count.                    |
| `findings`           | `0`                                                  | Total finding count.                   |
| `report-path`        | `$RUNNER_TEMP/deploytruth/<runId>/truth-report.json` | Sanitized report file.                 |
| `summary-path`       | `…/summary.md`                                       | Markdown summary file.                 |
| `metadata-path`      | `…/ci-metadata.json`                                 | CI provenance file.                    |
| `artifact-directory` | `$RUNNER_TEMP/deploytruth/<runId>`                   | Complete bundle directory.             |
| `environment`        | `production`                                         | The certified environment.             |

All outputs are stable strings — safe for `if:` comparisons like
`steps.deploytruth.outputs.verdict == 'PASS'`. Outputs never contain the raw report JSON,
provider credentials, environment values, or raw evidence blobs.

## Exit policy

`fail-on` applies only when a valid `TruthReport` exists:

| Verdict | `fail-on: fail`    | `fail-on: warn` | `fail-on: never`         |
| ------- | ------------------ | --------------- | ------------------------ |
| PASS    | step succeeds      | step succeeds   | step succeeds            |
| WARN    | succeeds + warning | step fails      | succeeds + warning       |
| FAIL    | step fails         | step fails      | succeeds + clear warning |

With `fail-on: never` a FAIL verdict stays successful in CI but the Job Summary still says
`FAIL` and the log warns explicitly — the verdict is never disguised.

**Execution errors always fail the step** regardless of `fail-on`: invalid manifest, unsafe
config path, missing required input, report serialization failure, or an Action runtime
exception. An execution failure is not a truth verdict; no `verdict` output is produced and the
Job Summary reports `DeployTruth execution failed before certification.`

Summary, outputs, and the artifact bundle are written **before** the fail policy is applied, so
a failed certification still leaves complete evidence.

## Job Summary

The Action writes a bounded Markdown summary to `$GITHUB_STEP_SUMMARY`:

- a `# DeployTruth — <environment>` header with the verdict,
- `N verified · N warnings · N failures` using the same counting as `deploytruth history`,
- a per-check status table (`VERIFIED`, `WARN`, `FAIL`, or `UNVERIFIED` when an enabled check
  lacked required evidence — coverage is never claimed),
- up to 20 findings with code, severity, status, expected/observed evidence, and remediation,
- the run ID.

Text is escaped for Markdown (tables, emphasis, HTML, and `::` command lines cannot be
injected), findings are truncated with "…and N more findings", and the whole summary is capped
well below GitHub's step-summary limit. The same text is stored verbatim as `summary.md` in the
evidence bundle — one implementation, no drift.

## Evidence bundle

For every valid `TruthReport` the Action publishes:

```
$RUNNER_TEMP/deploytruth/<runId>/
├── truth-report.json   # identical to what `deploytruth check --json` produces
├── summary.md          # identical to the Job Summary text
└── ci-metadata.json    # CI provenance (see below)
```

The directory is built in a private staging directory, validated, then atomically renamed — a
partial bundle is never exposed. The bundle lives under the runner's temp directory, not the
repository, so certification never dirties the worktree.

Upload it with the official `actions/upload-artifact` action as shown above. DeployTruth is not
an artifact-storage client and does not upload anything itself.

### `ci-metadata.json`

CI execution provenance — **not** infrastructure truth:

```json
{
  "schemaVersion": "1",
  "provider": "github-actions",
  "repository": "owner/repo",
  "workflow": "DeployTruth",
  "job": "certify",
  "githubRunId": "123456789",
  "githubRunAttempt": "1",
  "githubRunNumber": "42",
  "eventName": "workflow_dispatch",
  "gitSha": "…",
  "gitRef": "refs/heads/main",
  "environment": "production",
  "truthRunId": "01J9X8W0…",
  "verdict": "PASS",
  "generatedAt": "2026-01-01T00:00:00.000Z"
}
```

Every field is allowlisted and shape-checked; malformed context values are dropped rather than
trusted. The file never contains actor identities, event payloads, server URLs, environment
dumps, secret names or values, or runner filesystem details. `truthRunId` is the TruthReport run
ID; `githubRunId` is the workflow run — they are deliberately different identities.

## Trusted events and secrets

Secret-bearing certification must run from trusted events only:

- **`pull_request_target` is refused.** The Action checks `GITHUB_EVENT_NAME` and fails with a
  security error before any provider access. That event runs trusted workflow code but can check
  out untrusted fork code while secrets remain exposed — there is no safe way for the Action to
  prove otherwise.
- **Fork `pull_request` runs receive no repository secrets** — GitHub's own boundary, which
  DeployTruth does not try to circumvent. Full production certification on PRs is not supported;
  a public/source-only check may still report honest `WARN`/`UNVERIFIED` evidence.
- **Recommended triggers:** `workflow_dispatch`, `push` to a protected main branch (only when
  deployment ordering is proven — see below), or a trusted post-deployment workflow
  (`workflow_run`, `deployment_status`) once your platform reliably emits it.

DeployTruth certifies state **when invoked** — it never polls until reality becomes convenient
and never retries a mismatch away. Trigger certification when the deployment you intend to
certify is expected to exist. Certifying immediately on `push` can capture a Vercel deployment
that has not converged yet; that WARN/FAIL is truthful, not a bug.

## Permissions

The job needs only `contents: read` (for checkout). DeployTruth does not use the Checks API, so
no `checks: write` is required — the step result is the enforcement. It performs no deployment,
environment, or provider mutation of any kind.

## Relationship to other surfaces

| Surface                    | What it is                                                         |
| -------------------------- | ------------------------------------------------------------------ |
| `TruthReport`              | The normalized infrastructure truth — identical locally and in CI  |
| Job Summary / `summary.md` | Human rendering of that report (one shared implementation)         |
| `ci-metadata.json`         | Where and when CI produced the report — provenance, not truth      |
| workflow step result       | The `fail-on` policy applied to the verdict                        |
| `.deploytruth/` history    | M7 local history; on ephemeral runners it is per-run scratch state |

CI does not synchronize with local report history, and the artifact bundle does not contain the
`.deploytruth` directory. Durable CI evidence is the uploaded bundle — three files, nothing
else.
