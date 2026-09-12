# ADR 008: Finding identity and semantic run comparison

## Status

Accepted

## Context

M7 must explain what changed between two DeployTruth runs without dumping a generic JSON diff.
Findings cannot be identified by array position. Hashing raw evidence would either leak secret
material into identity or treat harmless metadata churn as a new defect.

The UI must not calculate comparison truth. Providers must not be contacted during comparison.

## Decision

Finding identity is:

```text
<code>|<environment>:<type>:<identifier>,...
```

Affected component tuples are sorted. `identifier` is omitted when absent. Expected values,
observed values, evidence objects, titles, and remediation text are excluded from identity.

Between two reports, that identity classifies a finding as:

- **NEW** — present only in the later run
- **RESOLVED** — present only in the earlier run
- **PERSISTING** — same identity, and status, severity, expected, and observed are unchanged
- **CHANGED** — same identity, but status, severity, expected, or observed changed

A persistent `DEPLOYMENT_SHA_MISMATCH` whose expected SHA moved from A to C while remaining
mismatched is therefore **CHANGED**, not a resolved finding plus a new one.

`RunComparison` is produced by `compareTruthReports` in `@deploytruth/core` from two already
normalized `TruthReport` objects. The local server and CLI call that function. The web app only
renders the result.

Truth-relevant identity changes (source SHA, deployment SHA, runtime SHA, runtime environment,
database project ref, migration counts) are first-class. `generatedAt`, `runId`, rate-limit
remaining, and similar timestamps are ignored as truth changes.

## Consequences

- Comparison stays provider-neutral, deterministic, and serializable.
- The same relationship can be tracked across SHA movement without identity thrash.
- Evidence blobs never enter the identity hash.
- Older unsupported report versions cannot be silently compared as current truth.
