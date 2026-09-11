import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import { sourceObservationSchema, type SourceObservation } from '@deploytruth/core';
import { z } from 'zod';

import type { ObservationContext, ProviderDiagnostic, TruthProvider } from '../contracts.js';
import { GitError } from './errors.js';
import {
  parseAheadBehind,
  parseRemoteNames,
  parseStatusPorcelain,
  parseWorktreeList,
} from './parser.js';
import { createNodeGitRunner, type GitRunner } from './runner.js';

export const localGitConfigSchema = z
  .object({
    /** Directory inside the repository to inspect; defaults to the process cwd. */
    directory: z.string().min(1).optional(),
  })
  .strict();
export type LocalGitConfig = z.infer<typeof localGitConfigSchema>;

/** File lists are evidence samples; counts always carry the exact totals. */
export const MAX_REPORTED_PATHS = 100;

const GIT_OPERATION_MARKERS = [
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect'],
] as const;

const trimOutput = (value: string): string => value.trim();

export interface LocalGitProviderOptions {
  /** Injectable runner; production code uses the execFile-based default. */
  readonly runner?: GitRunner;
}

const canonical = async (path: string): Promise<string> => {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
};

const observeRepository = async (
  runner: GitRunner,
  directory: string,
  signal?: AbortSignal,
): Promise<SourceObservation> => {
  const run = (args: readonly string[]) =>
    runner.run(args, { cwd: directory, ...(signal ? { signal } : {}) });

  /** Result regardless of exit code; adapters interpret expected failures. */
  const probe = async (args: readonly string[]) => run(args);

  /** Result only when the command succeeds; unexpected failures throw. */
  const must = async (args: readonly string[], description: string) => {
    const result = await run(args);
    if (result.exitCode !== 0) {
      throw new GitError(
        'OBSERVATION_FAILED',
        `${description} failed: ${trimOutput(result.stderr) || `exit ${result.exitCode}`}`,
        { exitCode: result.exitCode, stderr: result.stderr },
      );
    }
    return result;
  };

  const inside = await probe(['rev-parse', '--is-inside-work-tree']);
  if (inside.exitCode !== 0) {
    throw new GitError('NOT_A_REPOSITORY', `${directory} is not inside a Git repository.`, {
      exitCode: inside.exitCode,
      stderr: inside.stderr,
    });
  }
  if (trimOutput(inside.stdout) !== 'true') {
    throw new GitError(
      'NOT_A_WORKTREE',
      `${directory} is inside a Git repository but not a working tree (bare repositories and .git directories are not observable).`,
    );
  }

  const repositoryRoot = trimOutput(
    (await must(['rev-parse', '--show-toplevel'], 'Locate repository root')).stdout,
  );
  const gitDirectory = resolve(
    directory,
    trimOutput((await must(['rev-parse', '--absolute-git-dir'], 'Locate Git directory')).stdout),
  );
  const commonGitDirectory = resolve(
    directory,
    trimOutput(
      (await must(['rev-parse', '--git-common-dir'], 'Locate common Git directory')).stdout,
    ),
  );

  const head = await probe(['rev-parse', '--verify', 'HEAD']);
  const headSha = head.exitCode === 0 ? trimOutput(head.stdout) : undefined;

  const symbolic = await probe(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch = symbolic.exitCode === 0 ? trimOutput(symbolic.stdout) : undefined;
  const detachedHead = branch === undefined && headSha !== undefined;

  const status = parseStatusPorcelain(
    (await must(['status', '--porcelain', '-z', '--untracked-files=normal'], 'Read status')).stdout,
  );

  const remotes = parseRemoteNames((await must(['remote'], 'List remotes')).stdout);

  const worktrees = parseWorktreeList(
    (await must(['worktree', 'list', '--porcelain'], 'List worktrees')).stdout,
  ).map((worktree) => ({
    path: worktree.path,
    ...(worktree.branch !== undefined ? { branch: worktree.branch } : {}),
    ...(worktree.headSha !== undefined ? { headSha: worktree.headSha } : {}),
  }));

  const [resolvedRoot, resolvedGitDir, resolvedCommonDir] = await Promise.all([
    canonical(repositoryRoot),
    canonical(gitDirectory),
    canonical(commonGitDirectory),
  ]);
  const isLinkedWorktree = resolvedGitDir !== resolvedCommonDir;

  const operationsInProgress = new Set<string>();
  for (const [marker, operation] of GIT_OPERATION_MARKERS) {
    const markerPath = await probe(['rev-parse', '--git-path', marker]);
    if (markerPath.exitCode === 0) {
      const resolved = resolve(directory, trimOutput(markerPath.stdout));
      if (existsSync(resolved)) {
        operationsInProgress.add(operation);
      }
    }
  }

  let upstream: { remote: string; branch: string; ref: string; sha?: string } | undefined;
  let aheadBy: number | undefined;
  let behindBy: number | undefined;

  if (branch !== undefined) {
    const remoteResult = await probe(['config', '--get', `branch.${branch}.remote`]);
    const mergeResult = await probe(['config', '--get', `branch.${branch}.merge`]);
    if (remoteResult.exitCode === 0 && mergeResult.exitCode === 0) {
      const remote = trimOutput(remoteResult.stdout);
      const upstreamBranch = trimOutput(mergeResult.stdout).replace(/^refs\/heads\//, '');

      const refResult = await probe(['rev-parse', '--symbolic-full-name', '@{upstream}']);
      const ref =
        refResult.exitCode === 0 && trimOutput(refResult.stdout).length > 0
          ? trimOutput(refResult.stdout)
          : remote === '.'
            ? `refs/heads/${upstreamBranch}`
            : `refs/remotes/${remote}/${upstreamBranch}`;

      const shaResult = await probe(['rev-parse', '--verify', '--quiet', '@{upstream}']);
      const sha = shaResult.exitCode === 0 ? trimOutput(shaResult.stdout) : undefined;

      upstream = {
        remote,
        branch: upstreamBranch,
        ref,
        ...(sha !== undefined && sha.length > 0 ? { sha } : {}),
      };

      if (headSha !== undefined && sha !== undefined) {
        const divergence = await probe([
          'rev-list',
          '--left-right',
          '--count',
          'HEAD...@{upstream}',
        ]);
        if (divergence.exitCode === 0) {
          const counts = parseAheadBehind(divergence.stdout);
          aheadBy = counts?.ahead;
          behindBy = counts?.behind;
        }
      }
    }
  }

  const staged = status.staged;
  const modified = status.modified;
  const untracked = status.untracked;
  const unmerged = status.unmerged;
  const dirty = staged.length + modified.length + untracked.length + unmerged.length > 0;

  return sourceObservationSchema.parse({
    provider: 'git',
    ...(branch !== undefined ? { branch } : {}),
    ...(headSha !== undefined ? { headSha } : {}),
    workingTree: dirty ? 'dirty' : 'clean',
    ...(aheadBy !== undefined ? { aheadBy } : {}),
    ...(behindBy !== undefined ? { behindBy } : {}),
    detachedHead,
    stagedCount: staged.length,
    modifiedCount: modified.length,
    untrackedCount: untracked.length,
    unmergedCount: unmerged.length,
    stagedFiles: staged.slice(0, MAX_REPORTED_PATHS),
    modifiedFiles: modified.slice(0, MAX_REPORTED_PATHS),
    untrackedFiles: untracked.slice(0, MAX_REPORTED_PATHS),
    unmergedFiles: unmerged.slice(0, MAX_REPORTED_PATHS),
    ...(upstream !== undefined ? { upstream } : {}),
    remoteNames: remotes,
    repositoryRoot: resolvedRoot,
    gitDirectory: resolvedGitDir,
    commonGitDirectory: resolvedCommonDir,
    isLinkedWorktree,
    worktrees,
    operationsInProgress: [...operationsInProgress].sort(),
  });
};

const diagnostic = (
  code: string,
  title: string,
  status: ProviderDiagnostic['status'],
  message: string,
): ProviderDiagnostic => ({ code, title, status, message });

const diagnoseRepository = async (
  runner: GitRunner,
  directory: string,
  signal?: AbortSignal,
): Promise<readonly ProviderDiagnostic[]> => {
  const diagnostics: ProviderDiagnostic[] = [];
  const run = (args: readonly string[]) =>
    runner.run(args, { cwd: directory, ...(signal ? { signal } : {}) });

  try {
    const version = await run(['version']);
    diagnostics.push(
      version.exitCode === 0
        ? diagnostic('GIT_EXECUTABLE', 'Git executable', 'ok', trimOutput(version.stdout))
        : diagnostic('GIT_EXECUTABLE', 'Git executable', 'error', 'git version failed.'),
    );
  } catch (error) {
    diagnostics.push(
      diagnostic(
        'GIT_EXECUTABLE',
        'Git executable',
        'error',
        error instanceof GitError ? error.message : 'Unable to run Git.',
      ),
    );
    return diagnostics;
  }

  let directoryForWorktree = directory;
  try {
    const inside = await run(['rev-parse', '--is-inside-work-tree']);
    if (inside.exitCode !== 0 || trimOutput(inside.stdout) !== 'true') {
      diagnostics.push(
        diagnostic(
          'GIT_REPOSITORY',
          'Repository detection',
          'error',
          `${directory} is not inside a Git working tree.`,
        ),
      );
      return diagnostics;
    }
    const root = await run(['rev-parse', '--show-toplevel']);
    directoryForWorktree = trimOutput(root.stdout);
    diagnostics.push(
      diagnostic(
        'GIT_REPOSITORY',
        'Repository detection',
        'ok',
        `Repository root: ${directoryForWorktree}`,
      ),
    );
  } catch (error) {
    diagnostics.push(
      diagnostic(
        'GIT_REPOSITORY',
        'Repository detection',
        'error',
        error instanceof GitError ? error.message : 'Repository detection failed.',
      ),
    );
    return diagnostics;
  }

  try {
    const branch = await run(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const head = await run(['rev-parse', '--verify', 'HEAD']);
    if (branch.exitCode === 0) {
      const shortSha = head.exitCode === 0 ? trimOutput(head.stdout).slice(0, 7) : 'no commits yet';
      diagnostics.push(
        diagnostic('GIT_HEAD', 'HEAD state', 'ok', `${trimOutput(branch.stdout)} @ ${shortSha}`),
      );
    } else {
      diagnostics.push(
        diagnostic(
          'GIT_HEAD',
          'HEAD state',
          'warning',
          head.exitCode === 0
            ? `Detached HEAD at ${trimOutput(head.stdout).slice(0, 7)}`
            : 'HEAD does not resolve to a commit or branch.',
        ),
      );
    }

    if (branch.exitCode === 0) {
      const upstream = await run([
        'rev-parse',
        '--abbrev-ref',
        '--symbolic-full-name',
        '@{upstream}',
      ]);
      diagnostics.push(
        upstream.exitCode === 0
          ? diagnostic(
              'GIT_UPSTREAM',
              'Upstream tracking',
              'ok',
              `Tracking ref: ${trimOutput(upstream.stdout)} (local ref, not remote-verified)`,
            )
          : diagnostic(
              'GIT_UPSTREAM',
              'Upstream tracking',
              'warning',
              'No upstream configured for the current branch.',
            ),
      );
    }
  } catch (error) {
    diagnostics.push(
      diagnostic(
        'GIT_HEAD',
        'HEAD state',
        'error',
        error instanceof GitError ? error.message : 'HEAD inspection failed.',
      ),
    );
  }

  return diagnostics;
};

/**
 * Local Git truth adapter. Runs a fixed set of read-only Git commands through an injectable
 * runner and returns a normalized SourceObservation. It never fetches, so `upstream.sha` is
 * the local remote-tracking ref, not authoritative remote state.
 */
export const createLocalGitProvider = (
  options: LocalGitProviderOptions = {},
): TruthProvider<LocalGitConfig, SourceObservation> => {
  const runner = options.runner ?? createNodeGitRunner();

  return {
    id: 'local-git',
    capabilities: ['source'],
    validateConfig: (config: unknown) => localGitConfigSchema.parse(config),
    observe: (context: ObservationContext<LocalGitConfig>) => {
      const directory = resolve(context.config.directory ?? process.cwd());
      return observeRepository(runner, directory, context.signal);
    },
    diagnose: (context: ObservationContext<LocalGitConfig>) => {
      const directory = resolve(context.config.directory ?? process.cwd());
      return diagnoseRepository(runner, directory, context.signal);
    },
  };
};

export const localGitProvider = createLocalGitProvider();
