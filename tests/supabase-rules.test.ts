import {
  databaseObservationSchema,
  evaluateTruth,
  migrationCatalogObservationSchema,
  sourceObservationSchema,
  type DatabaseObservation,
  type MigrationCatalogObservation,
  type SourceObservation,
  type TruthContext,
} from '@deploytruth/core';
import { describe, expect, it } from 'vitest';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const REF = 'prodabc123';
const OTHER_REF = 'otherproject99';

const declaration = {
  version: 1,
  project: 'meridia',
  environments: {
    production: {
      id: 'production',
      kind: 'production',
      source: { provider: 'github', repository: 'acme/meridia', branch: 'main' },
      database: {
        provider: 'supabase',
        projectRef: REF,
        migrationDirectory: 'supabase/migrations',
      },
      requiredEnvironmentVariables: [],
      checks: { local_git: true, remote_source: true, migrations: true },
    },
  },
} as const;

const gitSource = (overrides: Partial<SourceObservation> = {}): SourceObservation =>
  sourceObservationSchema.parse({
    provider: 'git',
    branch: 'main',
    headSha: SHA_A,
    workingTree: 'clean',
    upstream: { remote: 'origin', branch: 'main', ref: 'refs/remotes/origin/main', sha: SHA_A },
    aheadBy: 0,
    behindBy: 0,
    ...overrides,
  });

const gitHubSource = (overrides: Partial<SourceObservation> = {}): SourceObservation =>
  sourceObservationSchema.parse({
    provider: 'github',
    repository: 'acme/meridia',
    branch: 'main',
    remoteHeadSha: SHA_A,
    defaultBranch: 'main',
    availability: { state: 'available' },
    ...overrides,
  });

const catalog = (
  overrides: Partial<MigrationCatalogObservation> = {},
): MigrationCatalogObservation =>
  migrationCatalogObservationSchema.parse({
    directory: 'supabase/migrations',
    migrationIds: ['20240101000000', '20240102000000'],
    sourceSha: SHA_A,
    origin: 'git-tree',
    availability: { state: 'available' },
    ...overrides,
  });

const supabase = (overrides: Readonly<Record<string, unknown>> = {}): DatabaseObservation =>
  databaseObservationSchema.parse({
    provider: 'supabase',
    projectRef: REF,
    controlPlane: { state: 'available', projectName: 'meridia-prod', status: 'healthy' },
    connection: { state: 'available', identitySource: 'direct_host' },
    observedProjectRef: REF,
    identity: 'verified',
    appliedMigrationIds: ['20240101000000', '20240102000000'],
    migrationHistory: { state: 'available' },
    ...overrides,
  });

interface Observations {
  readonly source?: SourceObservation;
  readonly remoteSource?: SourceObservation;
  readonly repositoryMigrations?: MigrationCatalogObservation;
  readonly database?: DatabaseObservation;
}

const context = (
  observations: Observations,
  checks: Readonly<Record<string, boolean>> = {},
  declaredDatabase: Readonly<Record<string, unknown>> | false = {},
): TruthContext => ({
  declaration: {
    ...declaration,
    environments: {
      production: {
        ...declaration.environments.production,
        ...(declaredDatabase === false
          ? {}
          : {
              database: {
                ...declaration.environments.production.database,
                ...declaredDatabase,
              },
            }),
        ...(declaredDatabase === false ? { database: undefined } : {}),
        checks: { ...declaration.environments.production.checks, ...checks },
      },
    },
  },
  observations: {
    project: 'meridia',
    environments: {
      production: {
        environment: 'production',
        ...(observations.source !== undefined ? { source: observations.source } : {}),
        ...(observations.remoteSource !== undefined
          ? { remoteSource: observations.remoteSource }
          : {}),
        ...(observations.repositoryMigrations !== undefined
          ? { repositoryMigrations: observations.repositoryMigrations }
          : {}),
        ...(observations.database !== undefined ? { database: observations.database } : {}),
      },
    },
  },
  generatedAt: '2026-09-11T00:00:00Z',
});

const healthy = (overrides: Observations = {}) =>
  context({
    source: gitSource(),
    remoteSource: gitHubSource(),
    repositoryMigrations: catalog(),
    database: supabase(),
    ...overrides,
  });

const codes = (report: ReturnType<typeof evaluateTruth>): readonly string[] =>
  report.findings.map((finding) => finding.code);

