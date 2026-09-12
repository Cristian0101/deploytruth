import {
  buildPgClientConfig,
  createPgDatabaseReader,
  deriveProjectIdentity,
  normalizeDatabaseError,
  parseMigrationRows,
  resolveSupabaseDatabaseCredential,
  resolveSupabaseManagementCredential,
  resolveTlsPolicy,
} from '@deploytruth/providers';
import { describe, expect, it } from 'vitest';

const REF = 'abcdefghij1234567890ab';

describe('deriveProjectIdentity', () => {
  it.each([
    [`postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`, 'direct'],
    [`postgres://postgres:pw@db.${REF}.supabase.co/postgres`, 'direct'],
    [`postgresql://postgres:pw@db.${REF}.supabase.co:6543/postgres`, 'dedicated pooler'],
  ])('derives the project ref from a %s endpoint', (url) => {
    const identity = deriveProjectIdentity(url);

    expect(identity?.projectRef).toBe(REF);
    expect(identity?.source).toBe('direct_host');
  });

  it.each([
    [`postgresql://postgres.${REF}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`],
    [`postgresql://postgres.${REF}:pw@aws-1-eu-west-2.pooler.supabase.com:6543/postgres`],
  ])('derives the project ref from the pooler username in %s', (url) => {
    const identity = deriveProjectIdentity(url);

    expect(identity?.projectRef).toBe(REF);
    expect(identity?.source).toBe('pooler_username');
  });

  it.each([
    'postgresql://postgres:pw@localhost:5432/postgres',
    'postgresql://postgres:pw@db.example.com:5432/postgres',
    `postgresql://postgres:pw@${REF}.supabase.co:5432/postgres`,
    `postgresql://postgres:pw@db.${REF}.supabase.co.evil.example.com:5432/postgres`,
    `postgresql://postgres:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,
    `postgresql://user.${REF}:pw@otherpooler.example.com:5432/postgres`,
    'not-a-url',
    'mysql://user:pw@db.example.com/mysql',
  ])('refuses to guess identity for %s', (url) => {
    expect(deriveProjectIdentity(url)).toBeUndefined();
  });

  it('derives nothing from a credential-bearing URL on an unrecognized host', () => {
    // The result is undefined — there is no object that could carry the password.
    expect(
      deriveProjectIdentity(
        'postgresql://postgres:SUPER-SECRET-PASSWORD@db.unknown.example.com:5432/postgres',
      ),
    ).toBeUndefined();
  });
});

