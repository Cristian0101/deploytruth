import { createRuntimeTransport } from '@deploytruth/providers';
import type { RuntimeTransportError } from '@deploytruth/providers';
import { describe, expect, it, vi } from 'vitest';

type FetchInit = {
  readonly method?: string;
  readonly redirect?: string;
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
};

const jsonResponse = (
  body: unknown,
  init: { readonly status?: number; readonly headers?: Readonly<Record<string, string>> } = {},
): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

describe('runtime attestation transport', () => {
  it('uses GET, refuses automatic redirects, and asks for JSON', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ version: 1 }));
    const transport = createRuntimeTransport({ fetchImplementation: fetchMock });

    await transport.get({ url: 'https://runtime.example.test/attest' });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, FetchInit];
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('manual');
    expect(init.headers?.['accept']).toBe('application/json');
  });

  it('allows HTTP only on localhost and 127.0.0.1', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    const transport = createRuntimeTransport({ fetchImplementation: fetchMock });

    await transport.get({ url: 'http://localhost:3000/attest' });
    await transport.get({ url: 'http://127.0.0.1:3000/attest' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['http://runtime.example.test/attest', 'ftp://localhost/attest'])(
    'rejects insecure URL %s before any request',
    async (url) => {
      const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
      const transport = createRuntimeTransport({ fetchImplementation: fetchMock });

      await expect(transport.get({ url })).rejects.toMatchObject({ code: 'INSECURE_URL' });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('rejects URLs containing credentials', async () => {
    const transport = createRuntimeTransport({ fetchImplementation: vi.fn() });
    await expect(
      transport.get({ url: 'https://user:password@runtime.example.test/attest' }),
    ).rejects.toMatchObject({ code: 'INSECURE_URL' });
  });

  it('normalizes network failures without raw error text', async () => {
    const secret = 'sb_secret_never_escape';
    const transport = createRuntimeTransport({
      fetchImplementation: vi.fn(async () => {
        throw new Error(`socket failed ${secret}`);
      }),
    });

    const error = await transport.get({ url: 'https://runtime.example.test/attest' }).then(
      () => undefined,
      (caught: RuntimeTransportError) => caught,
    );
    expect(error?.code).toBe('NETWORK_ERROR');
    expect(error?.message).not.toContain(secret);
  });

  it('maps an internal timeout without leaking request details', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: FetchInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('timed out')));
        }),
    );
    const transport = createRuntimeTransport({ fetchImplementation: fetchMock, timeoutMs: 10 });

    await expect(
      transport.get({ url: 'https://runtime.example.test/attest' }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('distinguishes a caller abort', async () => {
    const fetchMock = vi.fn((_url: string, init?: FetchInit) => {
      if (init?.signal?.aborted) {
        return Promise.reject(new Error('aborted'));
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const transport = createRuntimeTransport({ fetchImplementation: fetchMock });
    const controller = new AbortController();
    controller.abort();

    await expect(
      transport.get({
        url: 'https://runtime.example.test/attest',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('rejects redirects instead of following another origin', async () => {
    const transport = createRuntimeTransport({
      fetchImplementation: vi.fn(async () =>
        jsonResponse({}, { status: 302, headers: { location: 'https://other.test/' } }),
      ),
    });
    await expect(
      transport.get({ url: 'https://runtime.example.test/attest' }),
    ).rejects.toMatchObject({ code: 'REDIRECT_REJECTED' });
  });

  it('discards non-200 bodies and exposes only safe response headers', async () => {
    const secret = 'service-role-value-never-escape';
    const transport = createRuntimeTransport({
      fetchImplementation: vi.fn(async () =>
        jsonResponse(
          { secret },
          {
            status: 503,
            headers: {
              authorization: `Bearer ${secret}`,
              'set-cookie': `token=${secret}`,
              'cache-control': 'no-store',
            },
          },
        ),
      ),
    });

    const result = await transport.get({ url: 'https://runtime.example.test/attest' });
    expect(result.status).toBe(503);
    expect(result.body).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.headers).toEqual({
      'cache-control': 'no-store',
      'content-type': 'application/json',
    });
  });

  it('rejects a successful response with the wrong content type', async () => {
    const transport = createRuntimeTransport({
      fetchImplementation: vi.fn(
        async () => new Response('{}', { status: 200, headers: { 'content-type': 'text/plain' } }),
      ),
    });
    await expect(
      transport.get({ url: 'https://runtime.example.test/attest' }),
    ).rejects.toMatchObject({ code: 'WRONG_CONTENT_TYPE' });
  });

  it('rejects malformed JSON without returning the raw body', async () => {
    const secret = 'raw-secret-body';
    const transport = createRuntimeTransport({
      fetchImplementation: vi.fn(
        async () =>
          new Response(`not-json-${secret}`, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    });
    const error = await transport.get({ url: 'https://runtime.example.test/attest' }).then(
      () => undefined,
      (caught: RuntimeTransportError) => caught,
    );
    expect(error?.code).toBe('MALFORMED_RESPONSE');
    expect(error?.message).not.toContain(secret);
  });

  it('rejects an oversized declared response before parsing', async () => {
    const transport = createRuntimeTransport({
      maxResponseBytes: 16,
      fetchImplementation: vi.fn(
        async () =>
          new Response('{"version":1}', {
            status: 200,
            headers: { 'content-type': 'application/json', 'content-length': '999' },
          }),
      ),
    });
    await expect(
      transport.get({ url: 'https://runtime.example.test/attest' }),
    ).rejects.toMatchObject({ code: 'OVERSIZED_RESPONSE' });
  });

  it('rejects a streamed response that crosses the size limit', async () => {
    const transport = createRuntimeTransport({
      maxResponseBytes: 8,
      fetchImplementation: vi.fn(async () => jsonResponse({ long: '0123456789' })),
    });
    await expect(
      transport.get({ url: 'https://runtime.example.test/attest' }),
    ).rejects.toMatchObject({ code: 'OVERSIZED_RESPONSE' });
  });
});
