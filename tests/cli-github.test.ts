import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { formatCheckReport, runEnvironmentCheck } from '../packages/cli/src/check.js';
import {
  cleanupTempDirs,
  commit,
  configureUpstream,
  git,
  initRepo,
  tempDir,
} from './git-test-utils.js';
import { createFixtureGitHubProvider } from './github-test-utils.js';

const MANIFEST = `version: 1
project: example
environments:
  production:
    kind: production
    source: { provider: github, repository: example/example-app, branch: main }
`;

const manifestAt = (directory: string): string => {
  const path = join(directory, 'deploytruth.yml');
  writeFileSync(path, MANIFEST);
  return path;
};

afterEach(cleanupTempDirs);

describe('deploytruth check GitHub source truth', () => {
  it('reports STALE_TRACKING_REF when GitHub has moved past the local tracking ref', async () => {
    const dir = initRepo(tempDir('dt-gh-stale-'));
    const local = git(['rev-parse', 'HEAD'], dir);
    configureUpstream(dir, local);
    const remoteSha = 'f'.repeat(40);

    const execution = await runEnvironmentCheck({
      configPath: manifestAt(dir),
      environmentName: 'production',
      githubProvider: createFixtureGitHubProvider({ remoteSha }),
    });

    const finding = execution.report.findings.find((entry) => entry.code === 'STALE_TRACKING_REF');
    expect(finding).toBeDefined();
    expect(finding?.expected).toBe(remoteSha);
    expect(finding?.observed).toBe(local);
    expect(execution.report.verdict).toBe('WARN');

    const output = formatCheckReport(execution);
    expect(output).toContain('Authoritative SHA');
    expect(output).toContain(remoteSha.slice(0, 7));
    expect(output).toContain('STALE_TRACKING_REF');
  });

  it('VERIFIES source truth when local HEAD, tracking ref, and GitHub agree', async () => {
    const dir = initRepo(tempDir('dt-gh-verified-'));
    const head = git(['rev-parse', 'HEAD'], dir);
    configureUpstream(dir, head);

    const execution = await runEnvironmentCheck({
      configPath: manifestAt(dir),
      environmentName: 'production',
      githubProvider: createFixtureGitHubProvider({ remoteSha: head }),
    });

    const output = formatCheckReport(execution);
    expect(output).toContain('Source truth');
    expect(output).toContain('VERIFIED');
    expect(output).not.toContain('STALE_TRACKING_REF');
    // The environment still lacks deployment/database evidence, so no false PASS.
    expect(execution.report.verdict).toBe('WARN');
  });

  it('reports GitHub as UNAVAILABLE under rate limiting without a false PASS', async () => {
    const dir = initRepo(tempDir('dt-gh-ratelimit-'));
    const head = git(['rev-parse', 'HEAD'], dir);
    configureUpstream(dir, head);

    const execution = await runEnvironmentCheck({
      configPath: manifestAt(dir),
      environmentName: 'production',
      githubProvider: createFixtureGitHubProvider({
        repositoryStatus: 403,
        headers: {
          'x-ratelimit-limit': '60',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '1789137600',
        },
      }),
    });

    const remote = execution.report.environments[0]?.observation?.remoteSource;
    expect(remote?.availability).toMatchObject({
      state: 'unavailable',
      reason: 'rate_limited',
    });
    expect(execution.report.findings.map((entry) => entry.code)).toContain(
      'GITHUB_REPOSITORY_UNAVAILABLE',
    );
    expect(execution.report.verdict).toBe('WARN');
    expect(execution.report.verdict).not.toBe('PASS');

    const output = formatCheckReport(execution);
    expect(output).toContain('UNAVAILABLE');
    expect(output).toContain('rate limit exceeded');
    expect(output).toContain('Retry after');
    expect(output).toContain(new Date(1789137600 * 1000).toISOString());
  });

  it('observes GitHub truth even when the local repository has no remote configured', async () => {
    const dir = initRepo(tempDir('dt-gh-noremote-'));
    const head = git(['rev-parse', 'HEAD'], dir);

    const execution = await runEnvironmentCheck({
      configPath: manifestAt(dir),
      environmentName: 'production',
      githubProvider: createFixtureGitHubProvider({ remoteSha: head }),
    });

    const source = execution.report.environments[0]?.observation?.source;
    expect(source?.remoteNames).toEqual([]);
    expect(source?.upstream).toBeUndefined();
    const remote = execution.report.environments[0]?.observation?.remoteSource;
    expect(remote?.remoteHeadSha).toBe(head);
    expect(remote?.availability?.state).toBe('available');
    const codes = execution.report.findings.map((finding) => finding.code);
    expect(codes).toContain('NO_UPSTREAM_CONFIGURED');
    expect(codes).not.toContain('STALE_TRACKING_REF');
  });

  it('does not require a GitHub call when the source provider is absent', async () => {
    const dir = tempDir('dt-gh-nosource-');
    const path = join(dir, 'deploytruth.yml');
    writeFileSync(
      path,
      `version: 1
project: example
environments:
  production:
    kind: production
`,
    );

    const calls: string[] = [];
    const execution = await runEnvironmentCheck({
      configPath: path,
      environmentName: 'production',
      githubProvider: createFixtureGitHubProvider({}, calls),
    });

    expect(calls).toEqual([]);
    expect(execution.report.environments[0]?.observation?.remoteSource).toBeUndefined();
  });

  it('keeps verdict WARN when local work is ahead of the observed GitHub head', async () => {
    const dir = initRepo(tempDir('dt-gh-ahead-'));
    const base = git(['rev-parse', 'HEAD'], dir);
    const local = commit(dir, 'unpushed-work');
    configureUpstream(dir, base);

    const execution = await runEnvironmentCheck({
      configPath: manifestAt(dir),
      environmentName: 'production',
      githubProvider: createFixtureGitHubProvider({ remoteSha: base }),
    });

    const codes = execution.report.findings.map((finding) => finding.code);
    expect(codes).toContain('LOCAL_HEAD_DIFFERS_FROM_GITHUB');
    expect(codes).toContain('LOCAL_BRANCH_AHEAD_OF_UPSTREAM');
    expect(codes).not.toContain('STALE_TRACKING_REF');
    expect(execution.report.verdict).toBe('WARN');
    expect(local).not.toBe(base);
  });
});
