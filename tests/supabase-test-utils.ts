import {
  databaseObservationSchema,
  type DatabaseObservation,
  type MigrationCatalogObservation,
} from '@deploytruth/core';
import {
  createFixtureProvider,
  type DatabaseIdentityResult,
  type MigrationHistoryResult,
  type ReadOnlyResponse,
  type ReadOnlyTransport,
  type SupabaseDatabaseReader,
} from '@deploytruth/providers';

export interface FixtureSupabaseOptions {
  readonly observedProjectRef?: string;
  readonly identitySource?: 'direct_host' | 'pooler_username';
  readonly identity?: 'verified' | 'mismatch' | 'unverified';
  readonly appliedMigrationIds?: readonly string[];
  readonly controlPlane?: DatabaseObservation['controlPlane'];
  readonly connection?: DatabaseObservation['connection'];
  readonly migrationHistory?: DatabaseObservation['migrationHistory'];
}

/**
 * A deterministic Supabase provider for tests: emits a normalized M4 observation with
 * sensible defaults (reachable control plane + verified identity + empty history) and
 * never touches the network or a real database.
 */
export const createFixtureSupabaseProvider = (options: FixtureSupabaseOptions = {}) =>
  createFixtureProvider({
    id: 'fixture-supabase',
    capabilities: ['database', 'migration-status'] as const,
    validateConfig: (value: unknown) => value as { projectRef: string },
    observationFor: ({ config }) => {
      const observedProjectRef = options.observedProjectRef ?? config.projectRef;
      const connection = options.connection ?? {
        state: 'available' as const,
        identitySource: options.identitySource ?? ('direct_host' as const),
        targetProjectRef: observedProjectRef,
      };
      const connectionAvailable = connection.state === 'available';
      return databaseObservationSchema.parse({
        provider: 'supabase',
        projectRef: config.projectRef,
        controlPlane: options.controlPlane ?? {
          state: 'available',
          projectName: 'fixture-project',
          region: 'us-east-1',
          status: 'healthy',
        },
        connection,
        ...(connectionAvailable
          ? {
              observedProjectRef,
              identity:
                options.identity ??
                (observedProjectRef === config.projectRef ? 'verified' : 'mismatch'),
            }
          : {}),
        appliedMigrationIds: [...(options.appliedMigrationIds ?? [])],
        migrationHistory: options.migrationHistory ?? { state: 'available' },
      });
    },
  });

/** A fake read-only transport that returns canned HTTP responses by URL substring. */
export const createStubTransport = (
  routes: ReadonlyArray<{
    readonly match: string;
    readonly status: number;
    readonly body?: unknown;
    readonly headers?: Readonly<Record<string, string>>;
  }>,
): ReadOnlyTransport => ({
  get: async ({ url }) => {
    const route = routes.find((entry) => url.includes(entry.match));
    if (route === undefined) {
      return { status: 404, headers: {}, body: { message: 'unstubbed' } } as ReadOnlyResponse;
    }
    return {
      status: route.status,
      headers: route.headers ?? {},
      body: route.body ?? {},
    };
  },
});

/** A fake database reader for adapter tests — no sockets, deterministic results. */
export const createFakeDatabaseReader = (options: {
  readonly identity?: Partial<DatabaseIdentityResult>;
  readonly history?: Partial<MigrationHistoryResult>;
}): SupabaseDatabaseReader => ({
  inspectIdentity: async () => ({
    state: 'available',
    observedProjectRef: 'prodabc123',
    targetProjectRef: 'prodabc123',
    identitySource: 'direct_host',
    ...options.identity,
  }),
  readMigrationHistory: async () => ({
    state: 'available',
    appliedVersions: [],
    ...options.history,
  }),
});

/** A fixture migration-catalog provider with an immutable git-tree observation. */
export const createFixtureMigrationCatalogProvider = (options: {
  readonly directory?: string;
  readonly migrationIds?: readonly string[];
  readonly sourceSha?: string;
  readonly availability?: MigrationCatalogObservation['availability'];
}) =>
  createFixtureProvider({
    id: 'fixture-migration-catalog',
    capabilities: ['migration-status'] as const,
    validateConfig: (value: unknown) => value as { directory: string; migrationDirectory: string },
    observationFor: ({ config }) =>
      ({
        directory: options.directory ?? config.migrationDirectory,
        migrationIds: [...(options.migrationIds ?? [])],
        ...(options.sourceSha !== undefined ? { sourceSha: options.sourceSha } : {}),
        origin: 'git-tree',
        availability: options.availability ?? { state: 'available' },
      }) as MigrationCatalogObservation,
  });
