import {
  createPgDatabaseReader,
  deriveProjectIdentity,
  normalizeDatabaseError,
  parseMigrationRows,
  resolveSupabaseDatabaseCredential,
  resolveSupabaseManagementCredential,
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
