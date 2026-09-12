import {
  RuntimeTransportError,
  createRuntimeProvider,
  runtimeAttestationConfigSchema,
  runtimeAttestationV1Schema,
  type ReadOnlyTransport,
} from '@deploytruth/providers';
import { describe, expect, it } from 'vitest';

import {
  TEST_PROJECT_REF,
  TEST_RUNTIME_NONCE,
  TEST_RUNTIME_SHA,
  createFixtureRuntimeProvider,
  runtimeAttestationBody,
  runtimeConfig,
} from './runtime-test-utils.js';

const observe = (
  provider: ReturnType<typeof createFixtureRuntimeProvider>,
  config = runtimeConfig(),
) => provider.observe({ project: 'example', environment: 'production', config });

describe('runtime attestation adapter', () => {
  it('accepts a narrow config and rejects arbitrary variable-name syntax', () => {
    expect(runtimeAttestationConfigSchema.parse(runtimeConfig()).url).toContain('https://');
    expect(() =>
      runtimeAttestationConfigSchema.parse({
        url: 'https://runtime.example.test/attest',
        requiredEnvironmentVariables: ['SUPABASE_URL=value'],
      }),
    ).toThrow();
  });

  it('generates a cryptographically sized nonce and requires the exact echo', async () => {
    let observedNonce = '';
    const transport: ReadOnlyTransport = {
      get: async (request) => {
        observedNonce = new URL(request.url).searchParams.get('nonce') ?? '';
        return {
          status: 200,
          headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
          body: runtimeAttestationBody(observedNonce),
        };
      },
    };
    const provider = createRuntimeProvider({ transport });
    const observation = await provider.observe({
      project: 'example',
      environment: 'production',
      config: runtimeConfig(),
    });

    expect(observedNonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(observation.freshness).toEqual({ state: 'verified' });
  });

  it('normalizes a healthy strict v1 response without secret values', async () => {
    const observation = await observe(createFixtureRuntimeProvider());

    expect(observation).toMatchObject({
      reachable: true,
      statusCode: 200,
      availability: { state: 'available' },
      attestationVersion: 1,
      freshness: { state: 'verified' },
      cacheControlNoStore: true,
      commitSha: TEST_RUNTIME_SHA,
      environment: 'production',
      databaseConnection: {
        provider: 'supabase',
        targetProjectRef: TEST_PROJECT_REF,
        identity: 'verified',
        status: 'connected',
      },
    });
    expect(observation.environmentVariables).toEqual([
      { name: 'SUPABASE_PUBLISHABLE_KEY', present: true },
      { name: 'SUPABASE_URL', present: true },
    ]);
  });

  it('keeps the canonical URL free of the generated nonce', async () => {
    const calls: string[] = [];
    const config = runtimeConfig('https://runtime.example.test/attest?channel=stable');
    const observation = await observe(createFixtureRuntimeProvider({}, calls), config);

    expect(calls[0]).toContain(`nonce=${TEST_RUNTIME_NONCE}`);
    expect(calls[0]).toContain('channel=stable');
    expect(observation.url).toBe(config.url);
    expect(observation.url).not.toContain('nonce=');
  });

  it('marks a missing nonce as unverified freshness', async () => {
    const observation = await observe(createFixtureRuntimeProvider({ omitNonce: true }));
    expect(observation.availability?.state).toBe('available');
    expect(observation.freshness).toEqual({ state: 'unverified', reason: 'missing_nonce' });
  });

  it('marks a mismatched nonce as unverified freshness', async () => {
    const observation = await observe(createFixtureRuntimeProvider({ wrongNonce: true }));
    expect(observation.freshness).toEqual({ state: 'unverified', reason: 'nonce_mismatch' });
  });

  it('does not confuse cache policy with nonce freshness', async () => {
    const observation = await observe(
      createFixtureRuntimeProvider({ headers: { 'content-type': 'application/json' } }),
    );
    expect(observation.freshness?.state).toBe('verified');
    expect(observation.cacheControlNoStore).toBe(false);
  });

  it('rejects an unsupported future protocol version', async () => {
    const observation = await observe(
      createFixtureRuntimeProvider({ bodyOverrides: { version: 2 } }),
    );
    expect(observation.availability).toMatchObject({
      state: 'unavailable',
      reason: 'unsupported_version',
    });
    expect(observation.commitSha).toBeUndefined();
  });

  it('rejects unknown outer or nested fields and discards the whole body', async () => {
    const secret = 'sb_secret_must_never_escape';
    const outer = await observe(
      createFixtureRuntimeProvider({ bodyOverrides: { serviceRoleKey: secret } }),
    );
    const nested = await observe(
      createFixtureRuntimeProvider({
        bodyOverrides: {
          connections: {
            database: {
              provider: 'supabase',
              targetProjectRef: TEST_PROJECT_REF,
              identity: 'verified',
              status: 'connected',
              databaseUrl: secret,
            },
          },
        },
      }),
    );

    expect(outer.availability?.reason).toBe('malformed_response');
    expect(nested.availability?.reason).toBe('malformed_response');
    expect(JSON.stringify([outer, nested])).not.toContain(secret);
  });

  it('rejects a malformed runtime commit instead of comparing it', async () => {
    const observation = await observe(
      createFixtureRuntimeProvider({ bodyOverrides: { commit: 'not-a-sha' } }),
    );
    expect(observation.availability?.reason).toBe('malformed_response');
    expect(observation.commitSha).toBeUndefined();
  });

  it('allows an unavailable commit to remain unknown', async () => {
    const body = runtimeAttestationBody(TEST_RUNTIME_NONCE);
    delete body['commit'];
    const transport: ReadOnlyTransport = {
      get: async () => ({ status: 200, headers: { 'cache-control': 'no-store' }, body }),
    };
    const provider = createRuntimeProvider({
      transport,
      generateNonce: () => TEST_RUNTIME_NONCE,
    });
    const observation = await provider.observe({
      project: 'example',
      environment: 'production',
      config: runtimeConfig(),
    });
    expect(observation.availability?.state).toBe('available');
    expect(observation.commitSha).toBeUndefined();
  });

  it('keeps only manifest-required variable names in the observation', async () => {
    const secretLookingName = 'DATABASE_PASSWORD';
    const observation = await observe(
      createFixtureRuntimeProvider({
        bodyOverrides: {
          environmentVariables: {
            SUPABASE_URL: true,
            SUPABASE_PUBLISHABLE_KEY: true,
            [secretLookingName]: true,
          },
        },
      }),
      runtimeConfig(undefined, ['SUPABASE_URL']),
    );
    expect(observation.environmentVariables).toEqual([{ name: 'SUPABASE_URL', present: true }]);
    expect(JSON.stringify(observation)).not.toContain(secretLookingName);
  });

  it('normalizes non-200 responses without body evidence', async () => {
    const observation = await observe(createFixtureRuntimeProvider({ status: 503 }));
    expect(observation).toMatchObject({
      reachable: false,
      statusCode: 503,
      availability: { state: 'unavailable', reason: 'http_error' },
    });
    expect(observation.commitSha).toBeUndefined();
  });

  it.each([
    ['INSECURE_URL', 'insecure_url'],
    ['NETWORK_ERROR', 'network_error'],
    ['TIMEOUT', 'timeout'],
    ['ABORTED', 'aborted'],
    ['REDIRECT_REJECTED', 'redirect_rejected'],
    ['WRONG_CONTENT_TYPE', 'wrong_content_type'],
    ['MALFORMED_RESPONSE', 'malformed_response'],
    ['OVERSIZED_RESPONSE', 'oversized_response'],
  ] as const)('normalizes transport %s to %s', async (transportCode, reason) => {
    const observation = await observe(
      createFixtureRuntimeProvider({ error: new RuntimeTransportError(transportCode) }),
    );
    expect(observation.availability?.reason).toBe(reason);
  });

  it('strictly rejects raw URLs and key values in protocol connection fields', () => {
    expect(() =>
      runtimeAttestationV1Schema.parse({
        ...runtimeAttestationBody(TEST_RUNTIME_NONCE),
        connections: {
          database: {
            provider: 'supabase',
            targetProjectRef: TEST_PROJECT_REF,
            identity: 'verified',
            status: 'connected',
            supabaseUrl: 'https://example.supabase.co',
            publishableKey: 'sb_publishable_never-real',
          },
        },
      }),
    ).toThrow();
  });
});
