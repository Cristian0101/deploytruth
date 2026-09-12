import {
  evaluateTruth,
  type DeclaredEnvironment,
  type EnvironmentObservation,
  type TruthContext,
} from '@deploytruth/core';
import { describe, expect, it } from 'vitest';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const PROJECT_A = 'wxzqzkkuozujicoywcur';
const PROJECT_B = 'abcdefghijklmnopqrst';

const declaration = (overrides: Partial<DeclaredEnvironment> = {}): DeclaredEnvironment => ({
  id: 'acceptance',
  kind: 'custom',
  deployment: { provider: 'vercel', project: 'example', target: 'production' },
  database: { provider: 'supabase', projectRef: PROJECT_A },
  runtime: {
    url: 'https://example.test/api/deploytruth/runtime',
    expectedEnvironment: 'acceptance',
  },
  requiredEnvironmentVariables: ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY'],
  checks: {
    deployment_sha: false,
    runtime_identity: true,
    environment_isolation: true,
    environment_variables: true,
  },
  ...overrides,
});

const observation = (overrides: Partial<EnvironmentObservation> = {}): EnvironmentObservation => ({
  environment: 'acceptance',
  deployment: {
    provider: 'vercel',
    project: 'example',
    target: 'production',
    commitSha: SHA_A,
  },
  runtime: {
    url: 'https://example.test/api/deploytruth/runtime',
    reachable: true,
    statusCode: 200,
    availability: { state: 'available' },
    attestationVersion: 1,
    freshness: { state: 'verified' },
    cacheControlNoStore: true,
    commitSha: SHA_A,
    environment: 'production',
    environmentVariables: [
      { name: 'SUPABASE_URL', present: true },
      { name: 'SUPABASE_PUBLISHABLE_KEY', present: true },
    ],
    databaseConnection: {
      provider: 'supabase',
      targetProjectRef: PROJECT_A,
      identity: 'verified',
      status: 'connected',
    },
  },
  ...overrides,
});

const reportFor = (
  declared: DeclaredEnvironment = declaration(),
  observed: EnvironmentObservation = observation(),
) =>
  evaluateTruth({
    declaration: { version: 1, project: 'example', environments: { acceptance: declared } },
    observations: { project: 'example', environments: { acceptance: observed } },
    generatedAt: '2026-09-12T16:00:00Z',
  } satisfies TruthContext);

const codes = (context = reportFor()): readonly string[] =>
  context.findings.map((finding) => finding.code);

