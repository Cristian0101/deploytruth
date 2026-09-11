# ADR 003: Local tracking refs are not remote truth

## Status

Accepted

## Context

M1 adds local Git observation. A local `refs/remotes/<remote>/<branch>` tracking ref only records
what the remote looked like at the last fetch. Because DeployTruth never fetches in M1, treating the
tracking ref as "the remote branch" would fabricate certainty.

## Decision

`SourceObservation.remoteHeadSha` is reserved for remote-authoritative evidence (GitHub API in M2).
The local adapter reports its tracking ref in a separate `upstream` object
(`remote`, `branch`, `ref`, `sha`), explicitly labeled as local in output. `remoteHeadSha` stays
unset from local Git, so `DEPLOYMENT_SHA_MISMATCH` and friends cannot mistake a stale tracking ref
for live remote state; they fall back to local `headSha` until remote adapters exist.

## Consequences

M1 can truthfully state "local origin/main tracking ref is ABC123" but never "GitHub main is
ABC123". Reports stay honest about evidence freshness at the cost of one more field on the
observation schema.
