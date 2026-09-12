import { deploymentObservationSchema } from '@deploytruth/core';
import {
  TransportError,
  createVercelProvider,
  vercelDeploymentConfigSchema,
} from '@deploytruth/providers';
import { describe, expect, it } from 'vitest';

import {
  PRODUCTION_DEPLOYMENT_ID,
  TEST_PROJECT,
  TEST_SHA,
  createFixtureVercelProvider,
  vercelConfig,
} from './vercel-test-utils.js';

const observeWith = (
  provider: ReturnType<typeof createFixtureVercelProvider>,
  config: ReturnType<typeof vercelConfig> = vercelConfig(),
) =>
  provider.observe({
    project: 'test-project',
    environment: 'production',
    config,
  });

describe('Vercel adapter configuration', () => {
  it.each(['example-app', 'prj_12HKQaOmR5t5Uy6vdcQsNIiZgHGB', 'app.v2_final'])(
    'accepts project identifier %s',
    (project) => {
      expect(vercelDeploymentConfigSchema.parse({ project }).project).toBe(project);
    },
  );

  it.each(['white space', 'sla/sh', '../escape', 'lead-', ''])(
    'rejects malformed project %s',
    (project) => {
      expect(() => vercelDeploymentConfigSchema.parse({ project })).toThrow();
    },
  );

  it('accepts only the production target', () => {
    expect(vercelDeploymentConfigSchema.parse({ project: 'p' }).target).toBeUndefined();
    expect(vercelDeploymentConfigSchema.parse({ project: 'p', target: 'production' }).target).toBe(
      'production',
    );
    expect(() => vercelDeploymentConfigSchema.parse({ project: 'p', target: 'preview' })).toThrow();
  });

  it.each(['kaizora', 'team_9f8sdfJ2', 'org-name'])('accepts scope %s', (scope) => {
    expect(vercelDeploymentConfigSchema.parse({ project: 'p', scope }).scope).toBe(scope);
  });

  it('accepts a bare domain hostname and normalizes case', () => {
    expect(
      vercelDeploymentConfigSchema.parse({ project: 'p', domain: 'App.Example.COM' }).domain,
    ).toBe('app.example.com');
  });

  it.each(['https://app.example.com', 'app.example.com/path', 'localhost', 'app example'])(
    'rejects non-hostname domain %s',
    (domain) => {
      expect(() => vercelDeploymentConfigSchema.parse({ project: 'p', domain })).toThrow();
    },
  );
});

