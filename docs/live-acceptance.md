# Live acceptance

## Purpose

The live acceptance environment is an isolated, harmless GitHub → Vercel → Supabase stack used to
dogfood DeployTruth against real provider evidence. It contains no customer data and is not a
DeployTruth backend.

## Architecture

```text
DeployTruth Repository / GitHub
          |
          | source and deployment evidence
          v
Vercel Live Acceptance
          |
          | fresh public runtime attestation
          v
Runtime endpoint
          |
          | URL-derived identity + harmless GET probe
          v
Supabase Live Acceptance

Immutable Git migration catalog --> Supabase migration history
```

The two edges are intentionally separate. Vercel proves which source commit it deployed; the
runtime endpoint proves what that running application sees and whether it can reach the declared
Supabase project. M4's independent database proof remains useful but cannot substitute for either
runtime edge.

## Fixture

- App: `examples/live-acceptance`
- Runtime attestation endpoint: `GET /api/deploytruth/runtime?nonce=<fresh>`
- Compatibility endpoint retained from M4: `GET /api/version`
- Migration catalog: `examples/live-acceptance/supabase/migrations`
- Manifest: `examples/live-acceptance/deploytruth.yml`

The runtime endpoint returns protocol version 1, the exact request nonce, the Vercel-provided
source commit and environment label, presence-only booleans for the application allowlist, and a
normalized Supabase connection result. It derives the project ref from `SUPABASE_URL` and performs
one GET to `/auth/v1/settings` with `SUPABASE_PUBLISHABLE_KEY`; it discards that response body. It
never returns environment values, credentials, arbitrary environment keys, raw errors, or provider
responses.

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

If the local Node trust store does not already include Supabase's CA, download the certificate from
the acceptance project's Database settings and set `NODE_EXTRA_CA_CERTS` to that local certificate
path. Keep certificate verification enabled.

The deployed Preview and Production runtime also require `SUPABASE_URL` and
`SUPABASE_PUBLISHABLE_KEY`. Those are application runtime settings, not local DeployTruth
credentials. Never place their values in the manifest, documentation, reports, or Git.

## Expected M5 checks

- GitHub authoritative `main` SHA is observed.
- Vercel production is READY and its source SHA matches GitHub `main`.
- The declared Supabase project is accessible.
- The PostgreSQL connection identifies the declared project.
- The committed migration versions exactly match Supabase migration history.
- A fresh runtime nonce is echoed under `Cache-Control: no-store`.
- The runtime SHA exactly matches the observed Vercel deployment SHA.
- The runtime environment matches the Vercel deployment target.
- Every required runtime variable is present according to presence-only evidence.
- The runtime derives the declared Supabase ref from its actual URL and its harmless probe connects.

## Live identities

- GitHub: `Cristian0101/deploytruth`, authoritative branch `main`
- Vercel project: `deploytruth-live-acceptance`
- Vercel project ID: `prj_5BnoSZIrC6yEBrpl909trOXOqf9B`
- Vercel team scope: `cristiansa379-8787s-projects`
- Stable production domain: `deploytruth-live-acceptance.vercel.app`
- Supabase project: `deploytruth-live-acceptance`
- Supabase project ref: `wxzqzkkuozujicoywcur`
- Supabase region: `us-east-1`

These identifiers are safe to commit. Provider tokens, the database password, and the database URL
remain only in the ignored local credential file.

The Vercel Preview and Production environments are configured with `SUPABASE_URL` and
`SUPABASE_PUBLISHABLE_KEY`. `SUPABASE_PROJECT_REF` is not runtime identity evidence and the
attestation endpoint deliberately ignores it. The ref must be derived from the URL the application
actually uses.
