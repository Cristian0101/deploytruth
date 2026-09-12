import pg from 'pg';

import type { DatabaseUnavailableReason } from '@deploytruth/core';

import { deriveProjectIdentity, type SupabaseIdentitySource } from './identity.js';

/**
 * The only PostgreSQL the runtime ever issues. Every statement is a hardcoded read-only
 * SELECT — no interpolation, no parameters, no mutation of any kind. The session is also
 * forced read-only at the driver level (`default_transaction_read_only`) and each read runs
 * inside an explicit `START TRANSACTION READ ONLY` block that is rolled back, so nothing
 * can persist even if a future edit tried to write.
 */
const READ_ONLY_STARTUP_OPTIONS =
  '-c default_transaction_read_only=on -c statement_timeout=5000 -c idle_in_transaction_session_timeout=5000';

const IDENTITY_PROBE_SQL = 'SELECT current_database() AS database_name';
const MIGRATION_HISTORY_SQL =
  'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version ASC';

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

export interface DatabaseIdentityResult {
  readonly state: 'available' | 'unavailable';
  readonly reason?: DatabaseUnavailableReason;
  /** Sanitized fixed detail — never a raw driver message. */
  readonly detail?: string;
  readonly observedProjectRef?: string;
  readonly identitySource?: SupabaseIdentitySource;
}

export interface MigrationHistoryResult {
  readonly state: 'available' | 'unavailable';
  readonly reason?: 'history_table_missing' | 'history_query_failed' | 'malformed_rows';
  /** Sanitized fixed detail — never a raw driver message or SQL payload. */
  readonly detail?: string;
  readonly appliedVersions: readonly string[];
}

/**
 * The narrow read-only boundary between DeployTruth and PostgreSQL. There is deliberately
 * no `query(sql)` surface: callers ask for exactly two facts, and the implementation maps
 * them to the two hardcoded statements above. Manifest data, CLI flags, and rules can never
 * reach arbitrary SQL through this interface.
 */
export interface SupabaseDatabaseReader {
  readonly inspectIdentity: () => Promise<DatabaseIdentityResult>;
  readonly readMigrationHistory: () => Promise<MigrationHistoryResult>;
}

const detailFor = (reason: DatabaseUnavailableReason): string => {
  switch (reason) {
    case 'authentication_failed':
      return 'The database rejected the configured credentials.';
    case 'connection_failed':
      return 'The database endpoint could not be reached.';
    case 'tls_error':
      return 'The database TLS handshake failed.';
    case 'timeout':
      return 'The database connection attempt timed out.';
    case 'invalid_url':
      return 'The database URL is not a valid postgres connection string.';
    case 'database_unavailable':
      return 'The database is unavailable.';
    default:
      return 'The database connection failed.';
  }
};

const TLS_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EPIPE',
]);

/** Maps driver/network failures to fixed reason codes; raw messages never escape. */
export const normalizeDatabaseError = (error: unknown): DatabaseUnavailableReason => {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof code === 'string') {
    // PostgreSQL SQLSTATEs reported on the wire.
    if (code === '28P01' || code === '28000') {
      return 'authentication_failed';
    }
    if (code === '3D000') {
      return 'database_unavailable';
    }
    if (code === 'ETIMEDOUT') {
      return 'timeout';
    }
    if (TLS_ERROR_CODES.has(code) || code.startsWith('ERR_TLS')) {
      return 'tls_error';
    }
    if (CONNECTION_ERROR_CODES.has(code)) {
      return 'connection_failed';
    }
  }
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return 'timeout';
  }
  return 'connection_failed';
};

const urlHasTlsDirective = (databaseUrl: string): boolean => {
  try {
    const url = new URL(databaseUrl);
    return url.searchParams.has('sslmode') || url.searchParams.has('ssl');
  } catch {
    return false;
  }
};

/** A minimal structural check; full parsing happens in deriveProjectIdentity. */
const isPostgresUrl = (databaseUrl: string): boolean => {
  try {
    const { protocol } = new URL(databaseUrl);
    return protocol === 'postgres:' || protocol === 'postgresql:';
  } catch {
    return false;
  }
};