describe('Vercel adapter observation', () => {
  it('CASE healthy: resolves the aliased production deployment with source metadata', async () => {
    const calls: string[] = [];
    const provider = createFixtureVercelProvider({ sourceSha: TEST_SHA }, calls);

    const observation = await observeWith(provider);

    expect(observation.provider).toBe('vercel');
    expect(observation.availability?.state).toBe('available');
    expect(observation.project).toBe(TEST_PROJECT);
    expect(observation.target).toBe('production');
    expect(observation.deploymentId).toBe(PRODUCTION_DEPLOYMENT_ID);
    expect(observation.deploymentUrl).toBe(`https://${TEST_PROJECT}-abc123.vercel.app`);
    expect(observation.state).toBe('ready');
    expect(observation.commitSha).toBe(TEST_SHA);
    expect(observation.sourceBranch).toBe('main');
    expect(observation.sourceRepository).toBe('example/example-app');
    expect(observation.createdAt).toBe(new Date(1789000000000).toISOString());
    // Exactly two GETs: project (identity + aliases) then the production deployment.
    expect(calls).toEqual([
      `/v9/projects/${TEST_PROJECT}`,
      `/v13/deployments/${PRODUCTION_DEPLOYMENT_ID}?withGitRepoInfo=true`,
    ]);
  });

  it('drops raw payload fields and environment-variable material from the observation', async () => {
    const provider = createFixtureVercelProvider();
    const observation = await observeWith(provider);
    const serialized = JSON.stringify(observation);

    expect(serialized).not.toContain('rawOnlySentinel');
    expect(serialized).not.toContain('vercel_fixture_never_real');
    expect(serialized).not.toContain('secret-value-must-not-escape');
    expect(serialized).not.toContain('SECRET_VAR');
    expect(serialized).not.toContain('SUPABASE_URL');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('Bearer');
  });

  it('CASE preview-not-production: a newer preview deployment is never selected as production', async () => {
    const calls: string[] = [];
    const provider = createFixtureVercelProvider(
      {
        projectOverrides: {
          alias: [
            {
              domain: `${TEST_PROJECT}-git-feature.vercel.app`,
              target: null,
              environment: 'preview',
              deployment: { id: 'dpl_preview_newest', url: 'preview.vercel.app' },
            },
            {
              domain: `${TEST_PROJECT}.vercel.app`,
              target: 'PRODUCTION',
              environment: 'production',
              deployment: { id: PRODUCTION_DEPLOYMENT_ID },
            },
          ],
          latestDeployments: [{ id: 'dpl_preview_newest' }],
        },
      },
      calls,
    );

    const observation = await observeWith(provider);

    expect(observation.deploymentId).toBe(PRODUCTION_DEPLOYMENT_ID);
    expect(calls).not.toContain('/v13/deployments/dpl_preview_newest?withGitRepoInfo=true');
  });

  it('CASE rollback: the deployment the production aliases point to wins, not the newest', async () => {
    const provider = createFixtureVercelProvider({
      projectOverrides: {
        alias: [
          {
            domain: `${TEST_PROJECT}.vercel.app`,
            target: 'PRODUCTION',
            environment: 'production',
            deployment: { id: 'dpl_rolled_back_to', url: 'old.vercel.app' },
          },
          {
            domain: 'app.example.com',
            target: 'PRODUCTION',
            environment: 'production',
            deployment: { id: 'dpl_rolled_back_to', url: 'old.vercel.app' },
          },
        ],
        latestDeployments: [{ id: 'dpl_newer_bad' }, { id: 'dpl_rolled_back_to' }],
      },
      deploymentOverrides: { id: 'dpl_rolled_back_to' },
      sourceSha: 'b'.repeat(40),
    });

    const observation = await observeWith(provider);

    expect(observation.deploymentId).toBe('dpl_rolled_back_to');
    expect(observation.commitSha).toBe('b'.repeat(40));
  });

  it('CASE unanimous-aliases: agreeing production aliases resolve without a declared domain', async () => {
    const provider = createFixtureVercelProvider({
      projectOverrides: {
        alias: [
          {
            domain: 'app.example.com',
            target: 'PRODUCTION',
            environment: 'production',
            deployment: { id: PRODUCTION_DEPLOYMENT_ID },
          },
          {
            domain: 'www.example.com',
            target: 'PRODUCTION',
            environment: 'production',
            deployment: { id: PRODUCTION_DEPLOYMENT_ID },
          },
          {
            domain: 'example.com',
            target: 'PRODUCTION',
            environment: 'production',
            deployment: { id: PRODUCTION_DEPLOYMENT_ID },
          },
        ],
      },
    });

    const observation = await observeWith(provider);

    expect(observation.availability?.state).toBe('available');
    expect(observation.deploymentId).toBe(PRODUCTION_DEPLOYMENT_ID);
  });

  it('CASE divergent-aliases: a 1:1 production alias split is ambiguous, never a coin flip', async () => {
    const provider = createFixtureVercelProvider({
      projectOverrides: {
        alias: [
          {
            domain: 'app.example.com',
            target: 'PRODUCTION',
            environment: 'production',
            deployment: { id: 'dpl_a' },
          },
          {
            domain: 'www.example.com',
            target: 'PRODUCTION',
            environment: 'production',
            deployment: { id: 'dpl_b' },
          },
        ],
      },
    });

    const observation = await observeWith(provider);

    expect(observation.availability).toMatchObject({
      state: 'unavailable',
      target: 'deployment',
      reason: 'ambiguous',
    });
    expect(observation.deploymentId).toBeUndefined();
    expect(observation.commitSha).toBeUndefined();
    expect(observation.productionAssignments).toEqual([
      { domain: 'app.example.com', deploymentId: 'dpl_a' },
      { domain: 'www.example.com', deploymentId: 'dpl_b' },
    ]);
  });

  it('CASE divergent-aliases: even a 3:1 production alias majority stays ambiguous', async () => {
    const provider = createFixtureVercelProvider({
      projectOverrides: {
        alias: [
          {
            domain: 'a.example.com',
            target: 'PRODUCTION',
            environment: 'production',
            deployment: { id: 'dpl_minority' },
          },
          {
            domain: 'b.example.com',
            target: 'PRODUCTION',
            environment: 'production',
            deployment: { id: 'dpl_majority' },
          },
          {
            domain: 'c.example.com',
            target: 'PRODUCTION',
            environment: 'production',
            deployment: { id: 'dpl_majority' },
          },
        ],
      },
      deploymentOverrides: { id: 'dpl_majority' },
    });

    const observation = await observeWith(provider);

    // Majority voting would pick dpl_majority; DeployTruth reports UNKNOWN instead.
    expect(observation.availability).toMatchObject({
      state: 'unavailable',
      target: 'deployment',
      reason: 'ambiguous',
    });
    expect(observation.deploymentId).toBeUndefined();
    expect(observation.commitSha).toBeUndefined();
    expect(observation.productionAssignments).toEqual([
      { domain: 'a.example.com', deploymentId: 'dpl_minority' },
      { domain: 'b.example.com', deploymentId: 'dpl_majority' },
      { domain: 'c.example.com', deploymentId: 'dpl_majority' },
    ]);
  });

  it('CASE redirects: redirect aliases never count as production assignments', async () => {
    const provider = createFixtureVercelProvider({
      projectOverrides: {
        alias: [
          {
            domain: 'old.example.com',
            target: 'PRODUCTION',
            environment: 'production',
            redirect: 'https://app.example.com',
            deployment: { id: 'dpl_should_not_win' },
          },
          {
            domain: `${TEST_PROJECT}.vercel.app`,
            target: 'PRODUCTION',
            environment: 'production',
            deployment: { id: PRODUCTION_DEPLOYMENT_ID },
          },
        ],
      },
    });

    const observation = await observeWith(provider);

    expect(observation.deploymentId).toBe(PRODUCTION_DEPLOYMENT_ID);
  });

  it('CASE no-production-alias: a project without a production assignment is deployment_unavailable', async () => {
    const provider = createFixtureVercelProvider({
      projectOverrides: {
        alias: [
          {
            domain: `${TEST_PROJECT}-git-x.vercel.app`,
            target: null,
            environment: 'preview',
            deployment: { id: 'dpl_preview' },
          },
        ],
      },
    });

    const observation = await observeWith(provider);

    expect(observation.availability).toMatchObject({
      state: 'unavailable',
      target: 'deployment',
      reason: 'deployment_unavailable',
    });
    expect(observation.deploymentId).toBeUndefined();
    expect(observation.commitSha).toBeUndefined();
  });

  it('CASE deployment-404: a dangling production alias reports the deployment unavailable', async () => {
    const provider = createFixtureVercelProvider({ deploymentStatus: 404 });

    const observation = await observeWith(provider);

    expect(observation.availability).toMatchObject({
      state: 'unavailable',
      target: 'deployment',
      reason: 'not_found',
    });
  });

  it('CASE missing-credentials: no token produces unavailable evidence without any request', async () => {
    const provider = createVercelProvider({
      env: {},
      apiBaseUrl: 'https://api.vercel.test',
    });

    const observation = await observeWith(provider);

    expect(observation.availability).toMatchObject({
      state: 'unavailable',
      target: 'project',
      reason: 'missing_credentials',
    });
    expect(observation.availability?.detail).toContain('DEPLOYTRUTH_VERCEL_TOKEN');
  });

  it.each([
    [401, 'unauthorized'],
    [404, 'not_found'],
    [502, 'server_error'],
  ] as const)('CASE project-http-%i: normalizes to %s', async (status, reason) => {
    const provider = createFixtureVercelProvider({ projectStatus: status });

    const observation = await observeWith(provider);

    expect(observation.availability).toMatchObject({
      state: 'unavailable',
      target: 'project',
      reason,
    });
    expect(observation.deploymentId).toBeUndefined();
  });

  it('CASE forbidden: a real 403 is forbidden, not rate limiting', async () => {
    const provider = createFixtureVercelProvider({
      projectStatus: 403,
      headers: { 'x-ratelimit-remaining': '4821' },
    });

    const observation = await observeWith(provider);

    expect(observation.availability?.reason).toBe('forbidden');
  });

  it('CASE rate-limited: 429 carries normalized limit metadata and Retry-After', async () => {
    const provider = createFixtureVercelProvider({
      projectStatus: 429,
      headers: {
        'x-ratelimit-limit': '100',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1789137600',
        'retry-after': '60',
      },
    });

    const observation = await observeWith(provider);

    expect(observation.availability).toMatchObject({
      state: 'unavailable',
      reason: 'rate_limited',
      rateLimit: {
        limit: 100,
        remaining: 0,
        resetAt: new Date(1789137600 * 1000).toISOString(),
        retryAfter: 60,
      },
    });
  });

  it('CASE 403-quota: 403 with an exhausted quota normalizes to rate_limited', async () => {
    const provider = createFixtureVercelProvider({
      projectStatus: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1789137600' },
    });

    const observation = await observeWith(provider);

    expect(observation.availability?.reason).toBe('rate_limited');
  });

  it('CASE network-error: a transport failure maps to network_error', async () => {
    const provider = createFixtureVercelProvider({
      error: new TransportError('NETWORK_ERROR', 'The remote API could not be reached.'),
    });

    const observation = await observeWith(provider);

    expect(observation.availability).toMatchObject({
      state: 'unavailable',
      target: 'project',
      reason: 'network_error',
    });
  });

  it('CASE timeout: a transport timeout maps to timeout', async () => {
    const provider = createFixtureVercelProvider({
      error: new TransportError('TIMEOUT', 'The remote request timed out.'),
    });

    const observation = await observeWith(provider);

    expect(observation.availability?.reason).toBe('timeout');
  });

  it('CASE malformed-project: a 200 with the wrong shape is malformed_response', async () => {
    const provider = createFixtureVercelProvider({
      projectOverrides: { id: undefined },
    });

    const observation = await observeWith(provider);

    expect(observation.availability).toMatchObject({
      state: 'unavailable',
      target: 'project',
      reason: 'malformed_response',
    });
  });

  it('CASE malformed-deployment: a malformed deployment payload is unavailable, never truth', async () => {
    const provider = createFixtureVercelProvider({
      deploymentOverrides: { id: 42, readyState: {} },
    });

    const observation = await observeWith(provider);

    expect(observation.availability).toMatchObject({
      state: 'unavailable',
      target: 'deployment',
      reason: 'malformed_response',
    });
  });

  it('CASE deployment-fetch-error: transport failure on the deployment call is unavailable', async () => {
    const provider = createFixtureVercelProvider({
      deploymentError: new TransportError('NETWORK_ERROR', 'unreachable'),
    });

    const observation = await observeWith(provider);

    expect(observation.availability).toMatchObject({
      state: 'unavailable',
      target: 'deployment',
      reason: 'network_error',
    });
  });

  it.each([
    ['READY', 'ready'],
    ['BUILDING', 'building'],
    ['INITIALIZING', 'building'],
    ['QUEUED', 'queued'],
    ['ERROR', 'error'],
    ['CANCELED', 'canceled'],
    ['BLOCKED', 'unknown'],
    ['UNRECOGNIZED', 'unknown'],
  ] as const)('normalizes readyState %s to %s', async (readyState, expected) => {
    const provider = createFixtureVercelProvider({
      deploymentOverrides: { readyState },
    });

    const observation = await observeWith(provider);

    expect(observation.state).toBe(expected);
  });

  it('CASE no-source-sha: a deployment without commit metadata reports no commitSha', async () => {
    const provider = createFixtureVercelProvider({
      sourceSha: undefined,
      deploymentOverrides: { meta: {} },
    });

    const observation = await observeWith(provider);

    expect(observation.availability?.state).toBe('available');
    expect(observation.deploymentId).toBe(PRODUCTION_DEPLOYMENT_ID);
    expect(observation.commitSha).toBeUndefined();
  });

  it('CASE no-branch: a deployment without branch metadata reports no sourceBranch', async () => {
    const provider = createFixtureVercelProvider({
      deploymentOverrides: {
        meta: { githubCommitSha: TEST_SHA },
      },
    });

    const observation = await observeWith(provider);

    expect(observation.commitSha).toBe(TEST_SHA);
    expect(observation.sourceBranch).toBeUndefined();
  });

  it('CASE gitSource-fallback: gitSource provides the SHA when meta does not', async () => {
    const provider = createFixtureVercelProvider({
      deploymentOverrides: {
        meta: {},
        gitSource: {
          type: 'github',
          org: 'example',
          repo: 'example-app',
          ref: 'main',
          sha: 'c'.repeat(40),
        },
      },
    });

    const observation = await observeWith(provider);

    expect(observation.commitSha).toBe('c'.repeat(40));
    expect(observation.sourceBranch).toBe('main');
    expect(observation.sourceRepository).toBe('example/example-app');
  });

  it('CASE non-github-source: other git providers still yield the recorded commit', async () => {
    const provider = createFixtureVercelProvider({
      deploymentOverrides: {
        meta: { gitlabCommitSha: 'd'.repeat(40), gitlabCommitRef: 'main' },
      },
    });

    const observation = await observeWith(provider);

    expect(observation.commitSha).toBe('d'.repeat(40));
    expect(observation.sourceBranch).toBe('main');
  });

  it('CASE domain-verified: the declared domain resolving to production verifies', async () => {
    const provider = createFixtureVercelProvider();

    const observation = await observeWith(
      provider,
      vercelConfig(TEST_PROJECT, {
        domain: 'app.example.com',
      }),
    );

    expect(observation.stableDomain).toBe('app.example.com');
    expect(observation.stableDomainVerified).toBe(true);
  });

  it('CASE declared-domain-divergent: the declared domain resolves production even as the minority alias', async () => {
    const provider = createFixtureVercelProvider({
      projectOverrides: {
        alias: [
          {
            domain: `${TEST_PROJECT}.vercel.app`,
            target: 'PRODUCTION',
            environment: 'production',
            deployment: { id: PRODUCTION_DEPLOYMENT_ID },
          },
          {
            domain: `www.example.com`,
            target: 'PRODUCTION',
            environment: 'production',
            deployment: { id: PRODUCTION_DEPLOYMENT_ID },
          },
          {
            domain: 'app.example.com',
            target: 'PRODUCTION',
            environment: 'production',
            deployment: { id: 'dpl_declared_target' },
          },
        ],
      },
    });

    const observation = await observeWith(
      provider,
      vercelConfig(TEST_PROJECT, { domain: 'app.example.com' }),
    );

    // Two aliases point at PRODUCTION_DEPLOYMENT_ID, but the declared domain is the
    // authoritative routing identity — no majority vote.
    expect(observation.availability?.state).toBe('available');
    expect(observation.deploymentId).toBe('dpl_declared_target');
    expect(observation.stableDomain).toBe('app.example.com');
    expect(observation.stableDomainVerified).toBe(true);
  });

  it('CASE declared-domain-rollback: a rollback through the declared domain resolves its target', async () => {
    const provider = createFixtureVercelProvider({
      projectOverrides: {
        alias: [
          {
            domain: 'app.example.com',
            target: 'PRODUCTION',
            environment: 'production',
            deployment: { id: 'dpl_rolled_back_to', url: 'old.vercel.app' },
          },
          {
            domain: 'www.example.com',
            target: 'PRODUCTION',
            environment: 'production',
            deployment: { id: 'dpl_newer_bad', url: 'new.vercel.app' },
          },
        ],
        latestDeployments: [{ id: 'dpl_newer_bad' }, { id: 'dpl_rolled_back_to' }],
      },
      sourceSha: 'b'.repeat(40),
    });

    const observation = await observeWith(
      provider,
      vercelConfig(TEST_PROJECT, { domain: 'app.example.com' }),
    );

    expect(observation.availability?.state).toBe('available');
    expect(observation.deploymentId).toBe('dpl_rolled_back_to');
    expect(observation.commitSha).toBe('b'.repeat(40));
    expect(observation.stableDomainVerified).toBe(true);
  });

  it('CASE domain-absent: an unattached declared domain is unavailable, never a fallback', async () => {
    const provider = createFixtureVercelProvider();

    const observation = await observeWith(
      provider,
      vercelConfig(TEST_PROJECT, { domain: 'other.example.com' }),
    );

    expect(observation.availability).toMatchObject({
      state: 'unavailable',
      target: 'deployment',
      reason: 'deployment_unavailable',
    });
    expect(observation.deploymentId).toBeUndefined();
    expect(observation.stableDomain).toBe('other.example.com');
    // The observed production routing is still reported as normalized evidence.
    expect(observation.productionAssignments).toEqual([
      { domain: 'app.example.com', deploymentId: PRODUCTION_DEPLOYMENT_ID },
      { domain: `${TEST_PROJECT}.vercel.app`, deploymentId: PRODUCTION_DEPLOYMENT_ID },
    ]);
  });

  it('CASE domain-unassigned: a listed domain without a deployment is unavailable', async () => {
    const provider = createFixtureVercelProvider({
      projectOverrides: {
        alias: [
          {
            domain: `${TEST_PROJECT}.vercel.app`,
            target: 'PRODUCTION',
            environment: 'production',
            deployment: { id: PRODUCTION_DEPLOYMENT_ID },
          },
          { domain: 'app.example.com', target: 'PRODUCTION', environment: 'production' },
        ],
      },
    });

    const observation = await observeWith(
      provider,
      vercelConfig(TEST_PROJECT, { domain: 'app.example.com' }),
    );

    expect(observation.availability).toMatchObject({
      state: 'unavailable',
      target: 'deployment',
      reason: 'deployment_unavailable',
    });
    expect(observation.deploymentId).toBeUndefined();
    expect(observation.stableDomain).toBe('app.example.com');
  });

  it('CASE scope-slug: a slug scope becomes the slug query parameter', async () => {
    const calls: string[] = [];
    const provider = createFixtureVercelProvider({ scope: 'kaizora' }, calls);

    await provider.observe({
      project: 'test-project',
      environment: 'production',
      config: vercelConfig(TEST_PROJECT, { scope: 'kaizora' }),
    });

    expect(calls[0]).toBe(`/v9/projects/${TEST_PROJECT}?slug=kaizora`);
    expect(calls[1]).toContain('slug=kaizora');
    expect(calls[1]).toContain('withGitRepoInfo=true');
  });

  it('CASE scope-team-id: a team_ scope becomes the teamId query parameter', async () => {
    const calls: string[] = [];
    const provider = createFixtureVercelProvider({ scope: 'team_abc123' }, calls);

    await provider.observe({
      project: 'test-project',
      environment: 'production',
      config: vercelConfig(TEST_PROJECT, { scope: 'team_abc123' }),
    });

    expect(calls[0]).toBe(`/v9/projects/${TEST_PROJECT}?teamId=team_abc123`);
  });

  it('every fixture observation stays schema-valid', async () => {
    const provider = createFixtureVercelProvider();
    const observation = await observeWith(provider);

    expect(() => deploymentObservationSchema.parse(observation)).not.toThrow();
  });
});

