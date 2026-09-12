import { writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { parseTruthReport, serializeTruthReport } from '@deploytruth/reporter';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatCheckReport, runEnvironmentCheck } from '../packages/cli/src/check.js';
import { createCli } from '../packages/cli/src/index.js';
import {
  canonical,
  cleanupTempDirs,
  commit,
  configureUpstream,
  git,
  initRepo,
  tempDir,
  write,
} from './git-test-utils.js';
import { createFixtureGitHubProvider } from './github-test-utils.js';
import {
  createFixtureMigrationCatalogProvider,
  createFixtureSupabaseProvider,
} from './supabase-test-utils.js';

const MANIFEST = `version: 1
project: example
environments:
  production:
    kind: production
    source: { provider: github, repository: example/example-app, branch: main }
    deployment: { provider: vercel, project: example-app }
    database: { provider: supabase, project_ref: prodabc123 }
`;

const manifestAt = (directory: string): string => {
  const path = join(directory, 'deploytruth.yml');
  writeFileSync(path, MANIFEST);
  return path;
};

afterEach(cleanupTempDirs);

describe('deploytruth check --environment', () => {
  it('incorporates real local Git truth and stays WARN while runtime providers are unimplemented', async () => {
    const dir = initRepo(tempDir('dt-check-clean-'));
    const head = git(['rev-parse', 'HEAD'], dir);
    configureUpstream(dir, head);

    const execution = await runEnvironmentCheck({
      configPath: manifestAt(dir),
      environmentName: 'production',
      githubProvider: createFixtureGitHubProvider({ remoteSha: head }),
      supabaseProvider: createFixtureSupabaseProvider(),
      migrationCatalogProvider: createFixtureMigrationCatalogProvider({
        sourceSha: head,
        migrationIds: [],
      }),
    });
    const report = execution.report;

    expect(report.verdict).toBe('WARN');
    expect(report.verdict).not.toBe('PASS');
    const source = report.environments[0]?.observation?.source;
    expect(source?.provider).toBe('git');
    expect(source?.branch).toBe('main');
    expect(source?.workingTree).toBe('dirty'); // deploytruth.yml itself is untracked
    expect(source?.upstream?.ref).toBe('refs/remotes/origin/main');
    // Local tracking ref truth must not be presented as remote-authoritative.
    expect(source?.remoteHeadSha).toBeUndefined();
    // The GitHub observation is a separate, remote-authoritative evidence object.
    const remote = report.environments[0]?.observation?.remoteSource;
    expect(remote?.provider).toBe('github');
    expect(remote?.remoteHeadSha).toBe(head);
    // The Supabase observation is a real evidence object, not a stub section.
    const database = report.environments[0]?.observation?.database;
    expect(database?.provider).toBe('supabase');
    expect(database?.identity).toBe('verified');
    expect(report.environments[0]?.observation?.repositoryMigrations?.sourceSha).toBe(head);

    const output = formatCheckReport(execution);
    expect(output).toContain('Git repository');
    expect(output).toContain('Tracking ref');
    expect(output).toContain('local ref; remote unverified');
    expect(output).toContain('GitHub');
    expect(output).toContain('Authoritative SHA');
    expect(output).toContain('DATABASE');
    expect(output).toContain('Supabase');
    expect(output).toContain('Database identity');
    expect(output).toContain('VERIFIED');
    expect(output).toContain('WARN');
  });

  it('reports a diagnostic instead of deployment truth outside a repository', async () => {
    const dir = tempDir('dt-check-norepo-');
    const execution = await runEnvironmentCheck({
      configPath: manifestAt(dir),
      environmentName: 'production',
      githubProvider: createFixtureGitHubProvider(),
      supabaseProvider: createFixtureSupabaseProvider(),
    });

    expect(execution.report.verdict).toBe('WARN');
    expect(execution.diagnostics.join('\n')).toContain('not inside a Git repository');
    expect(execution.report.findings.map((finding) => finding.code)).toContain(
      'REQUIRED_OBSERVATION_UNAVAILABLE',
    );
    const output = formatCheckReport(execution);
    expect(output).toContain('NOT OBSERVED');
  });

  it('surfaces dirty worktree and ahead state in findings', async () => {
    const dir = initRepo(tempDir('dt-check-ahead-'));
    const base = git(['rev-parse', 'HEAD'], dir);
    commit(dir, 'unpushed');
    configureUpstream(dir, base);
    write(dir, 'notes.txt', 'dirty');

    const execution = await runEnvironmentCheck({
      configPath: manifestAt(dir),
      environmentName: 'production',
      githubProvider: createFixtureGitHubProvider({ remoteSha: base }),
      supabaseProvider: createFixtureSupabaseProvider(),
    });
    const codes = execution.report.findings.map((finding) => finding.code);

    expect(codes).toContain('DIRTY_WORKTREE');
    expect(codes).toContain('LOCAL_BRANCH_AHEAD_OF_UPSTREAM');
  });

  it('promotes warnings to FAIL under --strict', async () => {
    const dir = initRepo(tempDir('dt-check-strict-'));

    const execution = await runEnvironmentCheck({
      configPath: manifestAt(dir),
      environmentName: 'production',
      strict: true,
      githubProvider: createFixtureGitHubProvider({
        remoteSha: git(['rev-parse', 'HEAD'], dir),
      }),
      supabaseProvider: createFixtureSupabaseProvider(),
    });

    expect(execution.report.strict).toBe(true);
    expect(execution.report.verdict).toBe('FAIL');
  });

  it('rejects an undeclared environment name', async () => {
    const dir = initRepo(tempDir('dt-check-badenv-'));

    await expect(
      runEnvironmentCheck({
        configPath: manifestAt(dir),
        environmentName: 'staging',
      }),
    ).rejects.toMatchObject({ name: 'ConfigError' });
  });

  it('serializes reports without absolute changed-file paths or secrets', async () => {
    const dir = initRepo(tempDir('dt-check-report-'));
    write(dir, 'dirty.txt', 'x');
    const execution = await runEnvironmentCheck({
      configPath: manifestAt(dir),
      environmentName: 'production',
      githubProvider: createFixtureGitHubProvider({
        remoteSha: git(['rev-parse', 'HEAD'], dir),
      }),
      supabaseProvider: createFixtureSupabaseProvider(),
    });

    const serialized = serializeTruthReport(execution.report);
    const parsed = parseTruthReport(serialized);
    const source = parsed.environments[0]?.observation?.source;

    expect(source).toBeDefined();
    for (const path of [
      ...(source?.stagedFiles ?? []),
      ...(source?.modifiedFiles ?? []),
      ...(source?.untrackedFiles ?? []),
      ...(source?.unmergedFiles ?? []),
    ]) {
      expect(isAbsolute(path)).toBe(false);
    }
    expect(serialized).not.toContain('Bearer ');
    expect(serialized).not.toContain('ghp_');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('rawOnlySentinel');
    // The repository root is intentionally absolute — it is the identity of the observation.
    expect(source?.repositoryRoot).toBe(canonical(dir));
  });

  it('runs through the commander wiring with a real repository', async () => {
    const dir = initRepo(tempDir('dt-check-cli-'));
    const head = git(['rev-parse', 'HEAD'], dir);
    configureUpstream(dir, head);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const previousExit = process.exitCode;

    try {
      await createCli({
        githubProvider: createFixtureGitHubProvider({ remoteSha: head }),
        supabaseProvider: createFixtureSupabaseProvider(),
      }).parseAsync([
        'node',
        'deploytruth',
        'check',
        '-c',
        manifestAt(dir),
        '-e',
        'production',
        '--json',
      ]);
      const output = log.mock.calls.map((call) => String(call[0])).join('\n');
      const report = parseTruthReport(output);
      expect(report.verdict).toBe('WARN');
      expect(report.environments[0]?.observation?.source?.provider).toBe('git');
      expect(process.exitCode).toBe(0);
    } finally {
      log.mockRestore();
      process.exitCode = previousExit;
    }
  });
});
