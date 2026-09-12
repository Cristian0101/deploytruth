import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { serializeTruthReport } from '@deploytruth/reporter';
import { afterEach, describe, expect, it } from 'vitest';

import { formatCheckReport, runEnvironmentCheck } from '../packages/cli/src/check.js';
import {
  cleanupTempDirs,
  commit,
  configureUpstream,
  git,
  initRepo,
  tempDir,
  write,
} from './git-test-utils.js';
import { createFixtureGitHubProvider } from './github-test-utils.js';
import { createFixtureSupabaseProvider } from './supabase-test-utils.js';

const REF = 'prodabc123';
const OTHER_REF = 'otherproject99';

const MANIFEST = `version: 1
project: example
environments:
  production:
    kind: production
    source: { provider: github, repository: example/example-app, branch: main }
    deployment: { provider: vercel, project: example-app }
    database:
      provider: supabase
      project_ref: ${REF}
      migrations:
        directory: supabase/migrations
`;

const manifestAt = (directory: string): string => {
  const path = join(directory, 'deploytruth.yml');
  writeFileSync(path, MANIFEST);
  return path;
};

const addMigration = (directory: string, filename: string): void => {
  mkdirSync(join(directory, 'supabase/migrations'), { recursive: true });
  write(directory, `supabase/migrations/${filename}`, 'select 1;');
  git(['add', `supabase/migrations/${filename}`], directory);
};

afterEach(cleanupTempDirs);

const baseRepo = (): { dir: string; head: string } => {
  const dir = initRepo(tempDir('dt-supabase-'));
  addMigration(dir, '20240101000000_init.sql');
  addMigration(dir, '20240102000000_profiles.sql');
  const head = commit(dir, 'migrations');
  configureUpstream(dir, head);
  return { dir, head };
};

