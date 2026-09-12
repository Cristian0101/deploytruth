# ADR 005: Current production is the alias target, not the newest deployment

## Status

Accepted

## Context

M3 answers "what code is Vercel actually serving as production?" The obvious API surfaces are
deceptive:

- `GET /v6/deployments?target=production` returns production-targeted deployments newest first —
  but Vercel Instant Rollback re-assigns production domains to an _existing_ deployment without
  creating a new one. After a rollback, the newest `target=production` deployment is the one
  rolled back _from_, not the one serving traffic.
- `GET /v9/projects/{id}` → `latestDeployments` is ordered by creation and mixes preview and
  production deployments; a newer preview must never be mistaken for production.

The routing-layer truth is the production-domain assignment table on the project object:
`GET /v9/projects/{idOrName}` → `alias[]`, where each entry carries `domain`, a `target`/
`environment` classification, `redirect`, and the currently assigned `deployment.id`. Whatever
those production aliases point at is what Vercel is serving as production right now — including
after rollbacks.

## Decision

The Vercel adapter resolves production as follows:

1. `GET /v9/projects/{idOrName}` establishes project identity and returns `alias[]`.
2. Entries classified `production` (`target` wins over `environment`), non-redirect, with an
   assigned `deployment.id` form the production alias set. Preview branch aliases and redirects
   are excluded.
3. The current production deployment is the one serving the most production aliases; ties break
   deterministically (smallest domain, then smallest deployment id).
4. `GET /v13/deployments/{id}?withGitRepoInfo=true` then yields authoritative `readyState`,
   `createdAt`, `url`, and source metadata.

The source commit SHA comes only from the deployment's own metadata — `meta.githubCommitSha`
(equivalently `gitlabCommitSha`/`bitbucketCommitSha`) or `gitSource.sha` — never inferred from
ids, URLs, timestamps, or GitHub state. Absent metadata produces `DEPLOYMENT_SOURCE_UNVERIFIED`,
never an assumed match.

When the manifest declares `domain`, the same alias table verifies whether that stable domain
resolves to the current production deployment (`stableDomainVerified`).

## Consequences

- Rollback and preview/newest ambiguity are handled correctly by construction.
- Two GET calls per observation; no deployment list call is needed at all.
- A project with no production domain assignment produces `VERCEL_PRODUCTION_DEPLOYMENT_UNAVAILABLE`
  rather than a guess.
- Divergent production aliases (mid-migration) resolve deterministically; the verdict reflects
  the majority assignment.
- Only the `production` target is observed in M3; preview/custom-environment truth is deferred.
