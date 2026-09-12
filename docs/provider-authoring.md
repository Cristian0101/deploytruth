# Provider authoring guide

## Adapter contract

An adapter implements `TruthProvider<TConfig, TObservation>` from `@deploytruth/providers`:

```ts
interface TruthProvider<TConfig, TObservation> {
  id: string;
  capabilities: readonly ProviderCapability[];
  validateConfig(config: unknown): TConfig;
  observe(context: ObservationContext<TConfig>): Promise<TObservation>;
  diagnose?(context: ObservationContext<TConfig>): Promise<readonly ProviderDiagnostic[]>;
}
```

`validateConfig` parses only the provider’s declared identifiers. `observe` may use the read-only
transport, but returns a normalized core observation. `diagnose` is advisory and must not determine
a verdict.

## Required implementation shape

1. Parse the small adapter configuration with Zod.
2. Fetch through `ReadOnlyTransport.get` or a wrapped read-only SDK client.
3. Translate the response inside the adapter.
4. Validate the normalized result with the relevant core schema.
5. Return it and discard raw response objects.
6. Add sanitized fixture tests before any live-client tests.

Example translation outline:

```ts
const raw = await context.transport.get({ url: endpoint });
const normalized = deploymentObservationSchema.parse({
  provider: 'vercel',
  project: config.project,
  commitSha: extractCommit(raw.body),
  connectedResources: extractDatabaseRefs(raw.body),
  environmentVariables: extractPresenceOnly(raw.body),
});
return normalized;
```

`raw` must not be added to the observation, finding, report, logger, thrown error, or fixture.

## Configuration ownership

The manifest parser owns public YAML grammar. An adapter must not expand it with arbitrary opaque
blocks. If a provider needs an identifier, add a narrow documented field to config and normalize it
to an existing domain concept where possible.

## Testing requirements

Each adapter needs:

- one healthy normalized fixture;
- one incomplete/unavailable observation fixture;
- one mismatch fixture for each rule it enables;
- configuration validation tests;
- redaction tests for provider-specific secret/error shapes;
- no live credential requirement in unit tests.

Use `createFixtureProvider` for rule tests. Live smoke tests, if added later, must be separately
gated and never run as the default unit-test suite.

## Local command-based adapters

Adapters that observe local state (the `local-git` adapter is the model) do not use
`ReadOnlyTransport`; they use a narrow injectable process runner that invokes a binary directly —
no shell, allowlisted read-only subcommands, normalized typed errors. Never interpolate manifest
values into argument lists. Raw process objects and command internals must not appear in
observations. Local remote-tracking refs are not remote-authoritative evidence; report them under
`upstream` and leave `remoteHeadSha` to remote-aware adapters (ADR 003).

## Remote-authoritative adapters

Remote source adapters (the `github` adapter is the model) produce the separate `remoteSource`
observation — never write remote fields onto the local `source` observation (ADR 004). They must
always set `availability`: `available` when authoritative fields like `remoteHeadSha` were
observed, `unavailable` with a normalized `reason` otherwise. An unavailable observation is the
correct output of a failed call; returning fabricated or partial truth is not. Credentials belong
inside the transport closure, never in adapter config or observations.

## Deployment adapters

Deployment adapters (the `vercel` adapter is the model) produce the `deployment` observation.
The same honesty rules apply, with two additions:

- "Current production" must come from the provider's routing/assignment evidence (for Vercel,
  the project's production domain aliases — ADR 005), never from "the newest deployment".
- The deployment's source commit (`commitSha`) must come from provider-recorded deployment
  metadata (for Vercel, `meta.githubCommitSha`/`gitSource.sha`), never inferred from ids, URLs,
  or timestamps. If the provider cannot prove it, leave `commitSha` unset so the report shows
  `DEPLOYMENT_SOURCE_UNVERIFIED` instead of a fabricated match.

## Database adapters

Database adapters (the `supabase` adapter is the model) produce the `database` observation and
combine two evidence sources that must stay separate:

- a **control-plane** read through the GET-only transport (does the declared project exist), and
- a **connection** read through a narrow protocol boundary (is a database reachable, and can its
  endpoint be attributed to the declared project).

The protocol boundary is an explicit interface — `SupabaseDatabaseReader` exposes
`inspectIdentity()` and `readMigrationHistory()`, never a general `query()`. Implement it with
hardcoded read-only statements inside explicit read-only transactions, inject a fake in tests,
and never place connection strings, driver errors, or SQL text on the observation. Identity must
come from deterministic evidence the endpoint itself supplies; connectivity alone is
`unverified`, never `verified`.

The expected-migration catalog is a separate provider (`git-migrations`) that reads the immutable
Git object tree via `git ls-tree`, not the working-tree filesystem. Adapters report which commit
the catalog came from (`sourceSha`); whether that commit is authoritative is a rule decision.

## Runtime attestation adapters

Runtime adapters observe a deliberately small public endpoint implemented by the deployed
application. They are not provider-control-plane adapters and must use the dedicated runtime
transport rather than the generic provider transport. The transport contract is deliberately
narrow:

- one `GET` with a fresh cryptographic nonce;
- HTTPS, except loopback HTTP for local tests;
- manual redirects, with every redirect rejected;
- `application/json` only and a 16 KiB maximum response;
- strict versioned schema parsing; and
- normalized errors that discard raw bodies, URLs, headers, and transport exceptions.

The adapter may retain only environment-variable presence booleans for names already declared by
the application manifest. It must reject or discard undeclared keys. Runtime database identity must
come from a URL-derived project identifier and a harmless application-owned connectivity probe;
deployment configuration or an independently reachable database cannot substitute for runtime
evidence. See ADR 007 and `runtime-truth.md` for the complete public contract.

## What not to do

- Do not export SDK response types.
- Do not make rule decisions inside adapters.
- Do not return `unknown`, `any`, or raw payloads across the package boundary.
- Do not add mutation-capable provider clients to the default adapter path.
- Do not use provider environment values; report only presence or a safe fingerprint.
- Do not use a provider deployment status as a substitute for topology verification.
