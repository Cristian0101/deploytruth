# Vercel deployment truth (M3)

M2 answered "what does GitHub actually say?" M3 answers "what code is production actually
running?" — and compares the two answers instead of trusting either one.

## What is observed

`packages/providers/src/vercel/` performs exactly two read-only REST calls through the
`ReadOnlyTransport` contract (GET-only by construction):

1. `GET /v9/projects/{idOrName}` → project identity and `alias[]`, the project's
   domain→deployment assignment table.
2. `GET /v13/deployments/{id}?withGitRepoInfo=true` → the current production deployment's
   `readyState`, `createdAt`, `url`, and source metadata (`meta`, `gitSource`).

It returns a normalized `deployment` observation — never a raw API payload.

## Current production is not the newest deployment

Vercel's Instant Rollback re-points production domains to an existing deployment without
creating a new one, and `latestDeployments` mixes preview and production entries. DeployTruth
therefore resolves production through the project's production-domain aliases (ADR 005): the
deployment those aliases currently point at is the deployment serving production. Preview
aliases and redirect entries are excluded; if production aliases disagree mid-migration, the
deployment serving the most production domains wins with a deterministic tie-break.

## Normalized observation

```json
{
  "provider": "vercel",
  "availability": { "state": "available" },
  "project": "example",
  "target": "production",
  "environment": "production",
  "deploymentId": "dpl_abc123",
  "deploymentUrl": "https://example-abc123.vercel.app",
  "state": "ready",
  "commitSha": "xyz789",
  "sourceBranch": "main",
  "createdAt": "2026-09-11T18:42:10Z",
  "stableDomain": "app.example.com",
  "stableDomainVerified": true
}
```

`readyState` is normalized: `READY`→`ready`, `BUILDING`/`INITIALIZING`→`building`,
`QUEUED`→`queued`, `ERROR`→`error`, `CANCELED`→`canceled`, anything else (`BLOCKED`,
unrecognized)→`unknown`. `commitSha` is the source commit Vercel recorded for the deployment —
`meta.githubCommitSha` (or the gitlab/bitbucket equivalents), with `gitSource.sha` as fallback.
It is never inferred from ids, URLs, timestamps, or GitHub state; when absent, the observation
carries no `commitSha` and truth becomes `DEPLOYMENT_SOURCE_UNVERIFIED`.

## Availability instead of assumption

Every Vercel observation carries `availability`. Normalized reasons: `missing_credentials`,
`deployment_unavailable` (project observed, but no production assignment exists), plus the
shared remote reasons (`not_found`, `unauthorized`, `forbidden`, `rate_limited`,
`server_error`, `unexpected_status`, `malformed_response`, `network_error`, `timeout`,
`aborted`). A `404` is _unavailable_, never "does not exist" — tokens and scope determine what
a caller can see. Rate-limit metadata is limited to `limit`, `remaining`, `resetAt`, and
`retryAfter` seconds; raw headers are never copied.

## Configuration

```yaml
environments:
  production:
    source:
      provider: github
      repository: owner/repo
      branch: main
    deployment:
      provider: vercel
      project: example # name or prj_ id
      target: production # only supported target in M3; defaults to production
      scope: kaizora # optional team slug, or team_... id
      domain: app.example.com # optional bare hostname
```

`scope` becomes the `slug` query parameter, or `teamId` when it starts with `team_`. `domain`
is a bare hostname (no scheme/path) normalized to lowercase. Only `production` is supported in
M3 — preview/custom-environment targets are deliberately deferred. Old M2-era manifests without
a `deployment` block remain valid and simply lack deployment evidence (WARN, never PASS).

## Authentication

Token precedence, resolved from the environment at observation time:

1. `DEPLOYTRUTH_VERCEL_TOKEN`
2. `VERCEL_TOKEN`
3. neither → `missing_credentials` (Vercel has no anonymous project truth)

The token lives inside the transport closure and becomes an `Authorization` header on the wire
only — never in the adapter, observations, findings, reports, logs, or fixtures. `doctor`
reports `available`/`none` plus the variable _name_.

## Stable domain verification

When `domain` is declared, the project's alias table verifies whether that domain currently
resolves to the production deployment: `true` when the domain's assigned deployment matches,
`false` when it positively resolves elsewhere or is not attached to the project
(`STABLE_DOMAIN_STALE`, HIGH/FAIL), absent when the assignment is inconclusive
(`STABLE_DOMAIN_STALE`, WARNING/WARN). No DNS writes, alias writes, or browser probing — only
Vercel control-plane evidence.

## Rollback semantics

If GitHub `main` is `XYZ789` and production intentionally rolled back to `ABC123`, DeployTruth
reports `DEPLOYMENT_SHA_MISMATCH` — the declaration describes the expected source. DeployTruth
does not guess that a rollback was intentional. Truth first; a future feature may let the
manifest declare pinned/rolled-back state.

## Rules

| Code                                       | Severity        | Condition                                                                           |
| ------------------------------------------ | --------------- | ----------------------------------------------------------------------------------- |
| `DEPLOYMENT_SHA_MISMATCH`                  | HIGH / FAIL     | Authoritative source SHA and deployment source SHA both exist and differ            |
| `DEPLOYMENT_SOURCE_UNVERIFIED`             | WARNING / WARN  | Deployment observed but no trustworthy source commit                                |
| `VERCEL_PROJECT_UNAVAILABLE`               | WARNING / WARN  | Project metadata could not be observed (credentials, scope, rename, API failure)    |
| `VERCEL_PRODUCTION_DEPLOYMENT_UNAVAILABLE` | WARNING / WARN  | Project observed but current production deployment cannot be established            |
| `DEPLOYMENT_NOT_READY`                     | WARNING / WARN  | Production deployment is building, queued, or in an unrecognized state              |
| `DEPLOYMENT_FAILED`                        | HIGH / FAIL     | Production deployment is in an error or canceled state                              |
| `STABLE_DOMAIN_STALE`                      | HIGH or WARNING | Declared domain positively mis-assigned (FAIL), or verification inconclusive (WARN) |

All deployment rules are gated by the `deployment_sha` check; `checks: { deployment_sha: false }`
opts out entirely. The expected side of `DEPLOYMENT_SHA_MISMATCH` is the remote-authoritative
source SHA (`remoteSource.remoteHeadSha`); local HEAD is a fallback only when no remote
observation exists at all — a failed GitHub observation can never be papered over by local
evidence, so deployment SHA truth cannot false-PASS.

## Limitations

- Only `target: production` is observed; preview and custom-environment truth is deferred.
- Environment-variable _values_ are never fetched; variable presence observation lands with the
  environment-isolation milestone. A manifest declaring `required_environment_variables` reports
  that evidence as unverified rather than assuming it.
- Production resolution depends on Vercel's `alias[]` control-plane view; a project with no
  production domain assignment reports `VERCEL_PRODUCTION_DEPLOYMENT_UNAVAILABLE`.
- Build logs, deployment cancellation, and every mutation endpoint are out of scope by design.

## Example

```text
DEPLOYMENT
  Vercel
    Project            example
    Target             production
    Deployment         dpl_abc123
    State              READY
    Source branch      main
    Source SHA         xyz789
    Domain             app.example.com (verified)
    Created            2026-09-11T18:42:10Z
  Deployment truth     VERIFIED — production serves xyz789
```
