import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  createGitHubTransport,
  resolveGitHubCredential,
  TransportError,
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

describe('GitHub read-only transport', () => {
  it('issues GET requests only', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    const transport = createGitHubTransport({ fetchImplementation: fetchMock });

    await transport.get({ url: 'https://api.github.test/repos/acme/meridia' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, FetchInit];
    expect(init.method).toBe('GET');
  });

  it('never exposes a mutation-capable API in its own implementation', () => {
    const source = [
      read('packages/providers/src/github/transport.ts'),
      read('packages/providers/src/github/adapter.ts'),
      read('packages/providers/src/github/credentials.ts'),
    ].join('\n');

    expect(source).not.toMatch(/method:\s*['"`](POST|PUT|PATCH|DELETE)['"`]/i);
    expect(source).not.toMatch(/\bpost\b|\bput\b|\bpatch\b|\bdelete\b/);
  });

  it('attaches the token as a Bearer header without leaking it into responses or errors', async () => {
    const token = 'ghp_testtoken_0000000000000000000000';
    let observedAuthorization: string | undefined;
    const fetchMock = vi.fn(async (_url: string, init?: FetchInit) => {
      observedAuthorization = init?.headers?.['authorization'];
      return jsonResponse({ default_branch: 'main' });
    });
    const transport = createGitHubTransport({ token, fetchImplementation: fetchMock });

    const response = await transport.get({ url: 'https://api.github.test/repos/a/b' });

    expect(observedAuthorization).toBe(`Bearer ${token}`);
    // The response handed back to adapters carries no credential material.
    expect(JSON.stringify(response)).not.toContain(token);
  });

  it('sends no Authorization header without a token', async () => {
    let headers: Record<string, string> = {};
    const fetchMock = vi.fn(async (_url: string, init?: FetchInit) => {
      headers = { ...init?.headers };
      return jsonResponse({});
    });
    const transport = createGitHubTransport({ fetchImplementation: fetchMock });

    await transport.get({ url: 'https://api.github.test/repos/a/b' });

    expect(Object.keys(headers)).not.toContain('authorization');
  });

  it('normalizes a rejected fetch into NETWORK_ERROR without request internals', async () => {
    const token = 'ghp_testtoken_0000000000000000000000';
    const fetchMock = vi.fn(async () => {
      throw new Error(`socket hangup authorization: Bearer ${token}`);
    });
    const transport = createGitHubTransport({ token, fetchImplementation: fetchMock });

    const failure = await transport.get({ url: 'https://api.github.test/repos/a/b' }).then(
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
    const transport = createGitHubTransport({ fetchImplementation: fetchMock, timeoutMs: 15 });

    await expect(transport.get({ url: 'https://api.github.test/repos/a/b' })).rejects.toMatchObject(
      { name: 'TransportError', code: 'TIMEOUT' },
    );
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
    const transport = createGitHubTransport({ fetchImplementation: fetchMock, timeoutMs: 60_000 });
    const controller = new AbortController();
    controller.abort();

    await expect(
      transport.get({ url: 'https://api.github.test/repos/a/b', signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('normalizes response headers and leaves unparseable bodies undefined', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('not-json', {
          status: 200,
          headers: { 'x-ratelimit-remaining': '42' },
        }),
    );
    const transport = createGitHubTransport({ fetchImplementation: fetchMock });

    const response = await transport.get({ url: 'https://api.github.test/x' });

    expect(response.status).toBe(200);
    expect(response.headers['x-ratelimit-remaining']).toBe('42');
    expect(response.body).toBeUndefined();
  });
});

describe('GitHub credential resolution', () => {
  const token = 'ghp_testtoken_0000000000000000000000';

  it('prefers DEPLOYTRUTH_GITHUB_TOKEN over GITHUB_TOKEN', () => {
    const credential = resolveGitHubCredential({
      DEPLOYTRUTH_GITHUB_TOKEN: token,
      GITHUB_TOKEN: 'ghp_other_000000000000000000000000',
    });

    expect(credential?.variable).toBe('DEPLOYTRUTH_GITHUB_TOKEN');
    expect(credential?.token).toBe(token);
  });

  it('falls back to GITHUB_TOKEN', () => {
    const credential = resolveGitHubCredential({ GITHUB_TOKEN: token });

    expect(credential?.variable).toBe('GITHUB_TOKEN');
  });

  it('returns undefined when neither variable is usable', () => {
    expect(resolveGitHubCredential({})).toBeUndefined();
    expect(
      resolveGitHubCredential({ DEPLOYTRUTH_GITHUB_TOKEN: '   ', GITHUB_TOKEN: '' }),
    ).toBeUndefined();
  });
});