describe('M5 runtime truth rules and coverage', () => {
  it('satisfies all three M5 checks from fresh matching runtime evidence', () => {
    const report = reportFor();
    expect(report.verdict).toBe('PASS');
    expect(report.findings).toEqual([]);
  });

  it('reports unavailable runtime attestation without a false PASS', () => {
    const observed = observation({
      runtime: {
        url: 'https://example.test/api/deploytruth/runtime',
        reachable: false,
        availability: { state: 'unavailable', reason: 'timeout', detail: 'fixed detail' },
      },
    });
    const report = reportFor(declaration(), observed);
    expect(codes(report)).toEqual(
      expect.arrayContaining([
        'RUNTIME_ATTESTATION_UNAVAILABLE',
        'REQUIRED_OBSERVATION_UNAVAILABLE',
      ]),
    );
    expect(report.verdict).toBe('WARN');
  });

  it('nonce mismatch cannot satisfy runtime identity or create a stale SHA failure', () => {
    const observed = observation({
      runtime: {
        ...observation().runtime!,
        freshness: { state: 'unverified', reason: 'nonce_mismatch' },
        commitSha: SHA_B,
      },
    });
    const report = reportFor(declaration(), observed);
    expect(codes(report)).toContain('RUNTIME_ATTESTATION_FRESHNESS_UNVERIFIED');
    expect(codes(report)).toContain('REQUIRED_OBSERVATION_UNAVAILABLE');
    expect(codes(report)).not.toContain('RUNTIME_SHA_MISMATCH');
  });

  it('fails when a fresh runtime SHA differs from the deployment SHA', () => {
    const observed = observation({
      runtime: { ...observation().runtime!, commitSha: SHA_B },
    });
    const report = reportFor(declaration(), observed);
    expect(codes(report)).toContain('RUNTIME_SHA_MISMATCH');
    expect(report.verdict).toBe('FAIL');
  });

  it('keeps runtime identity uncovered when either SHA is unavailable', () => {
    const runtime = { ...observation().runtime! };
    delete runtime.commitSha;
    const report = reportFor(declaration(), observation({ runtime }));
    expect(codes(report)).toContain('REQUIRED_OBSERVATION_UNAVAILABLE');
    expect(codes(report)).not.toContain('RUNTIME_SHA_MISMATCH');
  });

  it('compares runtime environment to the deployment target, not the logical environment id', () => {
    const report = reportFor();
    expect(codes(report)).not.toContain('RUNTIME_ENVIRONMENT_MISMATCH');
    expect(report.environments[0]?.declaration.id).toBe('acceptance');
  });

  it('fails when production control-plane target attests as preview', () => {
    const report = reportFor(
      declaration(),
      observation({ runtime: { ...observation().runtime!, environment: 'preview' } }),
    );
    expect(codes(report)).toContain('RUNTIME_ENVIRONMENT_MISMATCH');
    expect(report.verdict).toBe('FAIL');
  });

  it('fails only variables explicitly attested false', () => {
    const report = reportFor(
      declaration(),
      observation({
        runtime: {
          ...observation().runtime!,
          environmentVariables: [
            { name: 'SUPABASE_URL', present: true },
            { name: 'SUPABASE_PUBLISHABLE_KEY', present: false },
          ],
        },
      }),
    );
    const finding = report.findings.find((entry) => entry.code === 'RUNTIME_REQUIRED_ENV_MISSING');
    expect(finding?.evidence['missingVariableNames']).toEqual(['SUPABASE_PUBLISHABLE_KEY']);
    expect(report.verdict).toBe('FAIL');
  });

  it('treats an omitted required variable as unknown rather than explicitly missing', () => {
    const report = reportFor(
      declaration(),
      observation({
        runtime: {
          ...observation().runtime!,
          environmentVariables: [{ name: 'SUPABASE_URL', present: true }],
        },
      }),
    );
    expect(codes(report)).toContain('REQUIRED_OBSERVATION_UNAVAILABLE');
    expect(codes(report)).not.toContain('RUNTIME_REQUIRED_ENV_MISSING');
  });

  it('ignores false evidence for a non-required variable', () => {
    const report = reportFor(
      declaration({ requiredEnvironmentVariables: ['SUPABASE_URL'] }),
      observation({
        runtime: {
          ...observation().runtime!,
          environmentVariables: [
            { name: 'SUPABASE_URL', present: true },
            { name: 'OPTIONAL_FEATURE', present: false },
          ],
        },
      }),
    );
    expect(codes(report)).not.toContain('RUNTIME_REQUIRED_ENV_MISSING');
  });

  it('fails a runtime-derived database target mismatch', () => {
    const report = reportFor(
      declaration(),
      observation({
        runtime: {
          ...observation().runtime!,
          databaseConnection: {
            provider: 'supabase',
            targetProjectRef: PROJECT_B,
            identity: 'verified',
            status: 'connected',
          },
        },
      }),
    );
    expect(codes(report)).toContain('RUNTIME_DATABASE_PROJECT_MISMATCH');
    expect(report.verdict).toBe('FAIL');
  });

  it('warns when the runtime database identity cannot be derived', () => {
    const report = reportFor(
      declaration(),
      observation({
        runtime: {
          ...observation().runtime!,
          databaseConnection: {
            provider: 'supabase',
            identity: 'unverified',
            status: 'connected',
            reason: 'identity_unverified',
          },
        },
      }),
    );
    expect(codes(report)).toContain('RUNTIME_DATABASE_IDENTITY_UNVERIFIED');
    expect(report.verdict).toBe('WARN');
  });

  it('warns when the correct runtime target cannot complete its read-only probe', () => {
    const report = reportFor(
      declaration(),
      observation({
        runtime: {
          ...observation().runtime!,
          databaseConnection: {
            provider: 'supabase',
            targetProjectRef: PROJECT_A,
            identity: 'verified',
            status: 'unavailable',
            reason: 'credentials_rejected',
          },
        },
      }),
    );
    expect(codes(report)).toContain('RUNTIME_DATABASE_CONNECTION_UNAVAILABLE');
    expect(report.verdict).toBe('WARN');
  });

  it('does not let independent M4 database evidence substitute for runtime connection truth', () => {
    const runtime = { ...observation().runtime! };
    delete runtime.databaseConnection;
    const observed = observation({
      runtime,
      database: {
        provider: 'supabase',
        projectRef: PROJECT_A,
        connection: { state: 'available', targetProjectRef: PROJECT_A },
        observedProjectRef: PROJECT_A,
        identity: 'verified',
        migrationHistory: { state: 'available' },
        appliedMigrationIds: [],
      },
    });
    const report = reportFor(declaration(), observed);
    expect(codes(report)).toContain('RUNTIME_DATABASE_IDENTITY_UNVERIFIED');
    expect(codes(report)).toContain('REQUIRED_OBSERVATION_UNAVAILABLE');
  });

  it('requires no database evidence when no database is declared', () => {
    const declared = declaration({ database: undefined });
    const report = reportFor(declared, observation());
    expect(codes(report)).not.toContain('RUNTIME_DATABASE_IDENTITY_UNVERIFIED');
    expect(codes(report)).not.toContain('RUNTIME_DATABASE_CONNECTION_UNAVAILABLE');
    expect(report.verdict).toBe('PASS');
  });

  it('creates distinct observed Vercel-to-Runtime and Runtime-to-Supabase edges', () => {
    const report = reportFor();
    const edges = report.topology.edges;
    expect(
      edges.find((edge) => edge.id === 'acceptance:deployment->acceptance:runtime'),
    ).toMatchObject({
      expected: true,
      observed: true,
    });
    expect(
      edges.find((edge) => edge.id === 'acceptance:runtime->acceptance:database'),
    ).toMatchObject({
      expected: true,
      observed: true,
    });
    expect(
      edges.find((edge) => edge.id === 'acceptance:deployment->acceptance:database'),
    ).toBeUndefined();
  });

  it('does not mark the runtime-to-database edge observed when the probe fails', () => {
    const observed = observation({
      runtime: {
        ...observation().runtime!,
        databaseConnection: {
          provider: 'supabase',
          targetProjectRef: PROJECT_A,
          identity: 'verified',
          status: 'unavailable',
          reason: 'network_error',
        },
      },
    });
    const edge = reportFor(declaration(), observed).topology.edges.find((entry) =>
      entry.id.endsWith('runtime->acceptance:database'),
    );
    expect(edge?.observed).toBe(false);
    expect(edge?.health).toBe('warning');
  });
});
