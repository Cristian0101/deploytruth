# Supabase database and migration truth (M4)

M4 answers three independent questions: **does the declared Supabase project exist**, **can the
observed PostgreSQL connection be proven to be that project**, and **does its applied migration
history match the authoritative source tree**. Each question has its own evidence source, and a
strong answer to one never substitutes for a weak answer to another.

## The three evidence sources

| Question                | Evidence source                                           | Normalized field                          |
| ----------------------- | --------------------------------------------------------- | ----------------------------------------- |
| Project existence       | `GET /v1/projects/{ref}` on the Management API            | `database.controlPlane`                   |
| Connection reachability | A read-only PostgreSQL session against the configured URL | `database.connection`                     |
| Database identity       | The project ref encoded in the connection endpoint itself | `database.observedProjectRef`, `identity` |
| Expected migrations     | The immutable Git object tree at the authoritative commit | `repositoryMigrations`                    |
| Applied migrations      | `supabase_migrations.schema_migrations` (versions only)   | `database.appliedMigrationIds`            |

## Project truth: the control plane

`packages/providers/src/supabase/` implements a read-only adapter over the Supabase Management
API. It issues exactly one request — `GET /v1/projects/{projectRef}` — through the shared GET-only
transport, and normalizes the response to `{state, reason?, projectName?, region?, status?}`.
Supabase status strings map onto a small provider-neutral set (`healthy`, `degraded`,
`transitioning`, `inactive`, `failed`, `removed`, `unknown`).

Every failure mode becomes `unavailable` evidence with a fixed `reason`: `missing_credentials`,
`unauthorized`, `forbidden`, `not_found_or_inaccessible`, `rate_limited`, `server_error`,
`unexpected_status`, `malformed_response`, `network_error`, `timeout`, `aborted`. The Management
API returns `404` for absent projects _and_ for projects the token cannot see, so
`not_found_or_inaccessible` never claims the project does not exist. A `200` body that does not
carry the requested `ref` is `malformed_response` — the adapter never guesses a project.

## Database identity: connectivity is not identity

A successful PostgreSQL connection proves only that _a_ database answered. DeployTruth derives
project identity deterministically from the endpoint itself:

- **Direct / dedicated pooler** — host `db.<ref>.supabase.co` (port `5432` direct, `6543`
  dedicated pooler) yields `identitySource: 'direct_host'`.
- **Shared pooler (Supavisor)** — host `*.pooler.supabase.com` yields the project ref from the
  username suffix `<user>.<ref>` (documented routing mechanism), `identitySource:
'pooler_username'`.

Any other endpoint shape — custom domains, proxies, self-hosted endpoints, malformed URLs —
produces `identity: 'unverified'`. `observedProjectRef` is only ever a value recovered from the
endpoint; it is never asserted by connectivity, assumed from the declaration, or copied from
control-plane metadata.

The comparison is exact: `observed === declared` gives `identity: 'verified'`, a different value
gives `'mismatch'` (which fails with `WRONG_DATABASE_PROJECT`), and no derivable ref gives
`'unverified'` (which warns with `DATABASE_IDENTITY_UNVERIFIED`). Migration comparison is gated on
`verified` — applied history of an unidentified database is never certified, though it may still
be displayed as diagnostic evidence.

## Migration source truth: the committed tree, not the filesystem

Expected migration versions are never read from the working tree. `packages/providers/src/git/
migrations.ts` resolves the repository root and `HEAD` via `rev-parse`, then lists the declared
migration directory inside the immutable object tree via `git ls-tree <sha> <dir>` and
`git ls-tree <sha> <dir>/` — the only new allowlisted invocation. Dirty or untracked files in the
working tree cannot enter expected truth.

The catalog records `sourceSha` — the commit it was read from. When a remote source is declared
(ADR 004), the tree is authoritative only while `catalog.sourceSha === remoteSource.remoteHeadSha`;
a diverged or unobserved remote produces `MIGRATION_SOURCE_UNAVAILABLE`, not a silent local
fallback. When no remote source is declared, the committed local tree is the source authority.

The filename grammar mirrors the Supabase CLI (`^([0-9]+|r)_(.*)\.sql$`): the version is the
leading timestamp, `r_<name>.sql` files are repeatable migrations versioned `r_<name>`, and the
legacy first-entry `<timestamp>_init.sql` skip is honored. Non-`.sql` entries are ignored; a
`.sql` file that fails the grammar is reported (`invalid_filenames`) rather than silently skipped.
Duplicate versions and a missing or non-directory path make the catalog `invalid`
(`MIGRATION_SOURCE_INVALID`).

## Applied migration truth: the history table is metadata

Applied versions come from `supabase_migrations.schema_migrations` — and only its `version`
column; the `statements` payload is never read. A missing history table (`42P01`) is
`history_table_missing`, **not** zero applied migrations: the table's absence means the history
is unknown, and `DATABASE_MIGRATION_HISTORY_UNAVAILABLE` says so. A genuinely empty history is a
distinct, comparable fact.

Matching migration history is not schema equivalence. Supabase's `repair`/`squash` workflows edit
history without changing the schema, so DeployTruth reports _history_ agreement and never claims
the database schema itself is correct.

## Read-only guarantees

The database boundary is `SupabaseDatabaseReader` with two methods — `inspectIdentity()` and
`readMigrationHistory()`. There is no `query(sql)` surface, so manifest data, CLI flags, and rules
cannot reach arbitrary SQL. The implementation issues exactly three statements:

