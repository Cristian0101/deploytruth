import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GitError } from './errors.js';
import { assertReadOnlyGitInvocation, createNodeGitRunner } from './runner.js';

describe('read-only invocation guard', () => {
  it.each([
    ['push', 'origin', 'main'],
    ['fetch', 'origin'],
    ['pull'],
    ['commit', '-m', 'x'],
    ['reset', '--hard'],
    ['clean', '-fd'],
    ['checkout', 'main'],
    ['merge', 'x'],
    ['rebase'],
    ['stash'],
    ['gc'],
    ['prune'],
    ['update-ref', 'refs/heads/x', 'HEAD'],
    ['remote', 'add', 'origin', 'https://example.invalid/x.git'],
    ['remote', '-v'],
    ['config', '--global', 'user.email', 'x'],
    ['config', 'user.email', 'x'],
    ['worktree', 'add', '/tmp/x'],
    ['worktree', 'remove', 'x'],
    ['symbolic-ref', 'HEAD', 'refs/heads/x'],
    ['-c', 'core.x=y', 'status'],
    ['--git-dir', '/tmp/x', 'status'],
    ['status; rm -rf /'],
    ['status', '--porcelain', '; rm -rf /'],
    [],
  ] as const)('rejects %j', async (...args: readonly string[]) => {
    const runner = createNodeGitRunner();
    await expect(runner.run(args)).rejects.toMatchObject({
      name: 'GitError',
      code: 'GIT_COMMAND_REJECTED',
    });
    expect(() => assertReadOnlyGitInvocation(args)).toThrow(GitError);
  });

  it.each([
    ['version'],
    ['rev-parse', '--show-toplevel'],
    ['rev-parse', '--verify', 'HEAD'],
    ['status', '--porcelain', '-z', '--untracked-files=normal'],
    ['remote'],
    ['config', '--get', 'branch.main.remote'],
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    ['worktree', 'list', '--porcelain'],
    ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
  ] as const)('allows %j', (...args: readonly string[]) => {
    expect(() => assertReadOnlyGitInvocation(args)).not.toThrow();
  });
});

describe('node git runner', () => {
  it('runs git directly without a shell and normalizes output', async () => {
    const runner = createNodeGitRunner();
    const result = await runner.run(['version']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^git version /);
  });

  it('never interpolates arguments into a shell', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dt-runner-'));
    const marker = join(directory, 'pwned');
    const runner = createNodeGitRunner();

    const result = await runner.run(['rev-parse', '--verify', `HEAD;touch ${marker}`], {
      cwd: directory,
    });

    expect(result.exitCode).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it('returns non-zero exits as results rather than throwing', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dt-runner-nonrepo-'));
    const runner = createNodeGitRunner();

    const result = await runner.run(['rev-parse', '--is-inside-work-tree'], { cwd: directory });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('not a git repository');
  });

  it('maps a missing executable to GIT_NOT_AVAILABLE', async () => {
    const runner = createNodeGitRunner({ executable: 'definitely-not-git-xyz' });

    await expect(runner.run(['version'])).rejects.toMatchObject({
      code: 'GIT_NOT_AVAILABLE',
    });
  });

  it('enforces timeouts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dt-runner-timeout-'));
    const sleeper = join(directory, 'sleeper.sh');
    writeFileSync(sleeper, '#!/bin/sh\nsleep 30\n');
    chmodSync(sleeper, 0o755);

    const runner = createNodeGitRunner({ executable: sleeper });
    await expect(runner.run(['version'], { timeoutMs: 150 })).rejects.toMatchObject({
      code: 'GIT_TIMEOUT',
    });
  });
});
