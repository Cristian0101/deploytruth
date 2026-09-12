import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { databaseObservationSchema, type DatabaseObservation } from '@deploytruth/core';
import {
  TransportError,
  createSupabaseProvider,
  type SupabaseDatabaseConfig,
} from '@deploytruth/providers';
import { describe, expect, it, vi } from 'vitest';

import { createFakeDatabaseReader, createStubTransport } from './supabase-test-utils.js';

const REF = 'prodabc123';
const OTHER_REF = 'otherproject99';

const projectPayload = {
  ref: REF,
  name: 'meridia-prod',
  region: 'us-east-1',
  status: 'ACTIVE_HEALTHY',
  database: { host: `db.${REF}.supabase.co` },
  organization_slug: 'acme',
};

const observe = (
  provider: ReturnType<typeof createSupabaseProvider>,
  projectRef = REF,
): Promise<DatabaseObservation> =>
  provider.observe({
    project: 'meridia',
    environment: 'production',
    config: provider.validateConfig({ projectRef }) as SupabaseDatabaseConfig,
  });

const providerWith = (options: Parameters<typeof createSupabaseProvider>[0] = {}) =>
  createSupabaseProvider({
    env: {
      DEPLOYTRUTH_SUPABASE_ACCESS_TOKEN: 'fixture-token',
      DEPLOYTRUTH_SUPABASE_DATABASE_URL: `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`,
    },
    ...options,
  });

