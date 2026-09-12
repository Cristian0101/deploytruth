import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertReadOnlyGitInvocation,
  createGitMigrationCatalogProvider,
  createNodeGitRunner,
  type GitMigrationCatalogConfig,
} from '@deploytruth/providers';
import { afterEach, describe, expect, it } from 'vitest';

import { cleanupTempDirs, commit, git, initRepo, tempDir, write } from './git-test-utils.js';

const provider = createGitMigrationCatalogProvider();

const observe = (directory: string, migrationDirectory = 'supabase/migrations') =>
  provider.observe({
    project: 'test-project',
    environment: 'production',
    config: provider.validateConfig({ directory, migrationDirectory }) as GitMigrationCatalogConfig,
  });

const addMigration = (directory: string, filename: string, contents = 'select 1;'): void => {
  mkdirSync(join(directory, 'supabase/migrations'), { recursive: true });
  write(directory, `supabase/migrations/${filename}`, contents);
  git(['add', `supabase/migrations/${filename}`], directory);
};

afterEach(cleanupTempDirs);

describe('Git migration catalog provider', () => {
  it('reads the expected migration set from the immutable HEAD tree', async () => {
    const dir = initRepo(tempDir('dt-mig-'));
    addMigration(dir, '20240101000000_init.sql');
    addMigration(dir, '20240102000000_profiles.sql');
    const head = commit(dir, 'migrations');

    const observation = await observe(dir);

    expect(observation.availability?.state).toBe('available');
    expect(observation.sourceSha).toBe(head);
    expect(observation.origin).toBe('git-tree');
    expect(observation.directory).toBe('supabase/migrations');
    expect(observation.migrationIds).toEqual(['20240101000000', '20240102000000']);
  });

  it('extracts only the version prefix, never the descriptive name', async () => {
    const dir = initRepo(tempDir('dt-mig-name-'));
    addMigration(dir, '20240330153045_create_users_and_profiles.sql');
    commit(dir, 'migrations');

    const observation = await observe(dir);

    expect(observation.migrationIds).toEqual(['20240330153045']);
  });

  it('records repeatable migrations with their r_ version', async () => {
    const dir = initRepo(tempDir('dt-mig-repeat-'));
    addMigration(dir, '20240101000000_init.sql');
    addMigration(dir, 'r_refresh_views.sql');
    commit(dir, 'migrations');

    const observation = await observe(dir);

    expect(observation.availability?.state).toBe('available');
    expect(observation.migrationIds).toEqual(['20240101000000', 'r_refresh_views']);
  });

  it('ignores non-.sql files in the migration directory', async () => {
    const dir = initRepo(tempDir('dt-mig-nonsql-'));
    addMigration(dir, '20240101000000_init.sql');
    write(dir, 'supabase/migrations/README.md', 'docs');
    write(dir, 'supabase/migrations/.DS_Store', 'junk');
    git(['add', 'supabase/migrations'], dir);
    commit(dir, 'migrations');

    const observation = await observe(dir);

    expect(observation.availability?.state).toBe('available');
    expect(observation.migrationIds).toEqual(['20240101000000']);
  });

  it('never reads the working tree: dirty and untracked migration files are invisible', async () => {
    const dir = initRepo(tempDir('dt-mig-dirty-'));
    addMigration(dir, '20240101000000_init.sql');
    const head = commit(dir, 'migrations');

    // Working-tree mutations after the commit must not contaminate expected truth.
    addMigration(dir, '20240105000000_untracked.sql');
    write(dir, 'supabase/migrations/20240101000000_init.sql', 'select 999;');

    const observation = await observe(dir);

    expect(observation.availability?.state).toBe('available');
    expect(observation.sourceSha).toBe(head);
    expect(observation.migrationIds).toEqual(['20240101000000']);
  });

  it('reflects the committed catalog at HEAD after a new migration commit', async () => {
    const dir = initRepo(tempDir('dt-mig-move-'));
    addMigration(dir, '20240101000000_init.sql');
    commit(dir, 'first');
    addMigration(dir, '20240102000000_next.sql');
    const head = commit(dir, 'second');

    const observation = await observe(dir);

    expect(observation.sourceSha).toBe(head);
    expect(observation.migrationIds).toEqual(['20240101000000', '20240102000000']);
  });

  it('reports directory_missing when the declared path is absent from the tree', async () => {
    const dir = initRepo(tempDir('dt-mig-missing-'));

    const observation = await observe(dir);

    expect(observation.availability?.state).toBe('unavailable');
    expect(observation.availability?.reason).toBe('directory_missing');
    expect(observation.migrationIds).toEqual([]);
  });

  it('reports not_a_directory when the declared path is a file', async () => {
    const dir = initRepo(tempDir('dt-mig-file-'));
    mkdirSync(join(dir, 'supabase'), { recursive: true });
    write(dir, 'supabase/migrations', 'not a directory');
    git(['add', 'supabase/migrations'], dir);
    commit(dir, 'file');

    const observation = await observe(dir);

    expect(observation.availability?.reason).toBe('not_a_directory');
  });

  it('reports not_a_repository outside a Git working tree', async () => {
    const dir = tempDir('dt-mig-norepo-');

    const observation = await observe(dir);

    expect(observation.availability?.reason).toBe('not_a_repository');
  });

  it('reports head_unavailable in a repository with no commits', async () => {
    const dir = tempDir('dt-mig-nocommit-');
    git(['init', '-b', 'main'], dir);
    git(['config', 'user.email', 'deploytruth-test@example.invalid'], dir);
    git(['config', 'user.name', 'DeployTruth Test'], dir);
    addMigration(dir, '20240101000000_init.sql');

    const observation = await observe(dir);

    expect(observation.availability?.reason).toBe('head_unavailable');
    expect(observation.migrationIds).toEqual([]);
  });

  it('flags .sql files that fail the Supabase migration grammar as invalid', async () => {
    const dir = initRepo(tempDir('dt-mig-invalid-'));
    addMigration(dir, '20240101000000_init.sql');
    write(dir, 'supabase/migrations/add_users.sql', 'select 1;');
    git(['add', 'supabase/migrations'], dir);
    commit(dir, 'migrations');

    const observation = await observe(dir);

    expect(observation.availability?.reason).toBe('invalid_filenames');
    expect(observation.availability?.invalidFilenames).toEqual(['add_users.sql']);
  });

  it('flags duplicate migration versions', async () => {
    const dir = initRepo(tempDir('dt-mig-dup-'));
    addMigration(dir, '20240101000000_first.sql');
    addMigration(dir, '20240101000000_second.sql');
    commit(dir, 'migrations');

    const observation = await observe(dir);

    expect(observation.availability?.reason).toBe('duplicate_versions');
    expect(observation.availability?.duplicateVersions).toEqual(['20240101000000']);
  });

  it('honours the legacy <timestamp>_init.sql first-entry skip', async () => {
    const dir = initRepo(tempDir('dt-mig-init-'));
    addMigration(dir, '20201101000000_init.sql');
    addMigration(dir, '20240101000000_profiles.sql');
    commit(dir, 'migrations');

    const observation = await observe(dir);

    expect(observation.migrationIds).toEqual(['20240101000000']);
  });

  it('keeps a legacy-looking init file that is not the first entry', async () => {
    const dir = initRepo(tempDir('dt-mig-init2-'));
    addMigration(dir, '20201101000000_init.sql');
    addMigration(dir, '20201001000000_earlier.sql');
    commit(dir, 'migrations');

    const observation = await observe(dir);

    expect(observation.migrationIds).toEqual(['20201001000000', '20201101000000']);
  });

  it('reads catalogs relative to the repository root even when invoked from a subdirectory', async () => {
    const dir = initRepo(tempDir('dt-mig-subdir-'));
    addMigration(dir, '20240101000000_init.sql');
    commit(dir, 'migrations');
    const nested = join(dir, 'tools');
    mkdirSync(nested, { recursive: true });

    const observation = await observe(nested);

    expect(observation.availability?.state).toBe('available');
    expect(observation.migrationIds).toEqual(['20240101000000']);
  });

  it('sorts versions deterministically regardless of commit order', async () => {
    const dir = initRepo(tempDir('dt-mig-sort-'));
    addMigration(dir, '20240103000000_c.sql');
    addMigration(dir, '20240101000000_a.sql');
    addMigration(dir, '20240102000000_b.sql');
    commit(dir, 'migrations');

    const observation = await observe(dir);

    expect(observation.migrationIds).toEqual([
      '20240101000000',
      '20240102000000',
      '20240103000000',
    ]);
  });
});

describe('git ls-tree read-only allowlist', () => {
  it.each([
    [['ls-tree', 'HEAD', 'supabase/migrations/']],
    [['ls-tree', 'a'.repeat(40), 'supabase/migrations']],
  ] as const)('permits %j', (args) => {
    expect(() => assertReadOnlyGitInvocation(args)).not.toThrow();
  });

  it.each([
    [['ls-tree', 'HEAD']],
    [['ls-tree', '-r', 'HEAD', 'supabase/migrations']],
    [['ls-tree', '--name-only', 'HEAD', 'supabase/migrations']],
    [['ls-tree', 'HEAD..OTHER', 'supabase/migrations']],
    [['ls-tree', 'HEAD', '../escape']],
    [['ls-tree', 'HEAD', '/absolute/path']],
    [['ls-tree', 'HEAD', 'dir;rm -rf /']],
    [['ls-tree', '--abbrev', '8', 'HEAD', 'dir']],
  ] as const)('rejects %j', async (args) => {
    const runner = createNodeGitRunner();
    await expect(runner.run(args)).rejects.toMatchObject({ code: 'GIT_COMMAND_REJECTED' });
  });
});
