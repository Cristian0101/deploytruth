import { join } from 'node:path';

import {
  createLocalGitProvider,
  createNodeGitRunner,
  type SourceObservation,
} from '@deploytruth/providers';
import { afterEach, describe, expect, it } from 'vitest';

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

const provider = createLocalGitProvider();

const observe = (directory: string): Promise<SourceObservation> =>
  provider.observe({
    project: 'test-project',
    environment: 'production',
    config: provider.validateConfig({ directory }),
  });

afterEach(cleanupTempDirs);

describe('local Git adapter against real temporary repositories', () => {
  it('CASE 1: observes a clean repository', async () => {
    const dir = initRepo(tempDir('dt-clean-'));
    const headSha = git(['rev-parse', 'HEAD'], dir);

    const observation = await observe(dir);

    expect(observation.provider).toBe('git');
    expect(observation.branch).toBe('main');
    expect(observation.headSha).toBe(headSha);
    expect(observation.detachedHead).toBe(false);
    expect(observation.workingTree).toBe('clean');
    expect(observation.stagedCount).toBe(0);
    expect(observation.modifiedCount).toBe(0);
    expect(observation.untrackedCount).toBe(0);
    expect(observation.repositoryRoot).toBe(canonical(dir));
    expect(observation.isLinkedWorktree).toBe(false);
    expect(observation.worktrees).toHaveLength(1);
    expect(observation.worktrees[0]?.path).toBe(canonical(dir));
    expect(observation.operationsInProgress).toEqual([]);
    // Never implies remote-authoritative truth.
    expect(observation.remoteHeadSha).toBeUndefined();
  });

  it('CASE 2: detects a modified tracked file', async () => {
    const dir = initRepo(tempDir('dt-modified-'));
    write(dir, 'tracked.txt', 'v1');
    git(['add', 'tracked.txt'], dir);
    commit(dir, 'add tracked');
    write(dir, 'tracked.txt', 'v2');

    const observation = await observe(dir);

    expect(observation.workingTree).toBe('dirty');
    expect(observation.modifiedCount).toBe(1);
    expect(observation.modifiedFiles).toEqual(['tracked.txt']);
    expect(observation.stagedCount).toBe(0);
  });

  it('CASE 3: detects a staged file', async () => {
    const dir = initRepo(tempDir('dt-staged-'));
    write(dir, 'staged.txt', 'contents');
    git(['add', 'staged.txt'], dir);

    const observation = await observe(dir);

    expect(observation.workingTree).toBe('dirty');
    expect(observation.stagedCount).toBe(1);
    expect(observation.stagedFiles).toEqual(['staged.txt']);
    expect(observation.stagedFiles.every((path) => !path.startsWith('/'))).toBe(true);
  });

  it('CASE 4: detects an untracked file', async () => {
    const dir = initRepo(tempDir('dt-untracked-'));
    write(dir, 'untracked.txt', 'x');

    const observation = await observe(dir);

    expect(observation.workingTree).toBe('dirty');
    expect(observation.untrackedCount).toBe(1);
    expect(observation.untrackedFiles).toEqual(['untracked.txt']);
  });

  it('CASE 5: detects detached HEAD', async () => {
    const dir = initRepo(tempDir('dt-detached-'));
    const headSha = git(['rev-parse', 'HEAD'], dir);
    git(['checkout', '--detach', 'HEAD'], dir);

    const observation = await observe(dir);

    expect(observation.detachedHead).toBe(true);
    expect(observation.branch).toBeUndefined();
    expect(observation.headSha).toBe(headSha);
    expect(observation.upstream).toBeUndefined();
    expect(observation.aheadBy).toBeUndefined();
  });

  it('CASE 6: observes a configured upstream with no difference', async () => {
    const dir = initRepo(tempDir('dt-upstream-synced-'));
    configureUpstream(dir, git(['rev-parse', 'HEAD'], dir));

    const observation = await observe(dir);

    expect(observation.upstream).toMatchObject({
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      sha: git(['rev-parse', 'HEAD'], dir),
    });
    expect(observation.aheadBy).toBe(0);
    expect(observation.behindBy).toBe(0);
    expect(observation.remoteNames).toEqual(['origin']);
  });

  it('CASE 7: detects a branch ahead of upstream', async () => {
    const dir = initRepo(tempDir('dt-ahead-'));
    const first = git(['rev-parse', 'HEAD'], dir);
    commit(dir, 'second');
    configureUpstream(dir, first);

    const observation = await observe(dir);

    expect(observation.aheadBy).toBe(1);
    expect(observation.behindBy).toBe(0);
  });

  it('CASE 8: detects a branch behind upstream', async () => {
    const dir = initRepo(tempDir('dt-behind-'));
    const head = git(['rev-parse', 'HEAD'], dir);
    const newer = commit(dir, 'remote-side');
    // Move main back and point the tracking ref at the newer commit.
    git(['update-ref', 'refs/heads/main', head], dir);
    configureUpstream(dir, newer);

    const observation = await observe(dir);

    expect(observation.headSha).toBe(head);
    expect(observation.aheadBy).toBe(0);
    expect(observation.behindBy).toBe(1);
    expect(observation.upstream?.sha).toBe(newer);
  });

  it('CASE 9: detects a diverged branch', async () => {
    const dir = initRepo(tempDir('dt-diverged-'));
    const base = git(['rev-parse', 'HEAD'], dir);
    const side = commit(dir, 'remote-side');
    git(['update-ref', 'refs/heads/main', base], dir);
    commit(dir, 'local-side');
    configureUpstream(dir, side);

    const observation = await observe(dir);

    expect(observation.aheadBy).toBe(1);
    expect(observation.behindBy).toBe(1);
  });

  it('CASE 10: identifies linked worktrees and the common Git directory', async () => {
    const dir = initRepo(tempDir('dt-worktree-main-'));
    const linked = join(tempDir('dt-worktree-parent-'), 'linked');
    git(['worktree', 'add', linked, '-b', 'feature'], dir);

    const mainObservation = await observe(dir);
    expect(mainObservation.isLinkedWorktree).toBe(false);
    expect(mainObservation.worktrees).toHaveLength(2);
    expect(mainObservation.worktrees.map((worktree) => worktree.path).sort()).toEqual(
      [canonical(dir), canonical(linked)].sort(),
    );

    const linkedObservation = await observe(linked);
    expect(linkedObservation.isLinkedWorktree).toBe(true);
    expect(linkedObservation.branch).toBe('feature');
    expect(linkedObservation.repositoryRoot).toBe(canonical(linked));
    expect(linkedObservation.commonGitDirectory).toBe(mainObservation.gitDirectory);
    expect(linkedObservation.worktrees).toHaveLength(2);
  });

  it('CASE 11: fails safely for a directory outside any repository', async () => {
    const dir = tempDir('dt-not-repo-');

    await expect(observe(dir)).rejects.toMatchObject({
      name: 'GitError',
      code: 'NOT_A_REPOSITORY',
    });
  });

  it('CASE 12a: surfaces Git-not-installed via the injected runner', async () => {
    const missingGit = createNodeGitRunner({ executable: 'definitely-not-git-xyz' });
    const failingProvider = createLocalGitProvider({ runner: missingGit });
    const dir = initRepo(tempDir('dt-no-git-'));

    await expect(
      failingProvider.observe({
        project: 'test-project',
        environment: 'production',
        config: failingProvider.validateConfig({ directory: dir }),
      }),
    ).rejects.toMatchObject({ name: 'GitError', code: 'GIT_NOT_AVAILABLE' });
  });

  it('CASE 12b: normalizes unexpected runner failures', async () => {
    const fakeRunner = {
      run: async () => ({ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' }),
    };
    const fakeProvider = createLocalGitProvider({ runner: fakeRunner });

    await expect(
      fakeProvider.observe({
        project: 'test-project',
        environment: 'production',
        config: fakeProvider.validateConfig({ directory: '/nonexistent' }),
      }),
    ).rejects.toMatchObject({ code: 'NOT_A_REPOSITORY' });
  });

  it('observes an unborn branch without a HEAD commit', async () => {
    const dir = tempDir('dt-unborn-');
    git(['init', '-b', 'main'], dir);
    write(dir, 'first.txt', 'x');

    const observation = await observe(dir);

    expect(observation.branch).toBe('main');
    expect(observation.headSha).toBeUndefined();
    expect(observation.detachedHead).toBe(false);
    expect(observation.untrackedCount).toBe(1);
  });

  it('detects a merge in progress as an unusual repository state', async () => {
    const dir = initRepo(tempDir('dt-merging-'));
    git(['checkout', '-b', 'side'], dir);
    write(dir, 'conflict.txt', 'side');
    git(['add', 'conflict.txt'], dir);
    commit(dir, 'side');
    git(['checkout', 'main'], dir);
    write(dir, 'conflict.txt', 'main');
    git(['add', 'conflict.txt'], dir);
    commit(dir, 'main');
    expect(() => git(['merge', 'side'], dir)).toThrow();

    const observation = await observe(dir);

    expect(observation.operationsInProgress).toContain('merge');
    expect(observation.unmergedCount).toBe(1);
    expect(observation.unmergedFiles).toEqual(['conflict.txt']);
  });
});