describe('Supabase project truth', () => {
  it('passes migrations truth when every evidence source agrees', () => {
    const report = evaluateTruth(healthy());

    expect(report.findings).toEqual([]);
    expect(report.verdict).toBe('PASS');
  });

  it.each([
    'missing_credentials',
    'unauthorized',
    'forbidden',
    'not_found_or_inaccessible',
    'rate_limited',
    'network_error',
    'timeout',
    'server_error',
    'malformed_response',
  ] as const)(
    'SUPABASE_PROJECT_UNAVAILABLE warns when the control plane is unavailable (%s)',
    (reason) => {
      const report = evaluateTruth(
        healthy({
          database: supabase({
            controlPlane: { state: 'unavailable', reason, detail: 'normalized' },
          }),
        }),
      );
      const finding = report.findings.find(
        (entry) => entry.code === 'SUPABASE_PROJECT_UNAVAILABLE',
      );

      expect(finding?.status).toBe('WARN');
      expect(finding?.evidence['reason']).toBe(reason);
      // Migrations can still verify: the catalog is authoritative and identity is verified.
      expect(codes(report)).not.toContain('MIGRATION_SOURCE_UNAVAILABLE');
      expect(report.verdict).toBe('WARN');
    },
  );

  it('never fabricates control-plane truth when the observation is absent entirely', () => {
    const input = healthy();
    delete input.observations.environments.production.database;

    const report = evaluateTruth(input);

    expect(codes(report)).toContain('REQUIRED_OBSERVATION_UNAVAILABLE');
    expect(codes(report)).not.toContain('DATABASE_MIGRATIONS_BEHIND');
    expect(report.verdict).toBe('WARN');
  });
});

describe('database identity', () => {
  it('DATABASE_CONNECTION_UNAVAILABLE warns when the database cannot be reached', () => {
    const report = evaluateTruth(
      healthy({
        database: supabase({
          connection: { state: 'unavailable', reason: 'connection_failed', detail: 'x' },
          identity: undefined,
          observedProjectRef: undefined,
          migrationHistory: { state: 'unavailable', reason: 'connection_unavailable' },
        }),
      }),
    );

    expect(codes(report)).toContain('DATABASE_CONNECTION_UNAVAILABLE');
    expect(codes(report)).not.toContain('WRONG_DATABASE_PROJECT');
    expect(codes(report)).not.toContain('DATABASE_MIGRATIONS_BEHIND');
    expect(report.verdict).toBe('WARN');
  });

  it('WRONG_DATABASE_PROJECT fails when the observed connection is another project', () => {
    const report = evaluateTruth(
      healthy({
        database: supabase({
          observedProjectRef: OTHER_REF,
          identity: 'mismatch',
          connection: { state: 'available', identitySource: 'pooler_username' },
        }),
      }),
    );
    const finding = report.findings.find((entry) => entry.code === 'WRONG_DATABASE_PROJECT');

    expect(finding?.status).toBe('FAIL');
    expect(finding?.expected).toBe(REF);
    expect(finding?.observed).toBe(OTHER_REF);
    expect(report.verdict).toBe('FAIL');
  });

  it('WRONG_DATABASE_PROJECT blocks migration comparison even when history is readable', () => {
    const report = evaluateTruth(
      healthy({
        database: supabase({
          observedProjectRef: OTHER_REF,
          identity: 'mismatch',
          appliedMigrationIds: ['20240101000000'],
        }),
      }),
    );

    // The mismatch is the certified fact; applied versions of an unidentified database are
    // never compared against the source.
    expect(codes(report)).not.toContain('DATABASE_MIGRATIONS_BEHIND');
    expect(report.verdict).toBe('FAIL');
  });

  it('DATABASE_IDENTITY_UNVERIFIED warns when the endpoint exposes no project ref', () => {
    const report = evaluateTruth(
      healthy({
        database: supabase({
          observedProjectRef: undefined,
          identity: 'unverified',
          connection: { state: 'available' },
        }),
      }),
    );

    expect(codes(report)).toContain('DATABASE_IDENTITY_UNVERIFIED');
    expect(codes(report)).not.toContain('WRONG_DATABASE_PROJECT');
    expect(report.verdict).toBe('WARN');
  });

  it('unverified identity cannot certify migration history even when it matches', () => {
    const report = evaluateTruth(
      healthy({
        database: supabase({
          observedProjectRef: undefined,
          identity: 'unverified',
          connection: { state: 'available' },
        }),
      }),
    );

    expect(codes(report)).toContain('REQUIRED_OBSERVATION_UNAVAILABLE');
    expect(report.verdict).toBe('WARN');
    expect(report.verdict).not.toBe('PASS');
  });
});