describe('deploytruth check with Supabase', () => {
  it('VERIFIES a healthy migration history end-to-end', async () => {
    const { dir, head } = baseRepo();

    const execution = await runEnvironmentCheck({
      configPath: manifestAt(dir),
      environmentName: 'production',
      githubProvider: createFixtureGitHubProvider({ remoteSha: head }),
      supabaseProvider: createFixtureSupabaseProvider({
        appliedMigrationIds: ['20240101000000', '20240102000000'],
      }),
    });

    const database = execution.report.environments[0]?.observation?.database;
    expect(database?.identity).toBe('verified');
    expect(database?.controlPlane?.state).toBe('available');

    const catalog = execution.report.environments[0]?.observation?.repositoryMigrations;
    expect(catalog?.sourceSha).toBe(head);
    expect(catalog?.migrationIds).toEqual(['20240101000000', '20240102000000']);

    const output = formatCheckReport(execution);
    expect(output).toContain('DATABASE');
    expect(output).toContain('Supabase');
    expect(output).toContain('Declared project');
    expect(output).toContain(REF);
    expect(output).toContain('Project access');
    expect(output).toContain('AVAILABLE');
    expect(output).toContain('VERIFIED — ' + REF);
    expect(output).toContain('Migration source');
    expect(output).toContain(head.slice(0, 7));
    expect(output).toContain('Expected migrations');
    expect(output).toContain('Applied migrations');
    expect(output).toContain('MIGRATIONS VERIFIED');
  });

  it('reports DATABASE_MIGRATIONS_BEHIND when the database lacks a source migration', async () => {
    const { dir, head } = baseRepo();

    const execution = await runEnvironmentCheck({
      configPath: manifestAt(dir),
      environmentName: 'production',
      githubProvider: createFixtureGitHubProvider({ remoteSha: head }),
      supabaseProvider: createFixtureSupabaseProvider({
        appliedMigrationIds: ['20240101000000'],
      }),
    });

    const finding = execution.report.findings.find(
      (entry) => entry.code === 'DATABASE_MIGRATIONS_BEHIND',
    );
    expect(finding?.status).toBe('FAIL');
    expect(execution.report.verdict).toBe('FAIL');

    const output = formatCheckReport(execution);
    expect(output).toContain('DATABASE_MIGRATIONS_BEHIND');
    expect(output).toContain('Expected migrations');
    expect(output).toContain('2');
  });

  it('reports WRONG_DATABASE_PROJECT when the connection identifies another project', async () => {
    const { dir, head } = baseRepo();

    const execution = await runEnvironmentCheck({
      configPath: manifestAt(dir),
      environmentName: 'production',
      githubProvider: createFixtureGitHubProvider({ remoteSha: head }),
      supabaseProvider: createFixtureSupabaseProvider({
        observedProjectRef: OTHER_REF,
      }),
    });

    const finding = execution.report.findings.find(
      (entry) => entry.code === 'WRONG_DATABASE_PROJECT',
    );
    expect(finding?.status).toBe('FAIL');
    expect(execution.report.verdict).toBe('FAIL');

    const output = formatCheckReport(execution);
    expect(output).toContain('MISMATCH');
    expect(output).toContain(OTHER_REF);
    // A wrong-project database can never be certified — even with matching history.
    expect(output).not.toContain('MIGRATIONS VERIFIED');
  });

  it('reports MIGRATION_SOURCE_UNAVAILABLE when local HEAD is not the authoritative SHA', async () => {
    const { dir } = baseRepo();
    const remoteSha = 'f'.repeat(40);

    const execution = await runEnvironmentCheck({
      configPath: manifestAt(dir),
      environmentName: 'production',
      githubProvider: createFixtureGitHubProvider({ remoteSha }),
      supabaseProvider: createFixtureSupabaseProvider({
        appliedMigrationIds: ['20240101000000', '20240102000000'],
      }),
    });

    const finding = execution.report.findings.find(
      (entry) => entry.code === 'MIGRATION_SOURCE_UNAVAILABLE',
    );
    expect(finding?.status).toBe('WARN');
    expect(execution.report.verdict).toBe('WARN');
    expect(execution.report.verdict).not.toBe('PASS');

    const output = formatCheckReport(execution);
    expect(output).toContain('MIGRATION_SOURCE_UNAVAILABLE');
    expect(output).not.toContain('MIGRATIONS VERIFIED');
  });

  it('ignores dirty and untracked migration files — only the committed tree counts', async () => {
    const { dir, head } = baseRepo();
    // Working-tree-only migration that must never enter expected truth.
    write(dir, 'supabase/migrations/20240105000000_untracked.sql', 'select 1;');
    write(dir, 'supabase/migrations/20240101000000_init.sql', 'select 999; -- dirty edit');

    const execution = await runEnvironmentCheck({
      configPath: manifestAt(dir),
      environmentName: 'production',
      githubProvider: createFixtureGitHubProvider({ remoteSha: head }),
      supabaseProvider: createFixtureSupabaseProvider({
        appliedMigrationIds: ['20240101000000', '20240102000000'],
      }),
    });

    const catalog = execution.report.environments[0]?.observation?.repositoryMigrations;
    expect(catalog?.migrationIds).toEqual(['20240101000000', '20240102000000']);
    expect(catalog?.migrationIds).not.toContain('20240105000000');
    // The dirty worktree is still reported as local evidence.
    const codes = execution.report.findings.map((finding) => finding.code);
    expect(codes).toContain('DIRTY_WORKTREE');
  });

  it('reports MIGRATION_SOURCE_INVALID when the declared directory is missing', async () => {
    const dir = initRepo(tempDir('dt-supabase-nomig-'));
    const head = git(['rev-parse', 'HEAD'], dir);
    configureUpstream(dir, head);

    const execution = await runEnvironmentCheck({
      configPath: manifestAt(dir),
      environmentName: 'production',
      githubProvider: createFixtureGitHubProvider({ remoteSha: head }),
      supabaseProvider: createFixtureSupabaseProvider({}),
    });

    const finding = execution.report.findings.find(
      (entry) => entry.code === 'MIGRATION_SOURCE_INVALID',
    );
    expect(finding?.observed).toBe('directory_missing');
  });

  it('reports a refused insecure TLS configuration without claiming identity or migrations', async () => {
    const { dir, head } = baseRepo();

    const execution = await runEnvironmentCheck({
      configPath: manifestAt(dir),
      environmentName: 'production',
      githubProvider: createFixtureGitHubProvider({ remoteSha: head }),
      supabaseProvider: createFixtureSupabaseProvider({
        connection: {
          state: 'unavailable',
          reason: 'insecure_tls_configuration',
          detail:
            'The database URL requests a TLS configuration that cannot authenticate the endpoint; DeployTruth only connects over certificate-verified TLS.',
          targetProjectRef: REF,
          identitySource: 'direct_host',
        },
        migrationHistory: { state: 'unavailable', reason: 'connection_unavailable' },
      }),
    });

    const database = execution.report.environments[0]?.observation?.database;
    expect(database?.connection?.reason).toBe('insecure_tls_configuration');
    expect(database?.identity).toBeUndefined();
    expect(database?.observedProjectRef).toBeUndefined();

    const codes = execution.report.findings.map((finding) => finding.code);
    expect(codes).toContain('DATABASE_CONNECTION_UNAVAILABLE');
    expect(codes).toContain('REQUIRED_OBSERVATION_UNAVAILABLE');
    expect(execution.report.verdict).not.toBe('PASS');

    const output = formatCheckReport(execution);
    expect(output).toContain('UNAVAILABLE');
    expect(output).toContain('Connection target');
    expect(output).toContain('endpoint-derived — not an observed identity');
    expect(output).toContain('NOT OBSERVED');
    expect(output).not.toContain('MIGRATIONS VERIFIED');
  });

  it('serializes no credential material from the database evidence path', async () => {
    const { dir, head } = baseRepo();

    const execution = await runEnvironmentCheck({
      configPath: manifestAt(dir),
      environmentName: 'production',
      githubProvider: createFixtureGitHubProvider({ remoteSha: head }),
      supabaseProvider: createFixtureSupabaseProvider({}),
    });

    const serialized = serializeTruthReport(execution.report);
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('DEPLOYTRUTH_SUPABASE_DATABASE_URL=');
  });
});
