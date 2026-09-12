import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  TransportError,
  createVercelTransport,
  resolveVercelCredential,
} from '@deploytruth/providers';
import { describe, expect, it, vi } from 'vitest';

const read = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), relativePath), 'utf8');

const jsonResponse = (
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.headers ?? {},
  });

/** Minimal fetch-init shape the mocks consume; keeps DOM-only types out of the test file. */
type FetchInit = {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  method?: string;
};

describe('Vercel read-only transport', () => {
  it('issues GET requests only', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    const transport = createVercelTransport({ fetchImplementation: fetchMock });

    await transport.get({ url: 'https://api.vercel.test/v9/projects/example' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, FetchInit];
    expect(init.method).toBe('GET');
  });

  it('never exposes a mutation-capable API in its own implementation', () => {
    const source = [
      read('packages/providers/src/vercel/transport.ts'),
      read('packages/providers/src/vercel/adapter.ts'),
      read('packages/providers/src/vercel/credentials.ts'),
      read('packages/providers/src/readonly-fetch.ts'),
    ].join('\n');

    expect(source).not.toMatch(/method:\s*['"`](POST|PUT|PATCH|DELETE)['"`]/i);
    expect(source).not.toMatch(/\bpost\b|\bput\b|\bpatch\b|\bdelete\b/i);
  });

  it('attaches the token as a Bearer header without leaking it into responses or errors', async () => {
    const token = 'vercel_testtoken_000000000000000000';
    let observedAuthorization: string | undefined;
    const fetchMock = vi.fn(async (_url: string, init?: FetchInit) => {
      observedAuthorization = init?.headers?.['authorization'];
      return jsonResponse({ id: 'prj_x' });
    });
    const transport = createVercelTransport({ token, fetchImplementation: fetchMock });

    const response = await transport.get({ url: 'https://api.vercel.test/v9/projects/a' });

    expect(observedAuthorization).toBe(`Bearer ${token}`);
    // The response handed back to adapters carries no credential material.
    expect(JSON.stringify(response)).not.toContain(token);
  });

  it('normalizes a rejected fetch into NETWORK_ERROR without request internals', async () => {
    const token = 'vercel_testtoken_000000000000000000';
    const fetchMock = vi.fn(async () => {
      throw new Error(`socket hangup authorization: Bearer ${token}`);
    });
    const transport = createVercelTransport({ token, fetchImplementation: fetchMock });

    const failure = await transport.get({ url: 'https://api.vercel.test/v9/projects/a' }).then(
      () => ({ caught: undefined as TransportError | undefined }),
      (caught: TransportError) => ({ caught }),
    );

    expect(failure.caught).toBeInstanceOf(TransportError);
    expect(failure.caught?.code).toBe('NETWORK_ERROR');
    expect(failure.caught?.message).not.toContain(token);
    expect(failure.caught?.message).not.toContain('Bearer');
  });

  it('maps an internal timeout to TIMEOUT', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: FetchInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const transport = createVercelTransport({ fetchImplementation: fetchMock, timeoutMs: 15 });

    await expect(
      transport.get({ url: 'https://api.vercel.test/v9/projects/a' }),
    ).rejects.toMatchObject({ name: 'TransportError', code: 'TIMEOUT' });
  });

  it('maps a caller abort to ABORTED', async () => {
    const fetchMock = vi.fn((_url: string, init?: FetchInit) => {
      if (init?.signal?.aborted === true) {
        return Promise.reject(new Error('aborted'));
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const transport = createVercelTransport({ fetchImplementation: fetchMock, timeoutMs: 60_000 });
    const controller = new AbortController();
    controller.abort();

    await expect(
      transport.get({ url: 'https://api.vercel.test/v9/projects/a', signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

describe('Vercel credential resolution', () => {
  const token = 'vercel_testtoken_000000000000000000';

  it('prefers DEPLOYTRUTH_VERCEL_TOKEN over VERCEL_TOKEN', () => {
    const credential = resolveVercelCredential({
      DEPLOYTRUTH_VERCEL_TOKEN: token,
      VERCEL_TOKEN: 'vercel_other_000000000000000000',
    });

    expect(credential?.variable).toBe('DEPLOYTRUTH_VERCEL_TOKEN');
    expect(credential?.token).toBe(token);
  });

  it('falls back to VERCEL_TOKEN', () => {
    const credential = resolveVercelCredential({ VERCEL_TOKEN: token });

    expect(credential?.variable).toBe('VERCEL_TOKEN');
  });

  it('returns undefined when neither variable is usable', () => {
    expect(resolveVercelCredential({})).toBeUndefined();
    expect(
      resolveVercelCredential({ DEPLOYTRUTH_VERCEL_TOKEN: '   ', VERCEL_TOKEN: '' }),
    ).toBeUndefined();
  });
});