describe('migration source authority', () => {
  it('uses the GitHub-authoritative tree when local HEAD matches remote', () => {
    const report = evaluateTruth(healthy());

    expect(report.findings).toEqual([]);
    expect(report.verdict).toBe('PASS');
  });

  it('MIGRATION_SOURCE_UNAVAILABLE warns when local HEAD is behind the remote', () => {
    const report = evaluateTruth(healthy({ repositoryMigrations: catalog({ sourceSha: SHA_B }) }));
    const finding = report.findings.find((entry) => entry.code === 'MIGRATION_SOURCE_UNAVAILABLE');

    expect(finding?.status).toBe('WARN');
    expect(finding?.evidence['localHeadSha']).toBe(SHA_B);
    expect(finding?.evidence['remoteHeadSha']).toBe(SHA_A);
    expect(codes(report)).not.toContain('DATABASE_MIGRATIONS_BEHIND');
    expect(report.verdict).toBe('WARN');
  });

  it('MIGRATION_SOURCE_UNAVAILABLE when the remote source cannot be observed', () => {
    const report = evaluateTruth(
      healthy({
        remoteSource: gitHubSource({
          remoteHeadSha: undefined,
          availability: { state: 'unavailable', target: 'repository', reason: 'rate_limited' },
        }),
      }),
    );

    expect(codes(report)).toContain('MIGRATION_SOURCE_UNAVAILABLE');
    expect(report.verdict).toBe('WARN');
  });

  it('MIGRATION_SOURCE_UNAVAILABLE when no remote observation exists', () => {
    const report = evaluateTruth(
      healthy({ remoteSource: undefined, repositoryMigrations: catalog() }),
    );

    expect(codes(report)).toContain('MIGRATION_SOURCE_UNAVAILABLE');
  });

  it('treats the local committed tree as authoritative when no remote source is declared', () => {
    const input = healthy();
    delete input.declaration.environments.production.source;

    const report = evaluateTruth(input);

    expect(report.findings).toEqual([]);
    expect(report.verdict).toBe('PASS');
  });

  it.each([
    'directory_missing',
    'not_a_directory',
    'duplicate_versions',
    'invalid_filenames',
  ] as const)('MIGRATION_SOURCE_INVALID warns for %s', (reason) => {
    const report = evaluateTruth(
      healthy({
        repositoryMigrations: catalog({
          availability: { state: 'unavailable', reason, detail: 'normalized' },
          migrationIds: [],
        }),
      }),
    );

    expect(codes(report)).toContain('MIGRATION_SOURCE_INVALID');
    expect(codes(report)).not.toContain('MIGRATION_SOURCE_UNAVAILABLE');
    expect(report.verdict).toBe('WARN');
  });

  it.each(['git_unavailable', 'not_a_repository', 'head_unavailable'] as const)(
    'MIGRATION_SOURCE_UNAVAILABLE warns for %s',
    (reason) => {
      const report = evaluateTruth(
        healthy({
          repositoryMigrations: catalog({
            availability: { state: 'unavailable', reason, detail: 'normalized' },
            migrationIds: [],
          }),
        }),
      );

      expect(codes(report)).toContain('MIGRATION_SOURCE_UNAVAILABLE');
      expect(codes(report)).not.toContain('MIGRATION_SOURCE_INVALID');
    },
  );

  it('MIGRATION_SOURCE_INVALID evidence carries the offending filenames', () => {
    const report = evaluateTruth(
      healthy({
        repositoryMigrations: catalog({
          availability: {
            state: 'unavailable',
            reason: 'invalid_filenames',
            invalidFilenames: ['add_users.sql'],
          },
          migrationIds: [],
        }),
      }),
    );
    const finding = report.findings.find((entry) => entry.code === 'MIGRATION_SOURCE_INVALID');

    expect(finding?.evidence['invalidFilenames']).toEqual(['add_users.sql']);
  });
});

