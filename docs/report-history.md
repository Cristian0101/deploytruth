# Report history and run comparison

M7 answers **what changed** between two local DeployTruth runs. It does not add a hosted
backend, accounts, or a second storage mechanism. History is a filesystem timeline of already
normalized `TruthReport` files.

## Where history lives

Completed checks write under the invoking project:

```text
.deploytruth/reports/<project-key>/<environment-key>/<runId>.json
.deploytruth/reports/<project-key>/<environment-key>/latest.json
.deploytruth/reports/latest.json
```

Pre-M7 reports that still live as flat files beside `latest.json` are not imported automatically.
Open them with `deploytruth open --report <file>` if needed; new checks write into the namespaced
history from this milestone forward.

`latest.json` files are pointers, not extra runs. History listing ignores them and any `*.tmp`
artifacts. Git ignores `.deploytruth/reports/` by default. M7 does not delete old reports.

Project and environment names are converted to filesystem-safe keys before they touch the path.
`../`, absolute paths, NUL, and separator characters are rejected. Acceptance history never mixes
with production; project A never mixes with project B.

## What is stored

History stores only the serialized, schema-validated, recursively sanitized `TruthReport`:

- run identity (`runId`, ULID)
- UTC `generatedAt`
- project, environment, verdict, findings, topology
- already-redacted observations

It does **not** store provider tokens, database URLs, environment values, raw provider payloads,
HTTP bodies, browser session tokens, runtime nonces, or raw error objects.

One check execution writes exactly one historical run. `deploytruth check`, `deploytruth open`,
and the local UI rerun all use `writeLocalReport`. `--output` may copy the same report elsewhere;
that copy is not a second history entry.

If execution fails before a valid `TruthReport` exists, nothing is stored. `WARN` and `FAIL`
reports are stored — that is the point of history.

## Run identity and time

Each report has a 26-character Crockford ULID `runId`. A timestamp alone is not identity. Ordering
uses `generatedAt` (normalized UTC), never file mtime. The UI may display local time.

## Report versions

Current reports use `schemaVersion: "0.2"` and require `runId`. Known `0.1` files receive only an
additive in-memory `runId` so they can be listed; truth fields are not reinterpreted. Unknown
versions appear as **UNSUPPORTED REPORT VERSION** and are never compared as current truth. Corrupt
JSON is listed as corrupt and is never parsed into findings.

## CLI

```bash
node packages/cli/dist/index.js history --environment acceptance
node packages/cli/dist/index.js history --environment acceptance --limit 20
node packages/cli/dist/index.js diff --environment acceptance
node packages/cli/dist/index.js diff --environment acceptance --from <runId> --to <runId>
node packages/cli/dist/index.js diff --environment acceptance --from <runId> --to latest
```

`history` prints a compact table. `diff` without IDs compares the latest two usable runs. The
comparator never calls providers.

## Comparison semantics

`compareTruthReports` compares two normalized reports into a `RunComparison`:

- Verdict: `PASS → FAIL` is **REGRESSION**; `FAIL → PASS` is **RECOVERED**.
- Findings use a stable identity of **code + sorted affected component tuples** (environment,
  type, optional identifier). Array position, expected/observed values, and evidence blobs are
  not part of identity.
- Lifecycle: **NEW**, **RESOLVED**, **PERSISTING**, **CHANGED**. Same identity with a material
  change to status, severity, expected, or observed is **CHANGED** rather than NEW+RESOLVED.
- Check states derive from normalized report findings (`VERIFIED`, `WARNING`, `FAILED`,
  `UNKNOWN`, `NOT_CHECKED`).
- Identity changes cover source/deployment/runtime SHAs, runtime environment, database project
  ref, and migration counts.
- Topology compares semantic node/edge ids and health. Unchanged relationships are listed
  separately.
- Run metadata churn (`generatedAt`, `runId`, rate-limit remaining, request timestamps) is not a
  truth change.

See [ADR 008](adr/008-finding-identity-and-run-comparison.md).

## Visual history

`deploytruth open` adds a History view beside Truth Map and Report. Selecting a run can open a
read-only snapshot (same map/report/inspector, rerun replaced with **Return to latest**) or
compare to the previous run. Static `--report` mode shows **Static report mode / History
unavailable** and does not search nearby directories.

Local APIs: `GET /api/history`, `GET /api/history/:runId`, `GET /api/compare`. Run IDs resolve
only through the store. There is no deletion or mutation endpoint for history.

## Security

History is loopback-only, local, and redacted. Comparison output contains only fields already
safe in `TruthReport`. Path traversal in project, environment, or run IDs is rejected.
