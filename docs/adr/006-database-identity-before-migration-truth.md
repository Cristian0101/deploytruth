# ADR 006: Database identity before migration truth, from an immutable source tree

## Status

Accepted

## Context

M4 adds Supabase database and migration truth: "what project did I declare, what database did I
actually inspect, and does its applied migration history match the authoritative source?" Three
failure modes tempt a naive implementation:

1. **Connectivity masquerading as identity.** A PostgreSQL session that connects proves only that
   _some_ database answered. Asserting the declared project on that evidence alone would certify
   migrations against the wrong database whenever a stale or mistyped URL is configured.
2. **The dirty filesystem masquerading as the source.** Reading `supabase/migrations/` from disk
   picks up uncommitted and untracked files — expected truth would then depend on what happens to
   be lying in the checkout, not what the declared source says.
3. **History metadata masquerading as schema state.** Supabase `repair`/`squash` workflows rewrite
   `supabase_migrations.schema_migrations` without touching the schema, so the table is a claim
   about _applied versions_, never about schema equivalence.

## Decision

### Identity is derived, never assumed

`deriveProjectIdentity` extracts the project ref only from documented endpoint encodings:
`db.<ref>.supabase.co` (direct and dedicated pooler) and `*.pooler.supabase.com` usernames
(`<user>.<ref>`). Every other shape yields `identity: 'unverified'`. The control-plane project
record, the declared ref, and the derived `observedProjectRef` remain three separate fields —
success in one never rescues another. Only `verified` identity gates migration comparison; a
`mismatch` is `WRONG_DATABASE_PROJECT` (FAIL) and unreachable or unverifiable is WARN.

### Expected truth comes from the object tree

The catalog is read with `git ls-tree <sha>` — a new, narrowly allowlisted read — so expected
migrations are exactly what the authoritative commit contains. `catalog.sourceSha` records which
commit that was. When a remote source is declared, the catalog is authoritative only while
`sourceSha === remoteSource.remoteHeadSha` (ADR 004); a diverged or unobserved remote yields
`MIGRATION_SOURCE_UNAVAILABLE`, never a local fallback. Filenames follow the Supabase CLI grammar
(`<digits>_<name>.sql`, `r_<name>.sql` → version `r_<name>`, legacy first-entry `_init` skip);
uninterpretable `.sql` files, duplicate versions, and a missing directory are `invalid`
evidence, not silent omissions.

### The history read is structurally read-only

`SupabaseDatabaseReader` exposes `inspectIdentity()` and `readMigrationHistory()` — no general
`query()` exists for callers to misuse. The implementation runs only hardcoded statements inside
`START TRANSACTION READ ONLY` … `ROLLBACK`, with `default_transaction_read_only` also requested
at connection startup. Only the `version` column is read. A missing history table is
`unavailable` evidence, explicitly _not_ "zero migrations".

### The runtime edge stays unverified

The `deployment → database` topology edge is `expected` (declared) but never `observed` in M4.
Verifying which database a Vercel deployment actually talks to requires deployment-side evidence
DeployTruth does not collect yet; the edge is reported as declared/unverified rather than
fabricated.

## Consequences

- `MIGRATIONS VERIFIED` requires the full chain: authoritative source tree, reachable connection,
  proven identity, readable history, exact set equality. Any broken link is a named WARN — never
  a PASS, never a guessed comparison.
- A "wrong project" configuration fails even when its migration history happens to match, because
  identity is checked before sets are compared.
- Dirty working trees cannot create phantom expected migrations; `DIRTY_WORKTREE` still reports
  the local fact separately.
- A paused or removed project keeps its control-plane evidence honest (`SUPABASE_PROJECT_UNAVAILABLE`)
  without contaminating the connection result.
- Future runtime/environment inspection (M5+) can upgrade the topology edge to `observed` when it
  has deployment-side proof — M4 deliberately leaves it false.
