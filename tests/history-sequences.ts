import {
  createRunId,
  evaluateTruth,
  type EnvironmentObservation,
  type TruthContext,
  type TruthReport,
} from '@deploytruth/core';

import { loadScenario } from './scenario-loader.js';

export const fixedRunId = (timestampMs: number, entropy: number): string =>
  createRunId(
    timestampMs,
    Uint8Array.from({ length: 10 }, () => entropy),
  );

const cloneContext = (context: TruthContext): TruthContext =>
  structuredClone(context) as TruthContext;

const productionOf = (context: TruthContext): EnvironmentObservation => {
  const observed = context.observations.environments.production;
  if (observed === undefined) {
    throw new Error('History sequence requires a production observation.');
  }
  return observed;
};

export const reportFromScenario = (
  name: string,
  options: {
    readonly runId: string;
    readonly generatedAt: string;
    readonly transform?: (context: TruthContext) => TruthContext;
  },
): TruthReport => {
  const context = options.transform?.(cloneContext(loadScenario(name))) ?? loadScenario(name);
  return evaluateTruth({
    ...context,
    generatedAt: options.generatedAt,
    runId: options.runId,
  });
};

export const withShas = (
  context: TruthContext,
  sourceSha: string,
  deploymentSha: string,
  runtimeSha = deploymentSha,
): TruthContext => {
  const observed = productionOf(context);
  return {
    ...context,
    observations: {
      ...context.observations,
      environments: {
        ...context.observations.environments,
        production: {
          ...observed,
          source: observed.source
            ? {
                ...observed.source,
                headSha: sourceSha,
                ...(observed.source.upstream
                  ? { upstream: { ...observed.source.upstream, sha: sourceSha } }
                  : {}),
              }
            : observed.source,
          remoteSource: observed.remoteSource
            ? { ...observed.remoteSource, remoteHeadSha: sourceSha }
            : observed.remoteSource,
          deployment: observed.deployment
            ? { ...observed.deployment, commitSha: deploymentSha }
            : observed.deployment,
          runtime: observed.runtime
            ? { ...observed.runtime, commitSha: runtimeSha }
            : observed.runtime,
          repositoryMigrations: observed.repositoryMigrations
            ? { ...observed.repositoryMigrations, sourceSha }
            : observed.repositoryMigrations,
        },
      },
    },
  };
};

export const withDatabaseProject = (context: TruthContext, projectRef: string): TruthContext => {
  const observed = productionOf(context);
  return {
    ...context,
    observations: {
      ...context.observations,
      environments: {
        ...context.observations.environments,
        production: {
          ...observed,
          database: observed.database
            ? { ...observed.database, observedProjectRef: projectRef, projectRef }
            : observed.database,
          runtime: observed.runtime?.databaseConnection
            ? {
                ...observed.runtime,
                databaseConnection: {
                  ...observed.runtime.databaseConnection,
                  targetProjectRef: projectRef,
                },
              }
            : observed.runtime,
        },
      },
    },
  };
};

export const withMigrations = (
  context: TruthContext,
  expected: readonly string[],
  applied: readonly string[],
): TruthContext => {
  const observed = productionOf(context);
  return {
    ...context,
    observations: {
      ...context.observations,
      environments: {
        ...context.observations.environments,
        production: {
          ...observed,
          database: observed.database
            ? { ...observed.database, appliedMigrationIds: [...applied] }
            : observed.database,
          repositoryMigrations: observed.repositoryMigrations
            ? { ...observed.repositoryMigrations, migrationIds: [...expected] }
            : observed.repositoryMigrations,
        },
      },
    },
  };
};

export const withRuntimeDatabaseUnavailable = (context: TruthContext): TruthContext => {
  const observed = productionOf(context);
  if (observed.runtime === undefined) return context;
  return {
    ...context,
    observations: {
      ...context.observations,
      environments: {
        ...context.observations.environments,
        production: {
          ...observed,
          runtime: {
            ...observed.runtime,
            databaseConnection: {
              provider: 'supabase',
              identity: 'unverified',
              status: 'unavailable',
              reason: 'network_error',
            },
          },
        },
      },
    },
  };
};

