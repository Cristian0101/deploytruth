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

## Local UI and storage

The Vite development server is explicitly bound to `127.0.0.1`. Local reports are written only to
the invoking project’s `.deploytruth/reports/` directory. Default report files are ignored by Git.
Telemetry is not implemented and must remain opt-in if it is ever proposed.

## Adapter review checklist

- Does it use only read-only API operations?
- Are raw responses discarded before return?
- Could an error contain an authorization header or URL credentials?
- Does the normalized observation use presence/fingerprint rather than a secret value?
- Are fixtures fabricated and sanitized?
- Do tests exercise serialized output for secret leakage?
- Does it avoid writes to provider state, local Git state, or data records?
