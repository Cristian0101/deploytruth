# DeployTruth security model

## Non-negotiable properties

DeployTruth is local-first and read-only. It must never deploy, delete, apply migrations, update
provider configuration, change environment variables, rotate credentials, or write database
records. The foundation has no mutation code.

Provider adapters receive a `ReadOnlyTransport` exposing `get()` only. This prevents accidental
write methods from entering adapter code through the standard contract. Later adapters must use
provider tokens with the narrowest available read-only scopes.

## Secret boundaries

Secrets are prohibited from:

- `deploytruth.yml`
- normalized observations
- fixture files
- findings and topology metadata
- JSON reports and local report files
- terminal output and error details
- browser viewer data

Variable observations are limited to a name, `present` boolean, and optional short SHA-256
fingerprint. They never include a value. When comparison is necessary, adapters calculate the
fingerprint in memory and discard the original value.

## Defense in depth

1. Provider adapters translate raw data to narrow normalized observations and discard raw data.
2. Core models offer no slot for raw payloads.
3. CLI configuration errors are redacted before printing.
4. `serializeTruthReport` validates then recursively sanitizes its final report boundary.
5. Sanitization redacts sensitive key names and common token, JWT, bearer token, assignment, and
   URL-credential formats.
6. Tests prove representative secret strings do not survive report serialization.

Redaction is a final safety net, not permission to collect secret values. Adapter authors must not
place opaque token-like values in supposedly harmless fields. New adapter work needs negative
tests for every token or payload shape it handles.

## Runtime endpoint requirements

The optional version endpoint should return only commit, environment, and build time. It should use
the application’s normal routing policy, avoid verbose errors, and never return configuration,
connection strings, provider IDs, or user data.

## Local Git execution

Local Git observation runs through `GitRunner`, which invokes the `git` executable via `execFile`
with `shell: false` — arguments are arrays, never interpolated strings, and manifest data is never
used to build command lines. An allowlist (`assertReadOnlyGitInvocation`) restricts invocations to
`version`, `rev-parse`, `rev-list`, `status` (safe flags), bare `remote`, `config --get`, read-form
`symbolic-ref`, `worktree list`, and `ls-tree <rev> <path>` (immutable tree reads for the
migration catalog — revisions limited to `HEAD`/`@`/hex object ids, paths limited to safe
repository-relative segments). Mutating subcommands (`fetch`, `push`, `reset`, `checkout`,
`update-ref`, `config` writes, …) and git-level flags that redirect the repository (`-c`,
`--git-dir`, `-C`, …) are rejected before spawn.

`GIT_OPTIONAL_LOCKS=0` keeps `status` from writing the index; `GIT_DIR`-style environment overrides
are stripped; `LC_ALL=C` makes diagnostics deterministic. Observations carry repository-relative
file paths (capped; counts stay exact), never file contents. Repository root and Git directory
paths are intentionally absolute — they are the identity of the observation in a local-first
report that never leaves `.deploytruth/reports/` unless the user copies it.

## GitHub API access

The GitHub adapter reaches `api.github.com` through `createGitHubTransport`, a `ReadOnlyTransport`
implementation that issues `GET` requests only — the contract type exposes no other verb and the
implementation contains none. Remote URLs are never inspected; repository identity comes solely
from the manifest's `owner/repo` declaration.

Tokens resolve from `DEPLOYTRUTH_GITHUB_TOKEN` then `GITHUB_TOKEN` at observation time, are held
inside the transport closure, and become an `Authorization` header on the wire only. They are
never stored, serialized, logged, placed on an observation, included in errors, or present in
fixtures. `doctor` reports `available`/`none` plus the variable _name_ — never the value.
Unauthenticated access is valid for public repositories; a private repository without a usable
token produces `unavailable` evidence, not fabricated truth.

Error normalization never echoes request internals: status codes map to fixed `reason` strings
(`not_found`, `unauthorized`, `forbidden`, `rate_limited`, `server_error`, `unexpected_status`,
`malformed_response`, `network_error`, `timeout`, `aborted`) with fixed detail text. Rate-limit
metadata is limited to `limit`, `remaining`, `resetAt`, and `retryAfter` — raw response headers
are never copied into observations.

## Vercel API access

The Vercel adapter reaches `api.vercel.com` through `createVercelTransport`, built on the same
GET-only `createReadOnlyFetchTransport` — the contract type exposes no other verb and no
mutation-capable Vercel code exists in the runtime path. Project identity is declared in the
manifest (`project`, optional `scope`, optional `domain`); nothing is inferred from Git remotes.

Tokens resolve from `DEPLOYTRUTH_VERCEL_TOKEN` then `VERCEL_TOKEN` at observation time, are held
inside the transport closure, and become an `Authorization` header on the wire only. Vercel
exposes no anonymous project truth: without a credential the adapter returns `unavailable`
(`missing_credentials`) evidence, never a guess. `doctor` reports `available`/`none` plus the
variable _name_ — never the value.

The adapter requests project metadata and the current production deployment only. It never reads
deployment environment-variable values, build logs, or source files; if such fields are
incidentally present in a response they are dropped during normalization (tests assert
sentinel-shaped env material never survives). Error normalization mirrors the GitHub model plus
`missing_credentials`, `deployment_unavailable`, and `ambiguous` — divergent production aliases
are reported as normalized domain→deployment evidence, never resolved by guessing — and adds
the `retryAfter` seconds hint.

## Supabase API and database access

The Supabase adapter reaches `api.supabase.com` through `createSupabaseTransport`, built on the
same GET-only `createReadOnlyFetchTransport`. It issues exactly one Management API call —
`GET /v1/projects/{ref}` — and picks `ref`, `name`, `region`, and `status` from the response;
everything else is discarded inside the adapter.

Management tokens resolve from `DEPLOYTRUTH_SUPABASE_ACCESS_TOKEN` then `SUPABASE_ACCESS_TOKEN`,
are held inside the transport closure, and become an `Authorization` header on the wire only.
Project `anon`/`service_role` keys are data-plane credentials and are not accepted for the
control plane.

The PostgreSQL boundary is `SupabaseDatabaseReader` — two methods (`inspectIdentity`,
`readMigrationHistory`), no general `query()` surface. The connection string resolves only from
`DEPLOYTRUTH_SUPABASE_DATABASE_URL`; a generic `DATABASE_URL` is deliberately never a fallback
because it could silently target an unrelated database. The reader issues hardcoded read-only
statements inside `START TRANSACTION READ ONLY` … `ROLLBACK` blocks, additionally requests
`default_transaction_read_only` at startup, and never queries application tables, writes, or
repairs history. Driver and network errors normalize to fixed reasons; raw messages, the URL,
and its credentials never appear in observations, diagnostics, findings, or reports.

## Local UI and storage

The Vite development server is explicitly bound to `127.0.0.1`. Local reports are written only to
the invoking project’s `.deploytruth/reports/` directory. Default report files are ignored by Git.
Telemetry is not implemented and must remain opt-in if it is ever proposed.

## Adapter review checklist

- Does it use only read-only API operations?
- Are raw responses discarded before return?
- Does the transport expose `get()` only, with no mutation verb anywhere in the runtime path?
- Are credentials resolved from the environment and held outside the adapter entirely?
- Could an error contain an authorization header or URL credentials?
- Does the normalized observation use presence/fingerprint rather than a secret value?
- Are fixtures fabricated and sanitized?
- Do tests exercise serialized output for secret leakage?
- Does it avoid writes to provider state, local Git state, or data records?
