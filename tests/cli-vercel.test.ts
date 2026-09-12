import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { formatCheckReport, runEnvironmentCheck } from '../packages/cli/src/check.js';
import { cleanupTempDirs, configureUpstream, git, initRepo, tempDir } from './git-test-utils.js';
import { createFixtureGitHubProvider } from './github-test-utils.js';
import { PRODUCTION_DEPLOYMENT_ID, createFixtureVercelProvider } from './vercel-test-utils.js';

const MANIFEST = `version: 1
project: example
environments:
  production:
    kind: production
    source: { provider: github, repository: example/example-app, branch: main }
    deployment: { provider: vercel, project: example-app, target: production }
`;

const manifestAt = (directory: string): string => {
  const path = join(directory, 'deploytruth.yml');
  writeFileSync(path, MANIFEST);
  return path;
};

afterEach(cleanupTempDirs);

describe('deploytruth check Vercel deployment truth', () => {
  it('VERIFIES deployment truth when GitHub main and Vercel production agree', async () => {
    const dir = initRepo(tempDir('dt-vc-healthy-'));
    const head = git(['rev-parse', 'HEAD'], dir);
    configureUpstream(dir, head);

    const execution = await runEnvironmentCheck({
      configPath: manifestAt(dir),
      environmentName: 'production',
      githubProvider: createFixtureGitHubProvider({ remoteSha: head }),
      vercelProvider: createFixtureVercelProvider({ sourceSha: head }),
    });
    const report = execution.report;

    const deployment = report.environments[0]?.observation?.deployment;
    expect(deployment?.provider).toBe('vercel');
    expect(deployment?.availability?.state).toBe('available');
    expect(deployment?.deploymentId).toBe(PRODUCTION_DEPLOYMENT_ID);
    expect(deployment?.commitSha).toBe(head);
    expect(report.findings.map((finding) => finding.code)).not.toContain('DEPLOYMENT_SHA_MISMATCH');
    // deploytruth.yml is untracked, so the verdict stays WARN — but never on deployment truth.
    expect(report.findings.map((finding) => finding.code)).not.toContain(
      'REQUIRED_OBSERVATION_UNAVAILABLE',
    );

    const output = formatCheckReport(execution);
    expect(output).toContain('DEPLOYMENT');
    expect(output).toContain('Vercel');
    expect(output).toContain('READY');
    expect(output).toContain('Deployment truth');
    expect(output).toContain('VERIFIED');
  });

  it('reports DEPLOYMENT_SHA_MISMATCH when production serves a different commit', async () => {
    const dir = initRepo(tempDir('dt-vc-mismatch-'));
    const head = git(['rev-parse', 'HEAD'], dir);
    configureUpstream(dir, head);
    const productionSha = 'f'.repeat(40);

    const execution = await runEnvironmentCheck({
      configPath: manifestAt(dir),
      environmentName: 'production',
      githubProvider: createFixtureGitHubProvider({ remoteSha: head }),
      vercelProvider: createFixtureVercelProvider({ sourceSha: productionSha }),
    });
    const report = execution.report;

    const finding = report.findings.find((entry) => entry.code === 'DEPLOYMENT_SHA_MISMATCH');
    expect(finding).toBeDefined();
    expect(finding?.expected).toBe(head);
    expect(finding?.observed).toBe(productionSha);
    expect(report.verdict).toBe('FAIL');

    const output = formatCheckReport(execution);
    expect(output).toContain('DEPLOYMENT_SHA_MISMATCH');
    expect(output).toContain(productionSha.slice(0, 7));
  });

  it('marks Vercel UNAVAILABLE on rate limiting without a false PASS', async () => {
    const dir = initRepo(tempDir('dt-vc-ratelimit-'));
    const head = git(['rev-parse', 'HEAD'], dir);
    configureUpstream(dir, head);

    const execution = await runEnvironmentCheck({
      configPath: manifestAt(dir),
      environmentName: 'production',
      githubProvider: createFixtureGitHubProvider({ remoteSha: head }),
      vercelProvider: createFixtureVercelProvider({
        projectStatus: 429,
        headers: {
          'x-ratelimit-limit': '100',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '1789137600',
          'retry-after': '60',
        },
      }),
    });
    const report = execution.report;

    const deployment = report.environments[0]?.observation?.deployment;
    expect(deployment?.availability).toMatchObject({
      state: 'unavailable',
      reason: 'rate_limited',
    });
    expect(report.findings.map((entry) => entry.code)).toContain('VERCEL_PROJECT_UNAVAILABLE');
    expect(report.verdict).toBe('WARN');
    expect(report.verdict).not.toBe('PASS');

    const output = formatCheckReport(execution);
    expect(output).toContain('UNAVAILABLE');
    expect(output).toContain('rate limit exceeded');
    expect(output).toContain('Retry after');
  });

  it('reports missing credentials as unavailable evidence', async () => {
    const dir = initRepo(tempDir('dt-vc-nocreds-'));
    const head = git(['rev-parse', 'HEAD'], dir);
    configureUpstream(dir, head);

    const execution = await runEnvironmentCheck({
      configPath: manifestAt(dir),
      environmentName: 'production',
      githubProvider: createFixtureGitHubProvider({ remoteSha: head }),
      vercelProvider: createFixtureVercelProvider({ projectStatus: 401 }),
    });
    const report = execution.report;

    const deployment = report.environments[0]?.observation?.deployment;
    expect(deployment?.availability?.reason).toBe('unauthorized');
    expect(report.findings.map((entry) => entry.code)).toContain('VERCEL_PROJECT_UNAVAILABLE');
    expect(report.verdict).not.toBe('PASS');
  });

  it('does not call Vercel when no deployment is declared', async () => {
    const dir = initRepo(tempDir('dt-vc-nodecl-'));
    const head = git(['rev-parse', 'HEAD'], dir);
    configureUpstream(dir, head);
    const path = join(dir, 'deploytruth.yml');
    writeFileSync(
      path,
      `version: 1
project: example
environments:
  production:
    kind: production
    source: { provider: github, repository: example/example-app, branch: main }
`,
    );

    const calls: string[] = [];
    const execution = await runEnvironmentCheck({
      configPath: path,
      environmentName: 'production',
      githubProvider: createFixtureGitHubProvider({ remoteSha: head }),
      vercelProvider: createFixtureVercelProvider({}, calls),
    });

    expect(calls).toEqual([]);
    expect(execution.report.environments[0]?.observation?.deployment).toBeUndefined();
  });
});
