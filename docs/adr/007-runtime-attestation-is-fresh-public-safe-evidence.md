# ADR 007: Runtime connection truth is fresh, public-safe application evidence

## Status

Accepted

## Context

Vercel control-plane configuration can say that a project has environment variables without
proving what a currently serving deployment received or can contact. Conversely, M4 database
inspection proves which database DeployTruth inspected, not which database the application uses.

A public runtime endpoint creates a new attack and disclosure boundary. Cached responses, loose
schemas, arbitrary environment-name requests, raw provider errors, or a copied project-ref variable
could all fabricate certainty or expose secrets.

## Decision

The running application emits a strict, versioned v1 attestation after receiving a fresh 32-byte
nonce. It reports only runtime-origin commit/environment identity, application-allowlisted presence
booleans, URL-derived database project identity, and normalized connection status. The client
requires exact nonce echo, HTTPS except for local development, fail-closed redirects, a 16 KiB
limit, JSON content, and strict schemas; raw bodies and headers are discarded.

Supabase identity comes only from the actual `SUPABASE_URL`, never `SUPABASE_PROJECT_REF`. The
reference probe is GET `/auth/v1/settings` with a publishable key. It reads public Auth settings,
discards the body, and queries no application table. Secret/service-role credentials are forbidden.

Core compares the normalized observation. Provider configuration and independent M4 database
evidence are never fallback runtime evidence. Topology gains distinct deployment-to-runtime and
runtime-to-database edges.

## Consequences

- A stale response cannot certify because its nonce will not match.
- Accidental extra fields reject the whole response instead of leaking into a report.
- Environment-variable values, URLs, credentials, raw errors, and provider payloads never cross
  the attestation boundary.
- Connectivity proves only this harmless runtime request, not RLS, application access, schema, or
  migration equivalence.
- Custom Supabase URLs remain identity-unverified rather than guessed.
