# M5 handoff

This handoff describes the isolated live-acceptance system extended for M5. It contains no
credentials or runtime configuration values.

## Certified source

- Current certified main: the commit containing this document (`git rev-parse HEAD` locally or the
  authoritative `main` SHA from GitHub). A literal self-SHA cannot be embedded in its own commit.
- Pre-handoff OSS baseline: `80028b9dbc19fe44b693c947193602531026192b`

## GitHub

- Repository: `Cristian0101/deploytruth`
- Authoritative branch: `main`

## Vercel

- Project: `deploytruth-live-acceptance`
- Project ID: `prj_5BnoSZIrC6yEBrpl909trOXOqf9B`
- Team scope: `cristiansa379-8787s-projects`
- Stable domain: `deploytruth-live-acceptance.vercel.app`
- Current production deployment ID and source SHA: resolve from the stable domain during
  certification; both must match the authoritative GitHub `main` deployment recorded in the final
  certification output.

## Supabase

- Project: `deploytruth-live-acceptance`
- Project ref: `wxzqzkkuozujicoywcur`
- Region: `us-east-1`
- Migration count: 3
- Migration path: `examples/live-acceptance/supabase/migrations`

## Verified relationships

- Local Git HEAD ↔ authoritative GitHub `main`
- GitHub `main` ↔ Vercel production source SHA
- Declared Supabase project ↔ inspected database identity
- Immutable Git-tree migration catalog ↔ applied Supabase migration history
- Vercel deployment source SHA ↔ fresh runtime-attested SHA
- Vercel deployment target ↔ fresh runtime-attested environment
- Runtime allowlisted variable names ↔ presence-only evidence
- Runtime URL-derived project ref ↔ declared Supabase project
- Runtime application process ↔ harmless Supabase Auth settings GET

## Runtime proof shape

```text
Vercel deployment --> runtime attestation --> Supabase project
```

The runtime endpoint is public, versioned, nonce-bound, no-store, GET-only, and capped at 16 KiB.
It exposes only allowlisted presence booleans and normalized identity/connectivity facts. It ignores
`SUPABASE_PROJECT_REF`, derives identity from the configured URL, and uses only a publishable key.
M4's direct database connection remains an independent proof boundary and cannot satisfy M5.
