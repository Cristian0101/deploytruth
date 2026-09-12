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

## Runtime attestation boundary

The public M5 endpoint accepts only GET and a bounded nonce. It returns a strict versioned object
containing runtime-origin commit/environment, explicit allowlisted presence booleans, a project ref
derived from the actual connection URL, and normalized connection status. It never returns the URL,
key, password, token, certificate, raw provider response, raw fetch error, arbitrary environment
state, or user data. `Object.entries(process.env)` and equivalent environment dumps are forbidden.

The client generates 32 random bytes, requires exact nonce echo, and never weakens freshness on a
retry. Runtime transport requires HTTPS outside localhost, refuses credential-bearing URLs and
redirects, times out, accepts JSON only, and stops reading after 16 KiB. It retains only three safe
headers and discards rejected bodies. The Supabase probe uses GET `/auth/v1/settings` with a
publishable key and discards its body; service-role, secret, database, and Management credentials
are never used. See `docs/runtime-truth.md` and ADR 007.

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

The session is TLS-authenticated or it does not happen. Because `pg-connection-string` lets URL
parameters override explicit client options — several of which disable peer verification — the
reader strips every `ssl*` directive and `uselibpqcompat` from the connection string and sets
`ssl: { rejectUnauthorized: true }` itself: certificate chain and hostname are always verified
against the Node trust store (`verify-full`-equivalent). A missing `sslmode` therefore means
verified TLS, and any directive that could produce plaintext or unverified TLS — the `disable`,
`allow`, `prefer`, or `no-verify` sslmodes, unknown values, `uselibpqcompat`, or URL-borne
certificate material — fails closed as `insecure_tls_configuration` before a connection is
attempted. Custom CAs come from `NODE_EXTRA_CA_CERTS`; certificate contents are never read from
the URL and never accepted through `deploytruth.yml`. There is no insecure fallback and no
opt-out.

Connection identity is reported honestly: `connection.targetProjectRef` records which project
the endpoint-derived URL _targets_ (configuration evidence, present even on failure), while
`observedProjectRef` is emitted only after a verified session succeeded — a failed or refused
connection never fabricates an observed database identity.

## Local UI and storage

The Vite development server is explicitly bound to `127.0.0.1`. Local reports are written only to
the invoking project’s `.deploytruth/reports/` directory, namespaced by sanitized project and
environment keys. Default report files are ignored by Git. Telemetry is not implemented and must
remain opt-in if it is ever proposed.

History stores only serialized, redacted `TruthReport` JSON. Run IDs are ULIDs resolved through
the report store; they never map to arbitrary filesystem paths. `../`, absolute paths, NUL, and
separator abuse in project or environment names are rejected. Comparison output contains only
fields already safe in `TruthReport` and cannot recover redacted values. The local server exposes
read-only history and comparison endpoints; there is no deletion, mutation, or shell endpoint for
history. Static `--report` mode does not search nearby directories for history. See
`docs/report-history.md`.

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
- Does a runtime adapter require nonce freshness, strict bounded parsing, and value-free presence?
