import pg, { type ClientConfig } from 'pg';

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
  /**
   * Observed database identity: the endpoint-derived project ref, emitted only after a
   * TLS-authenticated session actually succeeded. A failed or refused connection never
   * produces an observed identity.
   */
  readonly observedProjectRef?: string;
  /**
   * The project ref the connection endpoint *targets*, derived deterministically from the
   * URL itself. This is configuration evidence — present whenever derivable, even when the
   * connection failed — and is never observed database identity.
   */
  readonly targetProjectRef?: string;
  /** How the endpoint-derived ref was recovered. */
  readonly identitySource?: SupabaseIdentitySource;
}

export interface MigrationHistoryResult {
  readonly state: 'available' | 'unavailable';
  readonly reason?:
    'connection_unavailable' | 'history_table_missing' | 'history_query_failed' | 'malformed_rows';
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
    case 'insecure_tls_configuration':
      return 'The database URL requests a TLS configuration that cannot authenticate the endpoint; DeployTruth only connects over certificate-verified TLS.';
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
  'CERT_NOT_YET_VALID',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
  'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
  'UNABLE_TO_GET_CRL',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'HOSTNAME_MISMATCH',
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

/**
 * TLS directives that must never reach the driver. `pg-connection-string` gives URL query
 * params precedence over the explicit client config and maps several of them onto
 * verification-weakening `ssl` options — the `no-verify`/`prefer` sslmodes, or `require`
 * under `uselibpqcompat`, all disable certificate verification at the driver. DeployTruth
 * therefore evaluates the policy itself, strips every TLS directive from the connection
 * string, and sets `ssl` explicitly.
 */
const TLS_DIRECTIVE_PARAMS = new Set([
  'ssl',
  'sslmode',
  'sslcert',
  'sslkey',
  'sslrootcert',
  'sslcrl',
  'sslpassword',
  'uselibpqcompat',
]);

/** URL params that carry certificate material or file paths; DeployTruth never reads them. */
const TLS_MATERIAL_PARAMS = ['sslcert', 'sslkey', 'sslrootcert', 'sslcrl', 'sslpassword'];

/**
 * sslmodes that request TLS. All of them resolve to DeployTruth's single posture —
 * certificate- and hostname-verified TLS — which is intentionally stricter than libpq
 * (`require` and `verify-ca` permit weaker verification there). Endpoint authenticity is
 * never traded for a successful handshake.
 */
const TLS_REQUESTING_SSLMODES = new Set(['require', 'verify-ca', 'verify-full']);

export type DatabaseTlsPolicy = { readonly state: 'verified' } | { readonly state: 'insecure' };

/**
 * Whether the connection string permits a TLS-authenticated session. The default — no
 * `sslmode` at all — is verified TLS. Anything that could produce plaintext or unverified
 * TLS fails closed: the `disable`/`allow`/`prefer`/`no-verify` sslmodes, unrecognized
 * sslmodes, falsy or unknown `ssl` values, `uselibpqcompat` (whose only purpose is
 * requesting libpq's weaker semantics, which DeployTruth does not implement), and any
 * URL-borne certificate material (custom CAs belong to the Node trust store /
 * `NODE_EXTRA_CA_CERTS`, never the URL).
 */
export const resolveTlsPolicy = (databaseUrl: string): DatabaseTlsPolicy => {
  let params: URLSearchParams;
  try {
    params = new URL(databaseUrl).searchParams;
  } catch {
    return { state: 'insecure' };
  }

  const ssl = params.get('ssl')?.trim().toLowerCase();
  if (ssl !== undefined && ssl !== '1' && ssl !== 'true') {
    return { state: 'insecure' };
  }

  const sslmode = params.get('sslmode')?.trim().toLowerCase();
  if (sslmode !== undefined && !TLS_REQUESTING_SSLMODES.has(sslmode)) {
    return { state: 'insecure' };
  }

  const libpqCompat = params.get('uselibpqcompat')?.trim().toLowerCase();
  if (libpqCompat === 'true' || libpqCompat === '1') {
    return { state: 'insecure' };
  }

  for (const material of TLS_MATERIAL_PARAMS) {
    const value = params.get(material);
    if (value !== null && value !== '') {
      return { state: 'insecure' };
    }
  }

  return { state: 'verified' };
};

/**
 * Returns the connection string with every TLS directive removed, so the parsed values can
 * never override the explicit verified-TLS client config. The result stays inside the reader
 * closure — it carries credentials and is never serialized.
 */
const stripTlsDirectives = (databaseUrl: string): string => {
  const url = new URL(databaseUrl);
  const kept = new URLSearchParams();
  url.searchParams.forEach((value, key) => {
    if (!TLS_DIRECTIVE_PARAMS.has(key.toLowerCase())) {
      kept.append(key, value);
    }
  });
  url.search = kept.toString();
  return url.toString();
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

/**
 * The exact configuration handed to `pg`. `ssl` is always an explicit verified-TLS object:
 * `rejectUnauthorized: true` plus the default server identity check gives
 * `verify-full`-equivalent semantics rooted in the Node trust store (custom CAs come from
 * `NODE_EXTRA_CA_CERTS`). No runtime path disables certificate verification — there is no
 * insecure fallback.
 */
export const buildPgClientConfig = (databaseUrl: string): ClientConfig => ({
  connectionString: stripTlsDirectives(databaseUrl),
  connectionTimeoutMillis: DEFAULT_CONNECT_TIMEOUT_MS,
  // Read-only is also requested at startup; poolers may drop startup options, so every
  // read additionally runs inside an explicit READ ONLY transaction that is rolled back.
  options: READ_ONLY_STARTUP_OPTIONS,
  application_name: 'deploytruth-readonly',
  ssl: { rejectUnauthorized: true },
});

const createPgClient: ClientFactory = (databaseUrl) =>
  new pg.Client(buildPgClientConfig(databaseUrl));

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
      // The endpoint-derived ref is connection-target evidence: it reports where the URL
      // points whether or not a session is ever established.
      const target = deriveProjectIdentity(databaseUrl);
      const targetEvidence =
        target === undefined
          ? {}
          : { targetProjectRef: target.projectRef, identitySource: target.source };
      if (resolveTlsPolicy(databaseUrl).state === 'insecure') {
        return {
          state: 'unavailable',
          reason: 'insecure_tls_configuration',
          detail: detailFor('insecure_tls_configuration'),
          ...targetEvidence,
        };
      }
      try {
        await withReadOnlySession(makeClient(databaseUrl), async (client) => {
          await client.query(IDENTITY_PROBE_SQL);
        });
      } catch (error) {
        const reason = normalizeDatabaseError(error);
        return { state: 'unavailable', reason, detail: detailFor(reason), ...targetEvidence };
      }
      // Only now does the endpoint-derived ref become observed identity: a verified,
      // encrypted session actually reached a database behind this endpoint.
      return {
        state: 'available',
        ...targetEvidence,
        ...(target !== undefined ? { observedProjectRef: target.projectRef } : {}),
      };
    },

    readMigrationHistory: async (): Promise<MigrationHistoryResult> => {
      if (!isPostgresUrl(databaseUrl) || resolveTlsPolicy(databaseUrl).state === 'insecure') {
        // Defense in depth: callers gate history on a successful identity probe, but the
        // reader itself never opens a plaintext or unverified session either.
        return {
          state: 'unavailable',
          reason: 'connection_unavailable',
          detail: 'No verified-TLS database session can be established from the configured URL.',
          appliedVersions: [],
        };
      }
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
