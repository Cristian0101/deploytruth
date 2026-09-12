# Live acceptance

## Purpose

The live acceptance environment is an isolated, harmless GitHub → Vercel → Supabase stack used to
dogfood DeployTruth against real provider evidence. It contains no customer data and is not a
DeployTruth backend.

## Architecture

```text
DeployTruth Repository / GitHub
          |
          | observed
          v
Vercel Live Acceptance

          ?  runtime connection truth not implemented yet

Supabase Live Acceptance
          |
          | observed independently
          v
Migration History
```

The Vercel project may hold Supabase-related environment configuration for future M5 acceptance,
but M4 does not inspect or prove that runtime relationship.

## Fixture

- App: `examples/live-acceptance`
- Safe runtime endpoint: `GET /api/version`
- Migration catalog: `examples/live-acceptance/supabase/migrations`
- Manifest: `examples/live-acceptance/deploytruth.yml`

The version endpoint returns only the Vercel-provided source commit and environment label. It does
not read the database or serialize environment configuration.

## Running DeployTruth

Build the monorepo, export the required credentials in your local shell, then run:

```bash
node packages/cli/dist/index.js doctor --config examples/live-acceptance/deploytruth.yml
node packages/cli/dist/index.js check --config examples/live-acceptance/deploytruth.yml --environment acceptance
```

Required environment variable names:

- `DEPLOYTRUTH_GITHUB_TOKEN`
- `DEPLOYTRUTH_VERCEL_TOKEN`
- `DEPLOYTRUTH_SUPABASE_ACCESS_TOKEN`
- `DEPLOYTRUTH_SUPABASE_DATABASE_URL`

Never place their values in the manifest, documentation, reports, or Git.

## Expected M4 checks

- GitHub authoritative `main` SHA is observed.
- Vercel production is READY and its source SHA matches GitHub `main`.
- The declared Supabase project is accessible.
- The PostgreSQL connection identifies the declared project.
- The committed migration versions exactly match Supabase migration history.

Runtime identity, environment-variable comparison, and the Vercel runtime → Supabase relationship
remain expected UNKNOWN/WARN evidence until M5.

## Live identities

The non-secret GitHub, Vercel, and Supabase identifiers are recorded here after isolated resources
are created and verified.