describe('Supabase Management API observation', () => {
  it('observes project identity and database metadata through the control plane', async () => {
    const provider = providerWith({
      transport: createStubTransport([
        { match: `/v1/projects/${REF}`, status: 200, body: projectPayload },
      ]),
      databaseReaderFactory: () => createFakeDatabaseReader({}),
    });

    const observation = await observe(provider);

    expect(observation.provider).toBe('supabase');
    expect(observation.projectRef).toBe(REF);
    expect(observation.controlPlane?.state).toBe('available');
    expect(observation.controlPlane?.projectName).toBe('meridia-prod');
    expect(observation.controlPlane?.region).toBe('us-east-1');
    expect(observation.controlPlane?.status).toBe('healthy');
  });

  it('reports missing management credentials without attempting a request', async () => {
    let requested = false;
    const fetchSpy = vi.fn(async () => {
      requested = true;
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const provider = createSupabaseProvider({
      env: { DEPLOYTRUTH_SUPABASE_DATABASE_URL: 'postgresql://postgres:pw@x.supabase.co/postgres' },
      databaseReaderFactory: () => createFakeDatabaseReader({}),
    });

    const observation = await observe(provider);

    expect(requested).toBe(false);
    expect(observation.controlPlane).toMatchObject({
      state: 'unavailable',
      reason: 'missing_credentials',
    });
    vi.unstubAllGlobals();
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found_or_inaccessible'],
    [429, 'rate_limited'],
    [500, 'server_error'],
    [503, 'server_error'],
    [418, 'unexpected_status'],
  ] as const)('maps HTTP %i to %s', async (status, reason) => {
    const provider = providerWith({
      transport: createStubTransport([{ match: '/v1/projects/', status, body: {} }]),
      databaseReaderFactory: () => createFakeDatabaseReader({}),
    });

    const observation = await observe(provider);

    expect(observation.controlPlane?.state).toBe('unavailable');
    expect(observation.controlPlane?.reason).toBe(reason);
  });

  it('captures rate-limit headers as normalized evidence', async () => {
    const provider = providerWith({
      transport: createStubTransport([
        {
          match: '/v1/projects/',
          status: 429,
          body: {},
          headers: {
            'x-ratelimit-limit': '100',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '1700000000',
          },
        },
      ]),
      databaseReaderFactory: () => createFakeDatabaseReader({}),
    });

    const observation = await observe(provider);

    expect(observation.controlPlane?.rateLimit).toMatchObject({
      limit: 100,
      remaining: 0,
      resetAt: '2023-11-14T22:13:20.000Z',
    });
  });

  it('maps transport failures to normalized reasons', async () => {
    const provider = providerWith({
      transport: {
        get: async () => {
          throw new TransportError('NETWORK_ERROR', 'boom');
        },
      },
      databaseReaderFactory: () => createFakeDatabaseReader({}),
    });

    const observation = await observe(provider);

    expect(observation.controlPlane).toMatchObject({
      state: 'unavailable',
      reason: 'network_error',
    });
  });

  it('maps transport timeouts to the timeout reason', async () => {
    const provider = providerWith({
      transport: {
        get: async () => {
          throw new TransportError('TIMEOUT', 'boom');
        },
      },
      databaseReaderFactory: () => createFakeDatabaseReader({}),
    });

    const observation = await observe(provider);

    expect(observation.controlPlane?.reason).toBe('timeout');
  });

  it.each([
    ['a payload with no ref', { name: 'meridia-prod' }],
    ['a payload with a different ref', { ...projectPayload, ref: 'differentref99' }],
    ['a non-object payload', 'not-a-project'],
  ] as const)('treats %s as malformed rather than guessing identity', async (_label, body) => {
    const provider = providerWith({
      transport: createStubTransport([{ match: '/v1/projects/', status: 200, body }]),
      databaseReaderFactory: () => createFakeDatabaseReader({}),
    });

    const observation = await observe(provider);

    expect(observation.controlPlane).toMatchObject({
      state: 'unavailable',
      reason: 'malformed_response',
    });
  });

  it('never serializes the management token', async () => {
    const provider = providerWith({
      transport: createStubTransport([
        { match: '/v1/projects/', status: 200, body: projectPayload },
      ]),
      databaseReaderFactory: () => createFakeDatabaseReader({}),
    });

    const observation = await observe(provider);
    const serialized = JSON.stringify(observation);

    expect(serialized).not.toContain('fixture-token');
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('Authorization');
  });
});

describe('database connection identity', () => {
  it('verifies identity when the connection endpoint carries the declared ref', async () => {
    const provider = providerWith({
      transport: createStubTransport([
        { match: '/v1/projects/', status: 200, body: projectPayload },
      ]),
      databaseReaderFactory: () =>
        createFakeDatabaseReader({
          identity: { observedProjectRef: REF, identitySource: 'direct_host' },
        }),
    });

    const observation = await observe(provider);

    expect(observation.connection?.state).toBe('available');
    expect(observation.observedProjectRef).toBe(REF);
    expect(observation.identity).toBe('verified');
    // The endpoint-derived target is serialized as connection-target evidence, distinct
    // from the observed identity claim.
    expect(observation.connection?.targetProjectRef).toBe(REF);
  });

  it('reports mismatch when the connection endpoint resolves to another project', async () => {
    const provider = providerWith({
      transport: createStubTransport([
        { match: '/v1/projects/', status: 200, body: projectPayload },
      ]),
      databaseReaderFactory: () =>
        createFakeDatabaseReader({
          identity: { observedProjectRef: OTHER_REF, identitySource: 'pooler_username' },
        }),
    });

    const observation = await observe(provider);

    expect(observation.observedProjectRef).toBe(OTHER_REF);
    expect(observation.identity).toBe('mismatch');
    expect(observation.connection?.identitySource).toBe('pooler_username');
  });

  it('reports unverified when the endpoint exposes no project ref', async () => {
    const provider = providerWith({
      transport: createStubTransport([
        { match: '/v1/projects/', status: 200, body: projectPayload },
      ]),
      databaseReaderFactory: () =>
        createFakeDatabaseReader({
          identity: {
            observedProjectRef: undefined,
            targetProjectRef: undefined,
            identitySource: undefined,
          },
        }),
    });

    const observation = await observe(provider);

    expect(observation.observedProjectRef).toBeUndefined();
    expect(observation.identity).toBe('unverified');
  });

  it('reports missing database credentials without attempting a connection', async () => {
    let readerBuilt = false;
    const provider = createSupabaseProvider({
      env: { DEPLOYTRUTH_SUPABASE_ACCESS_TOKEN: 'fixture-token' },
      transport: createStubTransport([
        { match: '/v1/projects/', status: 200, body: projectPayload },
      ]),
      databaseReaderFactory: () => {
        readerBuilt = true;
        return createFakeDatabaseReader({});
      },
    });

    const observation = await observe(provider);

    expect(readerBuilt).toBe(false);
    expect(observation.connection).toMatchObject({
      state: 'unavailable',
      reason: 'missing_credentials',
    });
    expect(observation.migrationHistory?.reason).toBe('connection_unavailable');
    expect(observation.identity).toBeUndefined();
  });

  it('maps a failed connection to an unavailable connection observation', async () => {
    const provider = providerWith({
      transport: createStubTransport([
        { match: '/v1/projects/', status: 200, body: projectPayload },
      ]),
      databaseReaderFactory: () =>
        createFakeDatabaseReader({
          identity: {
            state: 'unavailable',
            reason: 'authentication_failed',
            observedProjectRef: undefined,
            targetProjectRef: undefined,
            identitySource: undefined,
          },
        }),
    });

    const observation = await observe(provider);

    expect(observation.connection).toMatchObject({
      state: 'unavailable',
      reason: 'authentication_failed',
    });
    expect(observation.identity).toBeUndefined();
    expect(observation.migrationHistory?.reason).toBe('connection_unavailable');
  });

  it('a correct-looking URL with a failed connection is never reported as observed identity', async () => {
    const provider = providerWith({
      transport: createStubTransport([
        { match: '/v1/projects/', status: 200, body: projectPayload },
      ]),
      databaseReaderFactory: () =>
        createFakeDatabaseReader({
          identity: {
            state: 'unavailable',
            reason: 'connection_failed',
            observedProjectRef: undefined,
            targetProjectRef: REF,
            identitySource: 'direct_host',
          },
        }),
    });

    const observation = await observe(provider);

    expect(observation.connection).toMatchObject({
      state: 'unavailable',
      reason: 'connection_failed',
      targetProjectRef: REF,
    });
    expect(observation.observedProjectRef).toBeUndefined();
    expect(observation.identity).toBeUndefined();
  });

  it('a failed connection to a mistargeted URL reports target evidence, not observed identity', async () => {
    const provider = providerWith({
      transport: createStubTransport([
        { match: '/v1/projects/', status: 200, body: projectPayload },
      ]),
      databaseReaderFactory: () =>
        createFakeDatabaseReader({
          identity: {
            state: 'unavailable',
            reason: 'tls_error',
            observedProjectRef: undefined,
            targetProjectRef: OTHER_REF,
            identitySource: 'direct_host',
          },
        }),
    });

    const observation = await observe(provider);

    // The URL-derived target is labeled connection-target evidence; no database was ever
    // observed, so there is no observed ref and no identity verdict.
    expect(observation.connection).toMatchObject({
      state: 'unavailable',
      reason: 'tls_error',
      targetProjectRef: OTHER_REF,
    });
    expect(observation.observedProjectRef).toBeUndefined();
    expect(observation.identity).toBeUndefined();
    expect(observation.migrationHistory?.reason).toBe('connection_unavailable');
  });

  it('surfaces a refused insecure TLS configuration as unavailable connection evidence', async () => {
    const provider = providerWith({
      transport: createStubTransport([
        { match: '/v1/projects/', status: 200, body: projectPayload },
      ]),
      databaseReaderFactory: () =>
        createFakeDatabaseReader({
          identity: {
            state: 'unavailable',
            reason: 'insecure_tls_configuration',
            detail:
              'The database URL requests a TLS configuration that cannot authenticate the endpoint.',
            observedProjectRef: undefined,
            targetProjectRef: REF,
            identitySource: 'direct_host',
          },
        }),
    });

    const observation = await observe(provider);

    expect(observation.connection).toMatchObject({
      state: 'unavailable',
      reason: 'insecure_tls_configuration',
      targetProjectRef: REF,
    });
    expect(observation.observedProjectRef).toBeUndefined();
    expect(observation.identity).toBeUndefined();
  });

  it('still records migration history when identity is unverified, as diagnostic evidence', async () => {
    const provider = providerWith({
      transport: createStubTransport([
        { match: '/v1/projects/', status: 200, body: projectPayload },
      ]),
      databaseReaderFactory: () =>
        createFakeDatabaseReader({
          identity: {
            observedProjectRef: undefined,
            targetProjectRef: undefined,
            identitySource: undefined,
          },
          history: { state: 'available', appliedVersions: ['20240101000000'] },
        }),
    });

    const observation = await observe(provider);

    expect(observation.identity).toBe('unverified');
    expect(observation.migrationHistory?.state).toBe('available');
    expect(observation.appliedMigrationIds).toEqual(['20240101000000']);
  });

  it('marks history unavailable when the history table is absent', async () => {
    const provider = providerWith({
      transport: createStubTransport([
        { match: '/v1/projects/', status: 200, body: projectPayload },
      ]),
      databaseReaderFactory: () =>
        createFakeDatabaseReader({
          history: {
            state: 'unavailable',
            reason: 'history_table_missing',
            appliedVersions: [],
          },
        }),
    });

    const observation = await observe(provider);

    expect(observation.migrationHistory).toMatchObject({
      state: 'unavailable',
      reason: 'history_table_missing',
    });
    expect(observation.appliedMigrationIds).toEqual([]);
  });
});

describe('repository fixtures', () => {
  it.each(['healthy', 'migrations-behind'] as const)(
    'fixtures/supabase/%s.json parses as a valid M4 observation',
    (name) => {
      const parsed = databaseObservationSchema.parse(
        JSON.parse(readFileSync(resolve(process.cwd(), `fixtures/supabase/${name}.json`), 'utf8')),
      );

      expect(parsed.provider).toBe('supabase');
      expect(parsed.identity).toBe('verified');
      expect(parsed.migrationHistory?.state).toBe('available');
    },
  );
});

describe('supabase provider diagnose', () => {
  it('reports each evidence source as a separate diagnostic', async () => {
    const provider = providerWith({
      transport: createStubTransport([
        { match: '/v1/projects/', status: 200, body: projectPayload },
      ]),
      databaseReaderFactory: () =>
        createFakeDatabaseReader({ history: { appliedVersions: ['20240101000000'] } }),
    });
    const config = provider.validateConfig({ projectRef: REF });

    const diagnostics = await provider.diagnose?.({
      project: 'meridia',
      environment: 'production',
      config,
    });

    const codes = diagnostics?.map((entry) => entry.code) ?? [];
    expect(codes).toEqual([
      'SUPABASE_CREDENTIALS',
      'SUPABASE_API',
      'SUPABASE_PROJECT',
      'SUPABASE_DATABASE_URL',
      'SUPABASE_DATABASE_CONNECTION',
      'SUPABASE_DATABASE_IDENTITY',
      'SUPABASE_MIGRATION_HISTORY',
    ]);
    expect(diagnostics?.find((d) => d.code === 'SUPABASE_DATABASE_IDENTITY')?.status).toBe('ok');
    expect(diagnostics?.find((d) => d.code === 'SUPABASE_MIGRATION_HISTORY')?.message).toContain(
      '1 applied migration',
    );
  });

  it('reports a mismatching database identity as an error', async () => {
    const provider = providerWith({
      transport: createStubTransport([
        { match: '/v1/projects/', status: 200, body: projectPayload },
      ]),
      databaseReaderFactory: () =>
        createFakeDatabaseReader({
          identity: { observedProjectRef: OTHER_REF, identitySource: 'direct_host' },
        }),
    });
    const config = provider.validateConfig({ projectRef: REF });

    const diagnostics = await provider.diagnose?.({
      project: 'meridia',
      environment: 'production',
      config,
    });

    const identity = diagnostics?.find((entry) => entry.code === 'SUPABASE_DATABASE_IDENTITY');
    expect(identity?.status).toBe('error');
    expect(identity?.message).toContain(OTHER_REF);
  });

  it('reports the endpoint-derived target on a failed connection without claiming an observation', async () => {
    const provider = providerWith({
      transport: createStubTransport([
        { match: '/v1/projects/', status: 200, body: projectPayload },
      ]),
      databaseReaderFactory: () =>
        createFakeDatabaseReader({
          identity: {
            state: 'unavailable',
            reason: 'connection_failed',
            observedProjectRef: undefined,
            targetProjectRef: OTHER_REF,
            identitySource: 'direct_host',
          },
        }),
    });
    const config = provider.validateConfig({ projectRef: REF });

    const diagnostics = await provider.diagnose?.({
      project: 'meridia',
      environment: 'production',
      config,
    });

    const connection = diagnostics?.find((entry) => entry.code === 'SUPABASE_DATABASE_CONNECTION');
    const target = diagnostics?.find((entry) => entry.code === 'SUPABASE_DATABASE_TARGET');
    const identity = diagnostics?.find((entry) => entry.code === 'SUPABASE_DATABASE_IDENTITY');

    expect(connection?.status).toBe('error');
    expect(target?.status).toBe('error');
    expect(target?.message).toContain(OTHER_REF);
    expect(target?.message).toContain('not an observed identity');
    // A failed connection produces no identity verdict at all.
    expect(identity).toBeUndefined();
  });
});