```sql
START TRANSACTION READ ONLY;
SELECT version FROM supabase_migrations.schema_migrations ORDER BY version ASC;
ROLLBACK;
```

plus `SELECT current_database()` as a connectivity probe inside the same pattern. Read-only is
enforced three ways: the `pg` startup `options` sets `default_transaction_read_only=on` (with
`statement_timeout` and `idle_in_transaction_session_timeout` bounds), each read runs inside an
explicit `READ ONLY` transaction, and every block ends in `ROLLBACK` — never `COMMIT`. A boundary
test rejects any write-capable statement keyword appearing in the file at all.

Driver errors normalize to fixed reasons (`authentication_failed`, `connection_failed`,
`tls_error`, `timeout`, `invalid_url`, `database_unavailable`); raw SQLSTATE payloads and driver
messages never cross the boundary.

## Configuration

```yaml
database:
  provider: supabase
  project_ref: prodabc123
  migrations:
    directory: supabase/migrations # default when omitted
```

`project_ref` must match `^[a-z0-9]{6,64}$` — hosted refs are 20 lowercase alphanumeric
characters; the grammar stays permissive inside that identifier space rather than pinning a
length Supabase does not publish as fixed. `migrations.directory` must be a repository-relative
path of safe segments — absolute paths, `..` traversal, and odd separators are rejected.

## Authentication

| Variable                            | Purpose                                             |
| ----------------------------------- | --------------------------------------------------- |
| `DEPLOYTRUTH_SUPABASE_ACCESS_TOKEN` | Management API token (preferred)                    |
| `SUPABASE_ACCESS_TOKEN`             | Management API token (fallback)                     |
| `DEPLOYTRUTH_SUPABASE_DATABASE_URL` | PostgreSQL connection string for identity + history |

The Management API credential is a personal access token — project `anon`/`service_role` keys are
data-plane credentials and are not accepted. The database URL is only read from the explicit
DeployTruth variable: a generic `DATABASE_URL` is deliberately never a fallback, because it could
silently point the inspector at an unrelated database. Both credentials live inside the
transport/reader closures; only the variable _name_ ever surfaces in diagnostics.

## Rules

| Code                                     | Condition                                                                     | Severity / status |
| ---------------------------------------- | ----------------------------------------------------------------------------- | ----------------- |
| `SUPABASE_PROJECT_UNAVAILABLE`           | Control-plane project lookup failed                                           | WARNING / WARN    |
| `DATABASE_CONNECTION_UNAVAILABLE`        | No usable DB credential or the session failed                                 | WARNING / WARN    |
| `DATABASE_IDENTITY_UNVERIFIED`           | Connected, but the endpoint exposes no project ref                            | WARNING / WARN    |
| `WRONG_DATABASE_PROJECT`                 | Observed connection identity ≠ declared ref (or deployment-reported mismatch) | HIGH / FAIL       |
| `MIGRATION_SOURCE_UNAVAILABLE`           | Catalog unreadable, or local tree is not the authoritative SHA                | WARNING / WARN    |
| `MIGRATION_SOURCE_INVALID`               | Catalog exists but is not a valid migration set                               | WARNING / WARN    |
| `DATABASE_MIGRATION_HISTORY_UNAVAILABLE` | History table missing/unreadable; never "zero migrations"                     | WARNING / WARN    |
| `DATABASE_MIGRATIONS_BEHIND`             | Expected versions missing from applied history                                | HIGH / FAIL       |
| `DATABASE_MIGRATION_DRIFT`               | Applied versions absent from the expected source                              | WARNING / WARN    |

Comparison is certified only when the catalog is authoritative, identity is `verified`, and
history is `available`. The `migrations` check coverage requires the same chain, so a broken link
cannot produce a false `PASS` — it degrades to `REQUIRED_OBSERVATION_UNAVAILABLE` plus the
specific finding above.

## Topology semantics

A declared database produces a `database` node whose metadata carries `identity` and
`migrationHistory`. The `deployment → database` edge is `expected: true` (it is declared) but
`observed: false` — M4 proves which database the **inspection** connects to, not which database
the **deployment** connects to. A verified `Vercel → Supabase` connection would require
deployment-side evidence (e.g. environment-variable inspection), which is out of scope; the edge
is reported as declared/unverified rather than fabricating certainty.

## Limitations

- Identity trusts the documented endpoint encodings. A hostile or exotic endpoint can hide or
  fake nothing — it can only fail to yield a ref, which produces `unverified`, not a wrong claim.
- `rejectUnauthorized: false` is the default TLS posture when the URL carries no `sslmode`
  directive (Supabase's direct-host CA is not a public root); add `sslmode=verify-full` (plus
  `sslrootcert` where required) to the URL for verified TLS.
- Repeatable-migration versions (`r_name`) compare as strings, matching the CLI.
- Pooler session vs transaction mode is not distinguished — both carry the same identity claim.
- If a pooler or proxy rejects the read-only startup `options`, the read fails closed
  (`unavailable` evidence), never silently.

## Example

```text
DATABASE
  Supabase
    Declared project    prodabc123
    Project access      AVAILABLE (meridia-prod · us-east-1 · healthy)
    Connection          AVAILABLE (identity via direct_host)
    Database identity   VERIFIED — prodabc123
    Migration source    Git a1b2c3d (supabase/migrations)
    Expected migrations 12
    Applied migrations  12
  Database truth         MIGRATIONS VERIFIED — 12 applied migration(s) match supabase/migrations
```