describe('applied migration comparison', () => {
  it('DATABASE_MIGRATIONS_BEHIND fails on missing applied versions', () => {
    const report = evaluateTruth(
      healthy({ database: supabase({ appliedMigrationIds: ['20240101000000'] }) }),
    );
    const finding = report.findings.find((entry) => entry.code === 'DATABASE_MIGRATIONS_BEHIND');

    expect(finding?.status).toBe('FAIL');
    expect(finding?.evidence['missingMigrationIds']).toEqual(['20240102000000']);
    expect(report.verdict).toBe('FAIL');
  });

  it('DATABASE_MIGRATION_DRIFT warns on applied versions absent from the source', () => {
    const report = evaluateTruth(
      healthy({
        database: supabase({
          appliedMigrationIds: ['20240101000000', '20240102000000', '20240103000000'],
        }),
      }),
    );
    const finding = report.findings.find((entry) => entry.code === 'DATABASE_MIGRATION_DRIFT');

    expect(finding?.status).toBe('WARN');
    expect(finding?.evidence['extraMigrationIds']).toEqual(['20240103000000']);
    expect(report.verdict).toBe('WARN');
    expect(report.verdict).not.toBe('FAIL');
  });

  it('missing and extra versions produce both findings', () => {
    const report = evaluateTruth(
      healthy({
        database: supabase({ appliedMigrationIds: ['20240101000000', '99999999999999'] }),
      }),
    );
    const behind = report.findings.find((entry) => entry.code === 'DATABASE_MIGRATIONS_BEHIND');
    const drift = report.findings.find((entry) => entry.code === 'DATABASE_MIGRATION_DRIFT');

    expect(behind?.evidence['missingMigrationIds']).toEqual(['20240102000000']);
    expect(drift?.evidence['extraMigrationIds']).toEqual(['99999999999999']);
    expect(report.verdict).toBe('FAIL');
  });

  it('an empty applied history with an empty expected set stays clean', () => {
    const report = evaluateTruth(
      healthy({
        repositoryMigrations: catalog({ migrationIds: [] }),
        database: supabase({ appliedMigrationIds: [] }),
      }),
    );

    expect(report.findings).toEqual([]);
    expect(report.verdict).toBe('PASS');
  });

  it('DATABASE_MIGRATION_HISTORY_UNAVAILABLE warns when history cannot be read', () => {
    const report = evaluateTruth(
      healthy({
        database: supabase({
          migrationHistory: {
            state: 'unavailable',
            reason: 'history_table_missing',
            detail: 'no table',
          },
          appliedMigrationIds: [],
        }),
      }),
    );

    expect(codes(report)).toContain('DATABASE_MIGRATION_HISTORY_UNAVAILABLE');
    expect(codes(report)).not.toContain('DATABASE_MIGRATIONS_BEHIND');
    expect(report.verdict).toBe('WARN');
  });

  it('a missing history table is never treated as zero migrations', () => {
    const report = evaluateTruth(
      healthy({
        repositoryMigrations: catalog({ migrationIds: [] }),
        database: supabase({
          migrationHistory: { state: 'unavailable', reason: 'history_table_missing' },
          appliedMigrationIds: [],
        }),
      }),
    );

    // Empty expected set + unavailable history must not silently PASS.
    expect(codes(report)).toContain('DATABASE_MIGRATION_HISTORY_UNAVAILABLE');
    expect(codes(report)).toContain('REQUIRED_OBSERVATION_UNAVAILABLE');
    expect(report.verdict).not.toBe('PASS');
  });

  it('catalog absence never produces a false PASS or a fabricated comparison', () => {
    const input = healthy();
    delete input.observations.environments.production.repositoryMigrations;

    const report = evaluateTruth(input);

    expect(codes(report)).toContain('MIGRATION_SOURCE_UNAVAILABLE');
    expect(codes(report)).not.toContain('DATABASE_MIGRATIONS_BEHIND');
    expect(report.verdict).toBe('WARN');
  });

  it('keeps control-plane evidence separate: verified identity does not resurrect the project', () => {
    const report = evaluateTruth(
      healthy({
        database: supabase({
          controlPlane: { state: 'unavailable', reason: 'not_found_or_inaccessible' },
        }),
      }),
    );

    expect(codes(report)).toContain('SUPABASE_PROJECT_UNAVAILABLE');
    expect(codes(report)).not.toContain('DATABASE_IDENTITY_UNVERIFIED');
    expect(report.verdict).toBe('WARN');
  });
});

describe('topology semantics', () => {
  it('the deployment-to-database edge is never marked observed', () => {
    const input = healthy();
    input.declaration.environments.production = {
      ...input.declaration.environments.production,
      deployment: { provider: 'vercel', project: 'meridia' },
    };

    const report = evaluateTruth(input);
    const edge = report.topology.edges.find(
      (entry) => entry.source === 'production:deployment' && entry.target === 'production:database',
    );

    expect(edge).toBeDefined();
    expect(edge?.observed).toBe(false);
    expect(edge?.expected).toBe(true);
    // The declared edge is honest evidence, but never a verified Vercel→Supabase connection.
  });

  it('the database node carries identity evidence', () => {
    const report = evaluateTruth(healthy());
    const node = report.topology.nodes.find((entry) => entry.type === 'database');

    expect(node?.provider).toBe('supabase');
    expect(node?.metadata?.['identity']).toBe('verified');
    expect(node?.metadata?.['migrationHistory']).toBe('available');
  });
});