interface QueryableClient {
  connect(): Promise<unknown>;
  query(text: string): Promise<{ rows: unknown[] }>;
  end(): Promise<unknown>;
}

type ClientFactory = (databaseUrl: string) => QueryableClient;

const createPgClient: ClientFactory = (databaseUrl) =>
  new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: DEFAULT_CONNECT_TIMEOUT_MS,
    // Read-only is also requested at startup; poolers may drop startup options, so every
    // read additionally runs inside an explicit READ ONLY transaction that is rolled back.
    options: READ_ONLY_STARTUP_OPTIONS,
    application_name: 'deploytruth-readonly',
    ...(urlHasTlsDirective(databaseUrl) ? {} : { ssl: { rejectUnauthorized: false } }),
  });

/**
 * Runs `fn` inside a transaction that cannot modify persistent state: the session is
 * read-only by startup option, the explicit transaction is READ ONLY, and the block always
 * ends in ROLLBACK — never COMMIT.
 */
const withReadOnlySession = async <T>(
  client: QueryableClient,
  fn: (client: QueryableClient) => Promise<T>,
): Promise<T> => {
  await client.connect();
  try {
    await client.query('START TRANSACTION READ ONLY');
    try {
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
};

/** Validates history rows: only the `version` string is ever read — never SQL payloads. */
export const parseMigrationRows = (rows: readonly unknown[]): readonly string[] | undefined => {
  const versions: string[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) {
      return undefined;
    }
    const version = (row as { version?: unknown }).version;
    if (typeof version !== 'string' || version.length === 0) {
      return undefined;
    }
    versions.push(version);
  }
  return [...new Set(versions)].sort();
};

const isUndefinedTable = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '42P01';

export interface PgDatabaseReaderOptions {
  /** Injectable client factory for tests; production uses `pg`. */
  readonly clientFactory?: ClientFactory;
}

/**
 * The production reader. The connection string lives only inside this closure; results
 * carry normalized states and the derived project ref — never the URL, credentials,
 * driver errors, or SQL text.
 */
export const createPgDatabaseReader = (
  databaseUrl: string,
  options: PgDatabaseReaderOptions = {},
): SupabaseDatabaseReader => {
  const makeClient = options.clientFactory ?? createPgClient;

  return {
    inspectIdentity: async (): Promise<DatabaseIdentityResult> => {
      if (!isPostgresUrl(databaseUrl)) {
        return {
          state: 'unavailable',
          reason: 'invalid_url',
          detail: detailFor('invalid_url'),
        };
      }
      const identity = deriveProjectIdentity(databaseUrl);
      try {
        await withReadOnlySession(makeClient(databaseUrl), async (client) => {
          await client.query(IDENTITY_PROBE_SQL);
        });
      } catch (error) {
        const reason = normalizeDatabaseError(error);
        return { state: 'unavailable', reason, detail: detailFor(reason) };
      }
      return {
        state: 'available',
        ...(identity !== undefined
          ? { observedProjectRef: identity.projectRef, identitySource: identity.source }
          : {}),
      };
    },

    readMigrationHistory: async (): Promise<MigrationHistoryResult> => {
      let rows: unknown[];
      try {
        rows = await withReadOnlySession(makeClient(databaseUrl), async (client) => {
          const result = await client.query(MIGRATION_HISTORY_SQL);
          return result.rows;
        });
      } catch (error) {
        if (isUndefinedTable(error)) {
          // The history table's absence is its own fact — it is not "zero migrations".
          return {
            state: 'unavailable',
            reason: 'history_table_missing',
            detail: 'supabase_migrations.schema_migrations does not exist in this database.',
            appliedVersions: [],
          };
        }
        return {
          state: 'unavailable',
          reason: 'history_query_failed',
          detail: 'The migration history query failed.',
          appliedVersions: [],
        };
      }
      const appliedVersions = parseMigrationRows(rows);
      if (appliedVersions === undefined) {
        return {
          state: 'unavailable',
          reason: 'malformed_rows',
          detail: 'Migration history rows did not match the expected shape.',
          appliedVersions: [],
        };
      }
      return { state: 'available', appliedVersions };
    },
  };
};