const at = (iso: string): number => Date.parse(iso);

/** Deterministic M7 certification sequences. */
export const historySequences = {
  healthyUpdate: [
    reportFromScenario('healthy-production', {
      runId: fixedRunId(at('2026-09-12T17:00:00Z'), 1),
      generatedAt: '2026-09-12T17:00:00.000Z',
      transform: (context) => withShas(context, 'abc123', 'abc123'),
    }),
    reportFromScenario('healthy-production', {
      runId: fixedRunId(at('2026-09-12T18:00:00Z'), 2),
      generatedAt: '2026-09-12T18:00:00.000Z',
      transform: (context) => withShas(context, 'def456', 'def456'),
    }),
  ],
  regression: [
    reportFromScenario('healthy-production', {
      runId: fixedRunId(at('2026-09-12T17:00:00Z'), 3),
      generatedAt: '2026-09-12T17:00:00.000Z',
    }),
    reportFromScenario('deployment-sha-mismatch', {
      runId: fixedRunId(at('2026-09-12T18:00:00Z'), 4),
      generatedAt: '2026-09-12T18:00:00.000Z',
    }),
  ],
  recovery: [
    reportFromScenario('deployment-sha-mismatch', {
      runId: fixedRunId(at('2026-09-12T17:00:00Z'), 5),
      generatedAt: '2026-09-12T17:00:00.000Z',
    }),
    reportFromScenario('healthy-production', {
      runId: fixedRunId(at('2026-09-12T18:00:00Z'), 6),
      generatedAt: '2026-09-12T18:00:00.000Z',
    }),
  ],
  persistentWarning: [
    reportFromScenario('dirty-worktree', {
      runId: fixedRunId(at('2026-09-12T17:00:00Z'), 7),
      generatedAt: '2026-09-12T17:00:00.000Z',
    }),
    reportFromScenario('dirty-worktree', {
      runId: fixedRunId(at('2026-09-12T18:00:00Z'), 8),
      generatedAt: '2026-09-12T18:00:00.000Z',
    }),
  ],
  warningToFail: [
    reportFromScenario('dirty-worktree', {
      runId: fixedRunId(at('2026-09-12T17:00:00Z'), 9),
      generatedAt: '2026-09-12T17:00:00.000Z',
    }),
    reportFromScenario('deployment-sha-mismatch', {
      runId: fixedRunId(at('2026-09-12T18:00:00Z'), 10),
      generatedAt: '2026-09-12T18:00:00.000Z',
      transform: (context) => {
        const dirty = loadScenario('dirty-worktree');
        const observed = productionOf(context);
        const dirtySource = dirty.observations.environments.production?.source;
        return {
          ...context,
          observations: {
            ...context.observations,
            environments: {
              ...context.observations.environments,
              production: {
                ...observed,
                ...(dirtySource ? { source: dirtySource } : {}),
              },
            },
          },
        };
      },
    }),
  ],
  runtimeDbWarning: [
    reportFromScenario('healthy-production', {
      runId: fixedRunId(at('2026-09-12T17:00:00Z'), 11),
      generatedAt: '2026-09-12T17:00:00.000Z',
    }),
    reportFromScenario('healthy-production', {
      runId: fixedRunId(at('2026-09-12T18:00:00Z'), 12),
      generatedAt: '2026-09-12T18:00:00.000Z',
      transform: withRuntimeDatabaseUnavailable,
    }),
  ],
  migrationDivergence: [
    reportFromScenario('healthy-production', {
      runId: fixedRunId(at('2026-09-12T17:00:00Z'), 13),
      generatedAt: '2026-09-12T17:00:00.000Z',
      transform: (context) =>
        withMigrations(context, ['001_init', '002_profiles'], ['001_init', '002_profiles']),
    }),
    reportFromScenario('healthy-production', {
      runId: fixedRunId(at('2026-09-12T18:00:00Z'), 14),
      generatedAt: '2026-09-12T18:00:00.000Z',
      transform: (context) =>
        withMigrations(
          context,
          ['001_init', '002_profiles'],
          ['001_init', '002_profiles', '003_extra'],
        ),
    }),
  ],
} as const;
