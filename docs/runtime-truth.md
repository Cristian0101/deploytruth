# Runtime connection truth (M5)

M5 answers whether the application Vercel is actually serving identifies as the observed
deployment and can reach the declared Supabase project through the connection configuration and
public credential available inside that running deployment. Vercel project settings alone are not
runtime evidence.

## Protocol v1

The declared `runtime.url` is requested with a fresh 32-byte cryptographic nonce:

```text
GET https://app.example.com/api/deploytruth/runtime?nonce=<base64url>
```

The runtime echoes that nonce in a small public-safe response:

```json
{
  "version": 1,
  "nonce": "<exact request nonce>",
  "commit": "<runtime Vercel source SHA>",
  "environment": "production",
  "environmentVariables": {
    "SUPABASE_URL": true,
    "SUPABASE_PUBLISHABLE_KEY": true
  },
  "connections": {
    "database": {
      "provider": "supabase",
      "targetProjectRef": "wxzqzkkuozujicoywcur",
      "identity": "verified",
      "status": "connected"
    }
  }
}
```

The outer response and every nested object are strict. Unknown properties, malformed SHAs,
unsupported versions, non-JSON responses, redirects, and bodies above 16 KiB reject the entire
attestation. A rejected raw body is discarded and never becomes an observation, error, report, or
log. Future protocol versions are not interpreted as v1.

The endpoint returns `Cache-Control: no-store` and `Pragma: no-cache`. Cache policy is useful
defense in depth; exact nonce echo is the freshness proof. A missing or mismatched nonce leaves
runtime coverage unsatisfied and no stale SHA, environment, variable, or connection claim is used
for certification.

## Transport

Runtime inspection is GET-only. HTTPS is mandatory except for `localhost` and `127.0.0.1` local
development URLs. URLs containing credentials are rejected. Redirects are not followed. Requests
have a timeout, response bytes are bounded while streaming, and only `content-type`,
`cache-control`, and `pragma` are retained long enough to normalize safe status. Raw response
headers and bodies never enter core.

## Runtime identity and environment

The reference Vercel function reads `VERCEL_GIT_COMMIT_SHA` and `VERCEL_ENV` inside the running
deployment. It never copies commit identity from the manifest, GitHub, a query parameter, or the
Vercel control plane.

Core compares `deployment.commitSha` with `runtime.commitSha`. A fresh mismatch is
`RUNTIME_SHA_MISMATCH` (FAIL). Runtime environment is compared with the deployment target
(`production` or `preview`), not with the logical manifest environment id. A logical environment
called `acceptance` may correctly observe a Vercel `production` runtime.

## Presence-only variables

The application defines the variable allowlist; request callers cannot supply variable names.
The client further retains only names declared in `required_environment_variables`. Values are
never transmitted, hashed, compared, logged, or serialized.

- Explicit `true` satisfies presence for that required name.
- Explicit `false` produces `RUNTIME_REQUIRED_ENV_MISSING` (FAIL).
- Omitted evidence is unknown and leaves coverage unsatisfied; omission is not interpreted as
  absence.

The reference endpoint allows `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. It deliberately does
not use or report a service-role, secret, database-password, or Management API credential.

## Supabase target identity

The target project ref is derived from the actual `SUPABASE_URL` host using the documented hosted
shape `https://<project-ref>.supabase.co`. `SUPABASE_PROJECT_REF` is not consulted: a separate
identity variable could disagree with the URL the application really uses. Custom, proxy, or
unrecognized URLs remain identity-unverified even if reachable.

The URL itself never crosses the attestation boundary. Only the derived project ref and normalized
identity state do.

## Read-only connection probe

The reference endpoint sends:

```text
GET <SUPABASE_ORIGIN>/auth/v1/settings
apikey: <publishable key>
```

Supabase documents this as the public Auth settings read. It uses the current publishable key,
touches no application table or customer row, and discards the response body. This replaces the
initial `/rest/v1/` root idea: Supabase removed public-key access to the OpenAPI root in 2026, so
that route no longer provides a stable public-key connectivity proof. See the
[API key guide](https://supabase.com/docs/guides/getting-started/api-keys), the documented
[Auth settings request](https://supabase.com/docs/guides/self-hosting/self-hosted-oauth), and the
[OpenAPI access change](https://supabase.com/changelog/42949-breaking-change-removing-access-to-openapi-spec-via-the-anon-key).

A successful probe proves that the running application could reach the derived Supabase origin
and that the gateway accepted its publishable credential for this harmless read. It does not prove
application-table access, user authentication, RLS correctness, schema equivalence, or migration
history. M4 observes database identity and migration history independently.

## Findings and coverage

| Finding                                    | Condition                                                        | Result |
| ------------------------------------------ | ---------------------------------------------------------------- | ------ |
| `RUNTIME_ATTESTATION_UNAVAILABLE`          | Endpoint/transport/strict response unavailable                   | WARN   |
| `RUNTIME_ATTESTATION_FRESHNESS_UNVERIFIED` | Nonce absent or mismatched                                       | WARN   |
| `RUNTIME_SHA_MISMATCH`                     | Fresh runtime SHA differs from deployment SHA                    | FAIL   |
| `RUNTIME_ENVIRONMENT_MISMATCH`             | Fresh runtime environment differs from deployment target         | FAIL   |
| `RUNTIME_REQUIRED_ENV_MISSING`             | Required variable explicitly attested false                      | FAIL   |
| `RUNTIME_DATABASE_PROJECT_MISMATCH`        | URL-derived runtime project differs from the declared project    | FAIL   |
| `RUNTIME_DATABASE_IDENTITY_UNVERIFIED`     | Runtime target cannot be safely tied to a project ref            | WARN   |
| `RUNTIME_DATABASE_CONNECTION_UNAVAILABLE`  | Target identity is established but the harmless GET probe failed | WARN   |

`runtime_identity` requires fresh attestation plus matching deployment/runtime SHAs.
`environment_variables` requires explicit true presence for every applicable required name.
`environment_isolation` requires a matching runtime/deployment environment and, when a database is
declared, matching URL-derived project identity plus a connected probe. Independent M4 evidence
never substitutes for this runtime edge.

## Topology

Fresh matching evidence produces distinct edges:

```text
GitHub -> Vercel -> Runtime -> Supabase -> Migration History
```

Vercel-to-Runtime is observed only when nonce freshness and SHA identity are verified.
Runtime-to-Supabase is observed only when the URL-derived target matches and the read-only probe is
connected. Core produces these edges; the UI only renders them.

## Limitations

- Hosted Supabase URL identity is supported; custom domains remain unverified.
- The probe is service connectivity, not table or schema truth.
- Preview acceptance uses the preview URL directly; the canonical manifest keeps the production
  endpoint and never commits an ephemeral preview URL.
- The endpoint is intentionally public, so every returned field must remain safe for disclosure.
