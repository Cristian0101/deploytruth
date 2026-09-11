# ADR 004: Remote-authoritative source truth is a separate observation

## Status

Accepted

## Context

M1 established that a local `refs/remotes/<remote>/<branch>` tracking ref is only the last fetched
state — not remote truth (ADR 003). M2 adds the GitHub adapter, which answers "what does GitHub
say this branch points to right now?" An environment can therefore hold two source observations
from two different authorities at once: the local machine and the remote host.

Merging them into one `source` observation would fabricate a single authority and make it
impossible to compare the two claims — which is the entire point of M2.

## Decision

`EnvironmentObservation` gains `remoteSource`, a second `SourceObservation` produced by
remote-aware adapters (`provider: "github"` in M2). `source` remains the local observation;
`remoteSource` is the remote-authoritative one. Neither overwrites the other.

Remote observations populate `remoteHeadSha` (the SHA the remote reports for the observed branch),
`defaultBranch`, `visibility`, `archived`, and an `availability` record. `availability` is the
honesty primitive: remote-aware adapters always set it, so an unreachable or unauthorized remote
produces `state: "unavailable"` with a normalized `reason` rather than fabricated truth or a
missing observation. A new `remote_source` check is applicable whenever a source is declared; its
coverage requires `remoteSource.availability.state === "available"`, so missing or failed GitHub
evidence can never produce a false `PASS`.

Rules comparing local and remote state (`STALE_TRACKING_REF`, `LOCAL_HEAD_DIFFERS_FROM_GITHUB`)
read both observations. `sourceSha` — the "best available source SHA" used by deployment rules —
now prefers `remoteSource.remoteHeadSha` over the legacy merged `source.remoteHeadSha` field over
`source.headSha`, so M0-era fixtures remain valid while M2+ reports prefer authoritative truth.

## Consequences

- The local adapter is untouched; it still leaves `remoteHeadSha` unset (ADR 003).
- `remoteHeadSha` on a `source` observation remains schema-valid for backward-compatible fixtures,
  but no current adapter produces it there; remote adapters write it on `remoteSource`.
- Every remote-source rule degrades gracefully: absent `remoteSource` is a coverage gap
  (`REQUIRED_OBSERVATION_UNAVAILABLE`), and an `unavailable` remoteSource produces explicit
  `GITHUB_*_UNAVAILABLE` findings — never a silent PASS and never an assumed failure.
- Future remote providers (GitLab, Bitbucket) reuse the same slot; only `GITHUB_*`-named rules
  are provider-specific.
