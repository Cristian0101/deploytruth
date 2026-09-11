# GitHub authoritative source truth (M2)

M1 answered "what does my machine believe?" M2 answers "what does GitHub actually say?" — and
compares the two claims instead of trusting either one.

## The three source facts

| Fact                            | Authority                       | Field                              |
| ------------------------------- | ------------------------------- | ---------------------------------- |
| Local HEAD                      | Your checked-out commit         | `source.headSha`                   |
| Local tracking ref              | Last fetch (`refs/remotes/...`) | `source.upstream.sha` — local only |
| GitHub authoritative branch SHA | GitHub REST API, right now      | `remoteSource.remoteHeadSha`       |

The local tracking ref is only the last fetched state. If GitHub's `main` moved since the last
fetch, the tracking ref is **stale** — that is normal, expected, and exactly what
`STALE_TRACKING_REF` reports.

## What the adapter does

`packages/providers/src/github/` performs exactly two read-only REST calls through the
`ReadOnlyTransport` contract:

1. `GET /repos/{owner}/{repo}` → default branch, visibility, archived flag.
2. `GET /repos/{owner}/{repo}/branches/{branch}` → the branch's current head SHA.

It returns a normalized `remoteSource` observation — never a raw API payload. The transport
exposes `get()` only; there is no code path for any other HTTP method.

## Availability instead of assumption

Every GitHub observation carries `availability`:

```json
{ "state": "available" }
{ "state": "unavailable", "target": "repository", "reason": "rate_limited",
  "detail": "GitHub API rate limit exceeded.",
  "rateLimit": { "limit": 60, "remaining": 0, "resetAt": "2026-09-11T14:00:00Z" } }
```

Normalized reasons: `not_found`, `unauthorized`, `forbidden`, `rate_limited`, `server_error`,
`unexpected_status`, `malformed_response`, `network_error`, `timeout`, `aborted`. A `404` is
reported as _unavailable_, never as "does not exist" — GitHub deliberately returns 404 for
private repositories the caller cannot see.

An `unavailable` observation is real evidence of failure: it produces `GITHUB_*_UNAVAILABLE`
warnings and fails `remote_source` coverage. Truth is never fabricated from a failed call.

## Configuration

```yaml
environments:
  production:
    source:
      provider: github
      repository: owner/repo # strict owner/repo form — URLs and extra segments are rejected
      branch: main
```

No credentials live in the manifest. `remote_source` is on by default whenever a source is
declared; `checks: { remote_source: false }` opts out explicitly (which also opts out of the
coverage warning — a deliberate declaration that remote truth is out of scope).

## Authentication

Token precedence, resolved from the environment at observation time:

1. `DEPLOYTRUTH_GITHUB_TOKEN`
2. `GITHUB_TOKEN`
3. neither → unauthenticated access (works for public repositories, lower rate limits)

The token is held inside the transport closure and becomes an `Authorization` header on the
wire only. It is never in the adapter, observations, findings, reports, logs, or fixtures —
`doctor` reports only `available`/`none` plus the variable _name_. Public repositories need no
token; a private repository without one yields `unavailable` evidence, not a guess.

## Rate limits and failures

`403` with `x-ratelimit-remaining: 0` or `429` normalizes to `rate_limited`; the `resetAt` epoch
header becomes an ISO timestamp in the report and the CLI's "Retry after" line. `401`, `403`
(non-quota), `404`, `5xx`, network errors, timeouts, aborts, and malformed bodies each map to
their own normalized reason. Unknown stays unknown — no GitHub-dependent rule can pass on
absent evidence.

## Rules

| Code                                          | Severity       | Condition                                                                                                  |
| --------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------- |
| `STALE_TRACKING_REF`                          | WARNING        | Local tracking SHA and GitHub branch SHA both exist, same branch, differ                                   |
| `LOCAL_HEAD_DIFFERS_FROM_GITHUB`              | WARNING / INFO | Local HEAD and GitHub head both exist and differ; WARNING on the declared branch, INFO on any other branch |
| `DECLARED_BRANCH_DIFFERS_FROM_GITHUB_DEFAULT` | INFO           | Declared branch differs from the repository default branch                                                 |
| `GITHUB_REPOSITORY_UNAVAILABLE`               | WARNING        | Repository metadata could not be authoritatively observed                                                  |
| `GITHUB_BRANCH_UNAVAILABLE`                   | WARNING        | Declared branch could not be authoritatively observed                                                      |

Mismatch is not failure. A feature branch differing from `main` is normal context (INFO); the
same branch differing is worth attention (WARNING). Nothing here is a `FAIL` — deployment truth
(M3+) decides whether production is actually stale.

## Deferred: commit-graph relationships

M2 deliberately stops at `branch -> SHA` evidence. GitHub's compare API (`ahead`/`behind`/
`diverged` between arbitrary commits) would add calls, rate-limit pressure, and ambiguity for
little gain — the local adapter already computes ahead/behind against the tracking ref, and
`STALE_TRACKING_REF` flags when that ref can't be trusted. Revisit only if a later milestone
needs ancestry claims about remote-only commits.

## Limitations

- The tracking-ref comparison matches on branch name only; a local upstream pointing at a
  different remote hosting the same branch name is out of scope (remote URLs are never read —
  see `docs/security.md`).
- Git remote-URL inference is not implemented; `repository: owner/repo` in the manifest is the
  identity. The DeployTruth repository itself having no remote is fully supported.
- Archived repositories are reported as metadata only; they change no verdicts.
- `check` needs network access for live GitHub truth; offline runs produce `unavailable`
  evidence and `WARN`, never a crash or a false `PASS`.

## Example

```text
SOURCE
  Git repository       /repo
  Branch               main
  HEAD                 abc1234
  Working tree         CLEAN
  Tracking ref         origin/main -> abc1234 (local ref; remote unverified)

  GitHub
    Repository         kaizora-labs/example
    Branch             main
    Authoritative SHA  xyz7890
    Default branch     main

FINDINGS
  [WARN/WARNING] STALE_TRACKING_REF — Local remote-tracking ref is stale

VERDICT
  WARN
```
