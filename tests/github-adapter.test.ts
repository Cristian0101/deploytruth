import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { sourceObservationSchema, type SourceObservation } from '@deploytruth/core';
import {
  createGitHubProvider,
  gitHubSourceConfigSchema,
  TransportError,
} from '@deploytruth/providers';
import { describe, expect, it } from 'vitest';

import {
  createFixtureGitHubProvider,
  createStaticTransport,
  gitHubConfig,
  githubRepositoryPayload,
  TEST_BRANCH,
  TEST_REPOSITORY,
} from './github-test-utils.js';

const observeWith = (
  provider: ReturnType<typeof createFixtureGitHubProvider>,
  repository: string = TEST_REPOSITORY,
  branch: string = TEST_BRANCH,
): Promise<SourceObservation> =>
  provider.observe({
    project: 'test-project',
    environment: 'production',
    config: gitHubConfig(repository, branch),
  });

/** Fixture files hold the meaningful normalized fields; defaults come from the schema. */
const loadNormalizedFixture = (name: string): SourceObservation =>
  sourceObservationSchema.parse(
    JSON.parse(readFileSync(resolve(process.cwd(), 'fixtures', 'github', `${name}.json`), 'utf8')),
  );

describe('GitHub adapter configuration', () => {
  it.each(['acme/meridia', 'org-123/app.v2_final', 'a/b'])(
    'accepts valid owner/repo %s',
    (repository) => {
      expect(gitHubSourceConfigSchema.parse({ repository, branch: 'main' }).repository).toBe(
        repository,
      );
    },
  );

  it.each([
    'foo',
    'foo/bar/baz',
    'github.com/foo/bar',
    'https://github.com/foo/bar',
    '-owner/repo',
    'owner-/repo',
    'owner//repo',
    'owner/../repo',
    'owner/.',
  ])('rejects malformed repository %s', (repository) => {
    expect(() => gitHubSourceConfigSchema.parse({ repository, branch: 'main' })).toThrow();
  });

  it.each(['main', 'feature/new-thing', 'release/v1.2'])('accepts branch %s', (branch) => {
    expect(gitHubSourceConfigSchema.parse({ repository: 'a/b', branch }).branch).toBe(branch);
  });

  it.each(['../escape', 'a..b', 'a//b', '/abs', 'trail/', 'dot.', 'white space', 'q?x'])(
    'rejects unsafe branch %s',
    (branch) => {
      expect(() => gitHubSourceConfigSchema.parse({ repository: 'a/b', branch })).toThrow();
    },
  );
});

