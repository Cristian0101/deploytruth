# Finding reference

This table mirrors the current deterministic rule registry. `WARN` means attention or missing
evidence; `FAIL` means a deterministic contradiction. `INFO/WARNING/HIGH/CRITICAL` is severity,
not the process exit code. Use the Inspector or CLI report for the run-specific expected,
observed, evidence, and remediation fields.

| Finding                                       | Check                   | Result / severity      | Meaning and first investigation                                                                                                |
| --------------------------------------------- | ----------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `REQUIRED_OBSERVATION_UNAVAILABLE`            | coverage                | WARN / WARNING         | An enabled check lacks evidence. Supply read-only access or disable only intentionally out-of-scope checks.                    |
| `DIRTY_WORKTREE`                              | `local_git`             | WARN / WARNING         | The checkout has uncommitted changes. Inspect staged, modified, untracked, and unmerged paths.                                 |
| `REPOSITORY_OPERATION_IN_PROGRESS`            | `local_git`             | WARN / WARNING         | Git reports an unfinished merge, rebase, cherry-pick, revert, or bisect.                                                       |
| `DETACHED_HEAD`                               | `local_git`             | WARN / WARNING         | HEAD is detached. Confirm the checkout represents the intended branch.                                                         |
| `NO_UPSTREAM_CONFIGURED`                      | `local_git`             | WARN / WARNING         | The current branch has no tracking branch. Configure the intended upstream.                                                    |
| `LOCAL_BRANCH_AHEAD_OF_UPSTREAM`              | `local_git`             | WARN / INFO            | Local commits are not present in the tracking ref. Confirm whether they should be pushed.                                      |
| `LOCAL_BRANCH_BEHIND_UPSTREAM`                | `local_git`             | WARN / WARNING         | The tracking ref contains commits absent locally. Fetch/pull deliberately.                                                     |
| `LOCAL_BRANCH_DIVERGED`                       | `local_git`             | WARN / HIGH            | Local and tracking histories both contain unique commits. Inspect both sides before reconciling.                               |
| `STALE_TRACKING_REF`                          | `remote_source`         | WARN / WARNING         | Local remote-tracking SHA differs from authoritative GitHub. Run `git fetch`, then recheck.                                    |
| `LOCAL_HEAD_DIFFERS_FROM_GITHUB`              | `remote_source`         | WARN / INFO or WARNING | Local HEAD differs from the declared GitHub branch; same-branch differences are more severe.                                   |
| `DECLARED_BRANCH_DIFFERS_FROM_GITHUB_DEFAULT` | `remote_source`         | WARN / INFO            | The declared source branch is not GitHub's default branch. Confirm that choice is intentional.                                 |
| `GITHUB_REPOSITORY_UNAVAILABLE`               | `remote_source`         | WARN / WARNING         | GitHub repository truth could not be observed. Check identity, visibility, token, and rate limit.                              |
| `GITHUB_BRANCH_UNAVAILABLE`                   | `remote_source`         | WARN / WARNING         | The declared GitHub branch could not be observed. Check branch spelling and access.                                            |
| `DEPLOYMENT_SHA_MISMATCH`                     | `deployment_sha`        | FAIL / HIGH            | Vercel production was built from a different SHA than authoritative source. Inspect deployment source and rollback intent.     |
| `DEPLOYMENT_SOURCE_UNVERIFIED`                | `deployment_sha`        | WARN / WARNING         | The deployment source commit was not proven. Inspect Vercel source metadata and access.                                        |
| `VERCEL_PROJECT_UNAVAILABLE`                  | `deployment_sha`        | WARN / WARNING         | The declared Vercel project could not be observed. Check project, scope, and token.                                            |
| `VERCEL_PRODUCTION_DEPLOYMENT_UNAVAILABLE`    | `deployment_sha`        | WARN / WARNING         | Current production deployment could not be determined. Inspect aliases and API availability.                                   |
| `VERCEL_PRODUCTION_ROUTING_AMBIGUOUS`         | `deployment_sha`        | WARN / WARNING         | Production aliases identify competing deployments. Resolve routing deliberately.                                               |
| `DEPLOYMENT_NOT_READY`                        | `deployment_sha`        | WARN / WARNING         | Production exists but is not ready. Inspect current Vercel state.                                                              |
| `DEPLOYMENT_FAILED`                           | `deployment_sha`        | FAIL / HIGH            | Vercel reports the production deployment in a failed state. Inspect that deployment.                                           |
| `STABLE_DOMAIN_STALE`                         | `deployment_sha`        | FAIL / HIGH            | The declared stable domain does not route to the current production deployment.                                                |
| `WRONG_DATABASE_PROJECT`                      | cross-check             | FAIL / HIGH            | Observed database identity contradicts the declared Supabase project. Check every connection source.                           |
| `PREVIEW_USES_PRODUCTION_DATABASE`            | `environment_isolation` | FAIL / CRITICAL        | A preview environment targets the declared production database. Correct isolation immediately.                                 |
| `SUPABASE_PROJECT_UNAVAILABLE`                | `migrations`            | WARN / WARNING         | Supabase control-plane project truth is unavailable. Check ref, access token, and API reachability.                            |
| `DATABASE_CONNECTION_UNAVAILABLE`             | `migrations`            | WARN / WARNING         | The verified read-only DB session could not be established. Check URL, network, role, and TLS.                                 |
| `DATABASE_IDENTITY_UNVERIFIED`                | `migrations`            | WARN / WARNING         | A successful session did not establish declared database identity. Do not infer it from the URL alone.                         |
| `MIGRATION_SOURCE_UNAVAILABLE`                | `migrations`            | WARN / WARNING         | Repository migration files could not be read from the declared source SHA/path.                                                |
| `MIGRATION_SOURCE_INVALID`                    | `migrations`            | WARN / WARNING         | Source migration names/shape are not valid for deterministic comparison.                                                       |
| `DATABASE_MIGRATION_HISTORY_UNAVAILABLE`      | `migrations`            | WARN / WARNING         | Applied migration metadata could not be read. Check table presence and read-only role access.                                  |
| `DATABASE_MIGRATIONS_BEHIND`                  | `migrations`            | FAIL / HIGH            | Source contains migrations not applied to the observed database. Review the missing versions.                                  |
| `DATABASE_MIGRATION_DRIFT`                    | `migrations`            | WARN / WARNING         | Database reports applied migrations absent from source. Check branch/source history.                                           |
| `RUNTIME_ATTESTATION_UNAVAILABLE`             | coverage                | WARN / WARNING         | The running app did not provide authoritative attestation. Check endpoint reachability and contract.                           |
| `RUNTIME_ATTESTATION_FRESHNESS_UNVERIFIED`    | coverage                | WARN / WARNING         | The nonce was not echoed exactly, so the response may be stale or replayed.                                                    |
| `RUNTIME_SHA_MISMATCH`                        | `runtime_identity`      | FAIL / HIGH            | Running SHA differs from the active deployment SHA. Inspect rollout/convergence and runtime target.                            |
| `RUNTIME_ENVIRONMENT_MISMATCH`                | `environment_isolation` | FAIL / HIGH            | Runtime reports a different environment identity than declared.                                                                |
| `RUNTIME_REQUIRED_ENV_MISSING`                | `environment_variables` | FAIL / HIGH            | Runtime reports a required variable name as absent. Inspect deployment configuration without exposing its value.               |
| `RUNTIME_DATABASE_PROJECT_MISMATCH`           | `environment_isolation` | FAIL / HIGH            | Runtime targets a different Supabase project than declared. Correct the runtime connection.                                    |
| `RUNTIME_DATABASE_IDENTITY_UNVERIFIED`        | `environment_isolation` | WARN / WARNING         | Runtime DB target identity could not be verified. Do not treat presence as connectivity.                                       |
| `RUNTIME_DATABASE_CONNECTION_UNAVAILABLE`     | `environment_isolation` | WARN / WARNING         | The runtime's harmless read probe could not verify connectivity. Check publishable-key/URL configuration and reachability.     |
| `ENVIRONMENT_VARIABLE_MISSING`                | `environment_variables` | FAIL / HIGH            | A required variable name is absent from observed deployment evidence. Inspect provider configuration without reporting values. |

The source authority is [`packages/core/src/rules.ts`](../packages/core/src/rules.ts). A docs drift
test requires every registry code to appear exactly once in this table.