describe('Vercel adapter diagnostics', () => {
  it('reports project, production, and source metadata for a healthy deployment', async () => {
    const provider = createFixtureVercelProvider();
    const diagnostics = await provider.diagnose?.({
      project: 'test-project',
      environment: 'production',
      config: vercelConfig(TEST_PROJECT, { domain: 'app.example.com' }),
    });

    expect(diagnostics?.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        'VERCEL_API',
        'VERCEL_PROJECT',
        'VERCEL_PRODUCTION',
        'VERCEL_SOURCE_METADATA',
        'VERCEL_DOMAIN',
      ]),
    );
    expect(diagnostics?.find((entry) => entry.code === 'VERCEL_DOMAIN')?.status).toBe('ok');
  });

  it('marks the project unobservable when no credentials resolve', async () => {
    const provider = createVercelProvider({ env: {}, apiBaseUrl: 'https://api.vercel.test' });
    const diagnostics = await provider.diagnose?.({
      project: 'test-project',
      environment: 'production',
      config: vercelConfig(),
    });

    expect(diagnostics?.find((entry) => entry.code === 'VERCEL_PROJECT')?.status).toBe('error');
  });

  it('marks the API unreachable and the project unobservable on network failure', async () => {
    const provider = createFixtureVercelProvider({
      error: new TransportError('NETWORK_ERROR', 'unreachable'),
    });
    const diagnostics = await provider.diagnose?.({
      project: 'test-project',
      environment: 'production',
      config: vercelConfig(),
    });

    expect(diagnostics?.find((entry) => entry.code === 'VERCEL_API')?.status).toBe('error');
    expect(diagnostics?.find((entry) => entry.code === 'VERCEL_PROJECT')?.status).toBe('error');
  });

  it('flags missing source metadata as a warning, not a hard error', async () => {
    const provider = createFixtureVercelProvider({
      sourceSha: undefined,
      deploymentOverrides: { meta: {} },
    });
    const diagnostics = await provider.diagnose?.({
      project: 'test-project',
      environment: 'production',
      config: vercelConfig(),
    });

    const metadata = diagnostics?.find((entry) => entry.code === 'VERCEL_SOURCE_METADATA');
    expect(metadata?.status).toBe('warning');
  });

  it('reports divergent production aliases as an ambiguous error, not a majority pick', async () => {
    const provider = createFixtureVercelProvider({
      projectOverrides: {
        alias: [
          {
            domain: 'app.example.com',
            target: 'PRODUCTION',
            environment: 'production',
            deployment: { id: 'dpl_a' },
          },
          {
            domain: 'www.example.com',
            target: 'PRODUCTION',
            environment: 'production',
            deployment: { id: 'dpl_b' },
          },
        ],
      },
    });
    const diagnostics = await provider.diagnose?.({
      project: 'test-project',
      environment: 'production',
      config: vercelConfig(),
    });

    const production = diagnostics?.find((entry) => entry.code === 'VERCEL_PRODUCTION');
    expect(production?.status).toBe('error');
    expect(production?.message).toContain('ambiguous');
    expect(production?.message).toContain('app.example.com -> dpl_a');
    expect(production?.message).toContain('www.example.com -> dpl_b');
  });
});