describe('GitHub adapter observation', () => {
  it('CASE public-healthy: normalizes repository and authoritative branch head', async () => {
    const calls: string[] = [];
    const provider = createFixtureGitHubProvider(
      { remoteSha: 'abc123', repository: 'acme/meridia' },
      calls,
    );

    const observation = await observeWith(provider, 'acme/meridia');

    expect(observation).toMatchObject(loadNormalizedFixture('main-current'));
    expect(observation.remoteHeadSha).toBe('abc123');
    expect(observation.defaultBranch).toBe('main');
    expect(observation.availability?.state).toBe('available');
    // Exactly two GET-shaped requests: repository metadata then branch metadata.
    expect(calls).toEqual(['/repos/acme/meridia', `/repos/acme/meridia/branches/${TEST_BRANCH}`]);
  });

  it('drops raw payload fields the observation does not need', async () => {
    const provider = createFixtureGitHubProvider({ remoteSha: 'abc123' });
    const observation = await observeWith(provider);
    const serialized = JSON.stringify(observation);

    expect(serialized).not.toContain('rawOnlySentinel');
    expect(serialized).not.toContain('ghp_fixture');
    expect(serialized).not.toContain('permissions');
    expect(serialized).not.toContain('owner');
    expect(serialized).not.toContain('api.github.test');
    expect(serialized).not.toContain('Authorization');
  });

  it('CASE private-healthy: reports private visibility for an authenticated private repo', async () => {
    const provider = createFixtureGitHubProvider({
      remoteSha: 'def456',
      repositoryOverrides: { visibility: 'private', private: true },
    });

    const observation = await observeWith(provider);

    expect(observation.visibility).toBe('private');
    expect(observation.remoteHeadSha).toBe('def456');
    expect(observation.availability?.state).toBe('available');
  });

  it('CASE repo-404: reports repository unavailable without claiming non-existence', async () => {
    const provider = createFixtureGitHubProvider({ repositoryStatus: 404 });

    const observation = await observeWith(provider);

    expect(observation.remoteHeadSha).toBeUndefined();
    expect(observation.defaultBranch).toBeUndefined();
    expect(observation.availability).toMatchObject({
      state: 'unavailable',
      target: 'repository',
      reason: 'not_found',
    });
    expect(observation.availability?.detail).not.toContain('does not exist');
    expect(observation.availability?.detail).toContain('absent, renamed, or private');
  });

  it('CASE branch-404: keeps repository facts but reports the branch unavailable', async () => {
    const provider = createFixtureGitHubProvider({ branchStatus: 404 });

    const observation = await observeWith(provider);

    expect(observation.defaultBranch).toBe('main');
    expect(observation.remoteHeadSha).toBeUndefined();
    expect(observation.availability).toMatchObject({
      state: 'unavailable',
      target: 'branch',
      reason: 'not_found',
    });
  });

  it('CASE unauthorized: normalizes 401 without exposing credential detail', async () => {
    const provider = createFixtureGitHubProvider({ repositoryStatus: 401 });

    const observation = await observeWith(provider);

    expect(observation.availability).toMatchObject({
      state: 'unavailable',
      target: 'repository',
      reason: 'unauthorized',
    });
  });

  it('CASE forbidden: normalizes a real 403 separately from rate limiting', async () => {
    const provider = createFixtureGitHubProvider({
      repositoryStatus: 403,
      headers: { 'x-ratelimit-remaining': '4821' },
    });

    const observation = await observeWith(provider);

    expect(observation.availability?.reason).toBe('forbidden');
  });

  it('CASE rate-limited: 403 with an exhausted quota normalizes to rate_limited with reset time', async () => {
    const provider = createFixtureGitHubProvider({
      repositoryStatus: 403,
      headers: {
        'x-ratelimit-limit': '60',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1789137600',
      },
    });

    const observation = await observeWith(provider);

    expect(observation.availability).toMatchObject({
      state: 'unavailable',
      reason: 'rate_limited',
      rateLimit: {
        limit: 60,
        remaining: 0,
        resetAt: new Date(1789137600 * 1000).toISOString(),
      },
    });
  });

  it('CASE rate-limited-429: a bare 429 is also rate limiting', async () => {
    const provider = createFixtureGitHubProvider({ repositoryStatus: 429 });

    const observation = await observeWith(provider);

    expect(observation.availability?.reason).toBe('rate_limited');
  });

  it('CASE server-error: 5xx maps to server_error', async () => {
    const provider = createFixtureGitHubProvider({ repositoryStatus: 502 });

    const observation = await observeWith(provider);

    expect(observation.availability?.reason).toBe('server_error');
  });

  it('CASE network-error: a transport failure maps to network_error', async () => {
    const provider = createFixtureGitHubProvider({
      error: new TransportError('NETWORK_ERROR', 'The remote API could not be reached.'),
    });

    const observation = await observeWith(provider);

    expect(observation.availability).toMatchObject({
      state: 'unavailable',
      target: 'repository',
      reason: 'network_error',
    });
  });

  it('CASE timeout: a transport timeout maps to timeout', async () => {
    const provider = createFixtureGitHubProvider({
      error: new TransportError('TIMEOUT', 'The remote request timed out.'),
    });

    const observation = await observeWith(provider);

    expect(observation.availability?.reason).toBe('timeout');
  });

  it('CASE malformed: a 200 with the wrong shape is malformed_response, never truth', async () => {
    const provider = createGitHubProvider({
      apiBaseUrl: 'https://api.github.test',
      transport: createStaticTransport({
        [`/repos/${TEST_REPOSITORY}`]: { status: 200, body: { unexpected: true } },
      }),
    });

    const observation = await observeWith(provider);

    expect(observation.availability).toMatchObject({
      state: 'unavailable',
      target: 'repository',
      reason: 'malformed_response',
    });
    expect(observation.remoteHeadSha).toBeUndefined();
  });

  it('CASE malformed-branch: a malformed branch payload is unavailable, never truth', async () => {
    const provider = createGitHubProvider({
      apiBaseUrl: 'https://api.github.test',
      transport: createStaticTransport({
        [`/repos/${TEST_REPOSITORY}`]: { status: 200, body: githubRepositoryPayload() },
        [`/repos/${TEST_REPOSITORY}/branches/${TEST_BRANCH}`]: {
          status: 200,
          body: { commit: {} },
        },
      }),
    });

    const observation = await observeWith(provider);

    expect(observation.availability).toMatchObject({
      state: 'unavailable',
      target: 'branch',
      reason: 'malformed_response',
    });
  });

  it('CASE archived: surfaces the archived flag as metadata only', async () => {
    const provider = createFixtureGitHubProvider({
      remoteSha: 'abc123',
      repositoryOverrides: { archived: true },
    });

    const observation = await observeWith(provider);

    expect(observation.archived).toBe(true);
    expect(observation.availability?.state).toBe('available');
  });

  it('CASE branch-vs-default: records a non-default declared branch without judging it', async () => {
    const provider = createFixtureGitHubProvider({
      remoteSha: 'abc123',
      branch: 'release',
      repositoryOverrides: { default_branch: 'main' },
    });

    const observation = await observeWith(provider, TEST_REPOSITORY, 'release');

    expect(observation.branch).toBe('release');
    expect(observation.defaultBranch).toBe('main');
  });

  it('CASE fixtures-file: a differing remote head matches the documented fixture', async () => {
    const provider = createFixtureGitHubProvider({
      remoteSha: 'def456',
      repository: 'acme/meridia',
    });

    const observation = await observeWith(provider, 'acme/meridia');

    expect(observation).toMatchObject(loadNormalizedFixture('main-behind'));
  });
});

describe('GitHub adapter diagnostics', () => {
  it('reports repository, branch, and credential-free diagnostics for a healthy repo', async () => {
    const provider = createFixtureGitHubProvider({ remoteSha: 'abc1234def' });
    const diagnostics = await provider.diagnose?.({
      project: 'test-project',
      environment: 'production',
      config: gitHubConfig(),
    });

    expect(diagnostics?.map((entry) => entry.status)).not.toContain('error');
    expect(diagnostics?.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(['GITHUB_API', 'GITHUB_REPOSITORY', 'GITHUB_BRANCH']),
    );
    const branchEntry = diagnostics?.find((entry) => entry.code === 'GITHUB_BRANCH');
    expect(branchEntry?.message).toContain('abc1234');
  });

  it('marks the API unreachable and the repository unobservable on network failure', async () => {
    const provider = createFixtureGitHubProvider({
      error: new TransportError('NETWORK_ERROR', 'unreachable'),
    });
    const diagnostics = await provider.diagnose?.({
      project: 'test-project',
      environment: 'production',
      config: gitHubConfig(),
    });

    expect(diagnostics?.find((entry) => entry.code === 'GITHUB_API')?.status).toBe('error');
    expect(diagnostics?.find((entry) => entry.code === 'GITHUB_REPOSITORY')?.status).toBe('error');
  });
});
