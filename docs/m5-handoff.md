# M5 handoff

This handoff describes the isolated live-acceptance system established after M4. It contains no
credentials.

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

## Remaining unverified relationship

```text
Vercel runtime environment
            ?
            v
Supabase project
```

The Vercel project contains Supabase-related environment configuration, but M4 neither reads its
values nor proves that the deployed runtime uses the intended project.

M5's exact mission is to prove the runtime/configuration relationship between the deployed Vercel
environment and the intended Supabase project without serializing secret values.