describe('normalizeDatabaseError', () => {
  it.each([
    [{ code: '28P01' }, 'authentication_failed'],
    [{ code: '28000' }, 'authentication_failed'],
    [{ code: '3D000' }, 'database_unavailable'],
    [{ code: 'ECONNREFUSED' }, 'connection_failed'],
    [{ code: 'ENOTFOUND' }, 'connection_failed'],
    [{ code: 'ETIMEDOUT' }, 'timeout'],
    [{ code: 'SELF_SIGNED_CERT_IN_CHAIN' }, 'tls_error'],
    [{ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, 'tls_error'],
    [new Error('anything'), 'connection_failed'],
  ])('maps %j to %s', (error, expected) => {
    expect(normalizeDatabaseError(error)).toBe(expected);
  });
});

describe('parseMigrationRows', () => {
  it('extracts and sorts version strings', () => {
    expect(
      parseMigrationRows([
        { version: '20240102000000' },
        { version: '20240101000000' },
        { version: 'r_refresh_views' },
      ]),
    ).toEqual(['20240101000000', '20240102000000', 'r_refresh_views']);
  });

  it('accepts an empty history as zero applied migrations', () => {
    expect(parseMigrationRows([])).toEqual([]);
  });

  it.each([
    [[{ version: 123 }]],
    [[{ version: '' }]],
    [[{ name: 'no-version-field' }]],
    [['not-an-object']],
  ])('rejects malformed rows %j', (rows) => {
    expect(parseMigrationRows(rows)).toBeUndefined();
  });
});

describe('createPgDatabaseReader with an injected client', () => {
  const queries: string[] = [];
  const fakeClient = (behavior: (sql: string) => { rows: unknown[] } | Error) => ({
    connect: async () => undefined,
    query: async (text: string) => {
      queries.push(text);
      const result = behavior(text);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
    end: async () => undefined,
  });

  it('derives identity from the URL and proves the session with a read-only probe', async () => {
    queries.length = 0;
    const reader = createPgDatabaseReader(
      `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`,
      {
        clientFactory: () => fakeClient(() => ({ rows: [{ database_name: 'postgres' }] })),
      },
    );

    const result = await reader.inspectIdentity();

    expect(result.state).toBe('available');
    expect(result.observedProjectRef).toBe(REF);
    expect(result.identitySource).toBe('direct_host');
    expect(queries[0]).toBe('START TRANSACTION READ ONLY');
    expect(queries.at(-1)).toBe('ROLLBACK');
  });

  it('reads migration history with exactly the allowlisted SELECT', async () => {
    queries.length = 0;
    const reader = createPgDatabaseReader(
      `postgresql://postgres.${REF}:pw@aws-0-r.pooler.supabase.com:5432/postgres`,
      {
        clientFactory: () =>
          fakeClient((sql) =>
            sql.includes('schema_migrations')
              ? { rows: [{ version: '20240101000000' }, { version: '20240102000000' }] }
              : { rows: [] },
          ),
      },
    );

    const result = await reader.readMigrationHistory();

    expect(result.state).toBe('available');
    expect(result.appliedVersions).toEqual(['20240101000000', '20240102000000']);
    const migrationQueries = queries.filter((sql) => sql.includes('schema_migrations'));
    expect(migrationQueries).toEqual([
      'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version ASC',
    ]);
    expect(queries[0]).toBe('START TRANSACTION READ ONLY');
    expect(queries.at(-1)).toBe('ROLLBACK');
  });

  it('reports history_table_missing for an undefined-table error (42P01)', async () => {
    const reader = createPgDatabaseReader(
      `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`,
      {
        clientFactory: () =>
          fakeClient((sql) =>
            sql.includes('schema_migrations')
              ? Object.assign(new Error('relation does not exist'), { code: '42P01' })
              : { rows: [] },
          ),
      },
    );

    const result = await reader.readMigrationHistory();

    expect(result.state).toBe('unavailable');
    expect(result.reason).toBe('history_table_missing');
    expect(result.appliedVersions).toEqual([]);
  });

  it('reports history_query_failed for other SQL errors without leaking messages', async () => {
    const reader = createPgDatabaseReader(
      `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`,
      {
        clientFactory: () =>
          fakeClient((sql) =>
            sql.includes('schema_migrations')
              ? Object.assign(new Error('password leaked detail'), { code: '42501' })
              : { rows: [] },
          ),
      },
    );

    const result = await reader.readMigrationHistory();

    expect(result.reason).toBe('history_query_failed');
    expect(JSON.stringify(result)).not.toContain('password leaked detail');
  });

  it('normalizes a connection failure without leaking driver messages', async () => {
    const reader = createPgDatabaseReader(
      `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`,
      {
        clientFactory: () => ({
          connect: async () => {
            throw Object.assign(new Error('connect ECONNREFUSED password=x'), {
              code: 'ECONNREFUSED',
            });
          },
          query: async () => ({ rows: [] }),
          end: async () => undefined,
        }),
      },
    );

    const result = await reader.inspectIdentity();

    expect(result.state).toBe('unavailable');
    expect(result.reason).toBe('connection_failed');
    expect(JSON.stringify(result)).not.toContain('password=x');
  });

  it('rejects a non-postgres URL before connecting', async () => {
    let connected = false;
    const reader = createPgDatabaseReader('mysql://user:pw@host/db', {
      clientFactory: () => ({
        connect: async () => {
          connected = true;
        },
        query: async () => ({ rows: [] }),
        end: async () => undefined,
      }),
    });

    const result = await reader.inspectIdentity();

    expect(connected).toBe(false);
    expect(result.reason).toBe('invalid_url');
  });
});

describe('TLS policy', () => {
  it('enables certificate verification when the URL carries no sslmode', () => {
    const config = buildPgClientConfig(
      `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`,
    );

    expect(config.ssl).toEqual({ rejectUnauthorized: true });
  });

  it.each([
    [
      'direct endpoint, no directive',
      `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`,
    ],
    [
      'direct endpoint, sslmode=require',
      `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres?sslmode=require`,
    ],
    [
      'direct endpoint, sslmode=verify-ca',
      `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres?sslmode=verify-ca`,
    ],
    [
      'direct endpoint, sslmode=verify-full',
      `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres?sslmode=verify-full`,
    ],
    [
      'dedicated pooler endpoint',
      `postgresql://postgres:pw@db.${REF}.supabase.co:6543/postgres?sslmode=require`,
    ],
    [
      'shared pooler endpoint',
      `postgresql://postgres.${REF}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,
    ],
    [
      'shared pooler endpoint, sslmode=require',
      `postgresql://postgres.${REF}:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require`,
    ],
    [
      'shared pooler endpoint, sslmode=verify-full',
      `postgresql://postgres.${REF}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full`,
    ],
    ['ssl=1', `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres?ssl=1`],
    ['ssl=true', `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres?ssl=true`],
  ])('enforces verified TLS for the %s configuration', (_label, url) => {
    expect(resolveTlsPolicy(url)).toEqual({ state: 'verified' });
    expect(buildPgClientConfig(url).ssl).toEqual({ rejectUnauthorized: true });
  });

  it.each([
    'sslmode=disable',
    'sslmode=allow',
    'sslmode=prefer',
    'sslmode=no-verify',
    'sslmode=bogus',
    'sslmode=',
    'ssl=0',
    'ssl=false',
    'ssl=no-verify',
    'ssl=',
    'uselibpqcompat=true',
    'uselibpqcompat=true&sslmode=require',
    'uselibpqcompat=true&sslmode=verify-full',
    'sslrootcert=/etc/ssl/ca.pem',
    'sslcert=/etc/ssl/client.crt',
    'sslkey=/etc/ssl/client.key',
    'sslcrl=/etc/ssl/revocations.crl',
  ])('fails closed on insecure TLS directive ?%s', (directive) => {
    const url = `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres?${directive}`;

    expect(resolveTlsPolicy(url)).toEqual({ state: 'insecure' });
  });

  it('strips every TLS directive before the driver parses the connection string', () => {
    const config = buildPgClientConfig(
      `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres?sslmode=require&uselibpqcompat=false&sslrootcert=/tmp/ca.pem&keepalives=1`,
    );

    expect(config.connectionString).not.toMatch(
      /sslmode|uselibpqcompat|sslrootcert|sslcert|sslkey|sslcrl|sslpassword|ssl=/i,
    );
    expect(config.connectionString).toContain('keepalives=1');
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
  });
});

describe('fail-closed TLS enforcement', () => {
  it.each([
    'sslmode=disable',
    'sslmode=prefer',
    'sslmode=no-verify',
    'uselibpqcompat=true&sslmode=require',
    'sslrootcert=/etc/ssl/ca.pem',
  ])('makes no connection attempt for ?%s', async (directive) => {
    let clientBuilt = false;
    const reader = createPgDatabaseReader(
      `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres?${directive}`,
      {
        clientFactory: () => {
          clientBuilt = true;
          return {
            connect: async () => undefined,
            query: async () => ({ rows: [] }),
            end: async () => undefined,
          };
        },
      },
    );

    const result = await reader.inspectIdentity();

    expect(clientBuilt).toBe(false);
    expect(result.state).toBe('unavailable');
    expect(result.reason).toBe('insecure_tls_configuration');
  });

  it('refuses insecure TLS without producing an observed identity', async () => {
    const reader = createPgDatabaseReader(
      `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres?sslmode=disable`,
      {
        clientFactory: () => ({
          connect: async () => undefined,
          query: async () => ({ rows: [] }),
          end: async () => undefined,
        }),
      },
    );

    const result = await reader.inspectIdentity();

    // The endpoint-derived ref is reported as connection-target evidence only.
    expect(result.observedProjectRef).toBeUndefined();
    expect(result.targetProjectRef).toBe(REF);
    expect(result.identitySource).toBe('direct_host');
  });

  it('never opens a session for migration history when the TLS configuration is insecure', async () => {
    let clientBuilt = false;
    const reader = createPgDatabaseReader(
      `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres?sslmode=disable`,
      {
        clientFactory: () => {
          clientBuilt = true;
          return {
            connect: async () => undefined,
            query: async () => ({ rows: [] }),
            end: async () => undefined,
          };
        },
      },
    );

    const result = await reader.readMigrationHistory();

    expect(clientBuilt).toBe(false);
    expect(result.state).toBe('unavailable');
    expect(result.reason).toBe('connection_unavailable');
  });

  it.each([
    'CERT_HAS_EXPIRED',
    'CERT_NOT_YET_VALID',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'ERR_TLS_CERT_ALTNAME_INVALID',
  ])('normalizes certificate verification failure %s to tls_error', async (code) => {
    const reader = createPgDatabaseReader(
      `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`,
      {
        clientFactory: () => ({
          connect: async () => {
            throw Object.assign(new Error('certificate has expired for db host'), { code });
          },
          query: async () => ({ rows: [] }),
          end: async () => undefined,
        }),
      },
    );

    const result = await reader.inspectIdentity();

    expect(result.state).toBe('unavailable');
    expect(result.reason).toBe('tls_error');
    expect(JSON.stringify(result)).not.toContain('certificate has expired for db host');
  });

  it('cannot leak the connection URL, password, or raw TLS driver error text', async () => {
    const secret = 's3cret-database-password';
    const databaseUrl = `postgresql://postgres:${secret}@db.${REF}.supabase.co:5432/postgres`;
    const reader = createPgDatabaseReader(databaseUrl, {
      clientFactory: () => ({
        connect: async () => {
          throw new Error(
            `tls handshake failed for ${databaseUrl}: self-signed cert blob -----BEGIN CERTIFICATE-----`,
          );
        },
        query: async () => ({ rows: [] }),
        end: async () => undefined,
      }),
    });

    const result = await reader.inspectIdentity();
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(databaseUrl);
    expect(serialized).not.toContain('tls handshake failed for');
    expect(serialized).not.toContain('CERTIFICATE');
  });
});

describe('credential resolution', () => {
  it('prefers DEPLOYTRUTH_SUPABASE_ACCESS_TOKEN over SUPABASE_ACCESS_TOKEN', () => {
    const credential = resolveSupabaseManagementCredential({
      DEPLOYTRUTH_SUPABASE_ACCESS_TOKEN: 'token-a',
      SUPABASE_ACCESS_TOKEN: 'token-b',
    });

    expect(credential?.variable).toBe('DEPLOYTRUTH_SUPABASE_ACCESS_TOKEN');
    expect(credential?.token).toBe('token-a');
  });

  it('falls back to SUPABASE_ACCESS_TOKEN', () => {
    const credential = resolveSupabaseManagementCredential({
      SUPABASE_ACCESS_TOKEN: 'token-b',
    });

    expect(credential?.variable).toBe('SUPABASE_ACCESS_TOKEN');
  });

  it('never falls back to a generic DATABASE_URL', () => {
    const credential = resolveSupabaseDatabaseCredential({
      DATABASE_URL: 'postgresql://postgres:pw@db.evil.example.com:5432/postgres',
    });

    expect(credential).toBeUndefined();
  });

  it('reads DEPLOYTRUTH_SUPABASE_DATABASE_URL', () => {
    const credential = resolveSupabaseDatabaseCredential({
      DEPLOYTRUTH_SUPABASE_DATABASE_URL: 'postgresql://postgres:pw@db.x.supabase.co:5432/postgres',
    });

    expect(credential?.variable).toBe('DEPLOYTRUTH_SUPABASE_DATABASE_URL');
  });
});
