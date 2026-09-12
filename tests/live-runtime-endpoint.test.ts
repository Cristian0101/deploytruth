import { afterEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error The live acceptance reference endpoint is intentionally plain ESM JavaScript.
import runtimeHandler from '../examples/live-acceptance/api/deploytruth/runtime.js';
// @ts-expect-error The backwards-compatible version endpoint is intentionally plain ESM JavaScript.
import versionHandler from '../examples/live-acceptance/api/version.js';

const NONCE = 'n'.repeat(43);
const SHA = 'a'.repeat(40);
const PROJECT_A = 'wxzqzkkuozujicoywcur';
const PROJECT_B = 'abcdefghijklmnopqrst';
const PUBLISHABLE_KEY = 'sb_publishable_fixture_never_real';

interface MockResponse {
  readonly headers: Record<string, string>;
  statusCode?: number;
  body?: unknown;
  setHeader(name: string, value: string): void;
  status(code: number): MockResponse;
  json(body: unknown): MockResponse;
}

const response = (): MockResponse => {
  const value: MockResponse = {
    headers: {},
    setHeader(name, headerValue) {
      value.headers[name.toLowerCase()] = headerValue;
    },
    status(code) {
      value.statusCode = code;
      return value;
    },
    json(body) {
      value.body = body;
      return value;
    },
  };
  return value;
};

const request = (method = 'GET', nonce: string | undefined = NONCE) => ({
  method,
  query: nonce === undefined ? {} : { nonce },
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('live acceptance runtime endpoint', () => {
  it('returns a public-safe strict attestation and performs only the documented settings GET', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', SHA);
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('SUPABASE_URL', `https://${PROJECT_A}.supabase.co`);
    vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', PUBLISHABLE_KEY);
    const fetchMock = vi.fn(
      async () =>
        new Response('{"external":{}}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = response();

    await runtimeHandler(request(), result);

    expect(result.statusCode).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.headers['pragma']).toBe('no-cache');
    expect(result.body).toEqual({
      version: 1,
      nonce: NONCE,
      commit: SHA,
      environment: 'preview',
      environmentVariables: {
        SUPABASE_URL: true,
        SUPABASE_PUBLISHABLE_KEY: true,
      },
      connections: {
        database: {
          provider: 'supabase',
          targetProjectRef: PROJECT_A,
          identity: 'verified',
          status: 'connected',
        },
      },
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { readonly method: string; readonly headers: Record<string, string> },
    ];
    expect(url).toBe(`https://${PROJECT_A}.supabase.co/auth/v1/settings`);
    expect(init.method).toBe('GET');
    expect(init.headers['apikey']).toBe(PUBLISHABLE_KEY);
    expect(JSON.stringify(result.body)).not.toContain(PUBLISHABLE_KEY);
    expect(JSON.stringify(result.body)).not.toContain(`https://${PROJECT_A}.supabase.co`);
  });

  it('derives identity from SUPABASE_URL and ignores a disagreeing project-ref variable', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', SHA);
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('SUPABASE_URL', `https://${PROJECT_A}.supabase.co`);
    vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', PUBLISHABLE_KEY);
    vi.stubEnv('SUPABASE_PROJECT_REF', PROJECT_B);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );
    const result = response();

    await runtimeHandler(request(), result);

    expect(
      (result.body as { connections: { database: { targetProjectRef: string } } }).connections
        .database.targetProjectRef,
    ).toBe(PROJECT_A);
    expect(JSON.stringify(result.body)).not.toContain(PROJECT_B);
  });

  it('reports missing publishable configuration without attempting a probe', async () => {
    vi.stubEnv('SUPABASE_URL', `https://${PROJECT_A}.supabase.co`);
    vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = response();

    await runtimeHandler(request(), result);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.body).toMatchObject({
      environmentVariables: { SUPABASE_URL: true, SUPABASE_PUBLISHABLE_KEY: false },
      connections: {
        database: {
          targetProjectRef: PROJECT_A,
          identity: 'verified',
          status: 'unavailable',
          reason: 'missing_configuration',
        },
      },
    });
  });

  it('keeps custom endpoints identity-unverified even when the GET probe succeeds', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://database.example.com');
    vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', PUBLISHABLE_KEY);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );
    const result = response();

    await runtimeHandler(request(), result);

    expect(result.body).toMatchObject({
      connections: {
        database: {
          provider: 'supabase',
          identity: 'unverified',
          status: 'connected',
          reason: 'identity_unverified',
        },
      },
    });
  });

  it('normalizes a rejected publishable key without returning the provider body', async () => {
    const providerSecret = 'provider-error-body-never-escape';
    vi.stubEnv('SUPABASE_URL', `https://${PROJECT_A}.supabase.co`);
    vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', PUBLISHABLE_KEY);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(providerSecret, { status: 401 })),
    );
    const result = response();

    await runtimeHandler(request(), result);

    expect(result.body).toMatchObject({
      connections: {
        database: { status: 'unavailable', reason: 'credentials_rejected' },
      },
    });
    expect(JSON.stringify(result.body)).not.toContain(providerSecret);
  });

  it('normalizes TLS failure without returning raw fetch error text', async () => {
    vi.stubEnv('SUPABASE_URL', `https://${PROJECT_A}.supabase.co`);
    vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', PUBLISHABLE_KEY);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const error = new Error('certificate detail must not escape');
        Object.assign(error, { cause: { code: 'CERT_HAS_EXPIRED' } });
        throw error;
      }),
    );
    const result = response();

    await runtimeHandler(request(), result);

    expect(result.body).toMatchObject({
      connections: { database: { status: 'unavailable', reason: 'tls_error' } },
    });
    expect(JSON.stringify(result.body)).not.toContain('certificate detail');
  });

  it('requires a bounded nonce and rejects non-GET methods', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const missing = response();
    const wrongMethod = response();

    await runtimeHandler({ method: 'GET', query: {} }, missing);
    await runtimeHandler(request('POST'), wrongMethod);

    expect(missing.statusCode).toBe(400);
    expect(missing.body).toEqual({ error: 'invalid_nonce' });
    expect(wrongMethod.statusCode).toBe(405);
    expect(wrongMethod.headers['allow']).toBe('GET');
  });

  it('preserves the backwards-compatible version endpoint behavior', () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', SHA);
    vi.stubEnv('VERCEL_ENV', 'production');
    const result = response();
    versionHandler(request(), result);
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ commit: SHA, environment: 'production' });
  });
});
