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

## What not to do

- Do not export SDK response types.
- Do not make rule decisions inside adapters.
- Do not return `unknown`, `any`, or raw payloads across the package boundary.
- Do not add mutation-capable provider clients to the default adapter path.
- Do not use provider environment values; report only presence or a safe fingerprint.
- Do not use a provider deployment status as a substitute for topology verification.
