import { execFile } from 'node:child_process';

import { GitError } from './errors.js';

/** Normalized process output. Raw child-process objects never leave the runner. */
export interface GitCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitRunOptions {
  /** Directory the Git command runs in; never interpolated into a shell string. */
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface GitRunner {
  readonly run: (args: readonly string[], options?: GitRunOptions) => Promise<GitCommandResult>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

const normalizeOutput = (value: string): string => value.replace(/\r\n/g, '\n');

/**
 * Environment overrides that change which repository Git sees are removed from the inherited
 * environment so observation is always of the directory the caller asked for.
 */
const BLOCKED_ENVIRONMENT = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_QUARANTINE_PATH',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
]);

const OBSERVATION_ENVIRONMENT = (() => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || BLOCKED_ENVIRONMENT.has(key) || /^GIT_CONFIG/.test(key)) {
      continue;
    }
    env[key] = value;
  }
  // Prevent read commands (e.g. `git status`) from taking optional index locks.
  env['GIT_OPTIONAL_LOCKS'] = '0';
  // Deterministic diagnostics independent of the caller's locale.
  env['LC_ALL'] = 'C';
  return env;
})();

type ArgumentPredicate = (args: readonly string[]) => boolean;

const allFlags = (allowed: readonly string[]): ArgumentPredicate => {
  const permitted = new Set(allowed);
  return (args) => args.slice(1).every((arg) => permitted.has(arg));
};

const isPlainWord = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value);

/**
 * `ls-tree` revisions are limited to `HEAD`, `@`, or a hex object id — the migration catalog
 * always reads the immutable committed tree, never refs or ranges derived from input.
 */
const isTreeRevision = (value: string): boolean => /^(HEAD|@|[0-9a-f]{4,64})$/.test(value);

/**
 * A repository-relative tree path: safe-character segments, optional trailing slash for
 * "list the directory's contents", and never a `.`/`..` segment or a doubled separator.
 */
const isTreePath = (value: string): boolean => {
  const trimmed = value.endsWith('/') ? value.slice(0, -1) : value;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(trimmed)) {
    return false;
  }
  return !trimmed
    .split('/')
    .some((segment) => segment === '' || segment === '..' || segment === '.');
};

/**
 * Read-only allowlist for the subcommands the adapter uses. Anything else — including
 * git-level flags such as `-c`, `--git-dir`, or mutating subcommands — is rejected before
 * a process is ever spawned.
 */
const READONLY_COMMANDS: Readonly<Record<string, ArgumentPredicate>> = {
  version: (args) => args.length === 1,
  'rev-parse': () => true,
  'rev-list': () => true,
  status: allFlags([
    '--porcelain',
    '-z',
    '--branch',
    '--untracked-files=normal',
    '--ignore-submodules',
    '--no-renames',
  ]),
  remote: (args) => args.length === 1,
  config: (args) => args.length === 3 && args[1] === '--get' && isPlainWord(args[2] ?? ''),
  'symbolic-ref': (args) => {
    const rest = args.slice(1);
    const target = rest.at(-1);
    return (
      rest.length >= 2 &&
      target !== undefined &&
      isPlainWord(target) &&
      rest.slice(0, -1).every((arg) => ['--quiet', '-q', '--short'].includes(arg))
    );
  },
  worktree: (args) =>
    args.length >= 2 &&
    args[1] === 'list' &&
    args.slice(2).every((arg) => arg === '--porcelain' || arg === '-z'),
  /**
   * `ls-tree <rev> <path>` — the single form the migration catalog uses. No recursive
   * descent, no `--name-only`/`--format` variants, no arbitrary revisions or paths.
   */
  'ls-tree': (args) =>
    args.length === 3 && isTreeRevision(args[1] ?? '') && isTreePath(args[2] ?? ''),
};

export const assertReadOnlyGitInvocation = (args: readonly string[]): void => {
  const subcommand = args[0];
  const predicate = subcommand === undefined ? undefined : READONLY_COMMANDS[subcommand];
  if (subcommand === undefined || predicate === undefined || !predicate(args)) {
    throw new GitError(
      'GIT_COMMAND_REJECTED',
      `Refusing to run git ${args.join(' ')}: only a fixed set of read-only commands is permitted.`,
    );
  }
};

export interface NodeGitRunnerOptions {
  /** Git executable name or absolute path. Never a shell command line. */
  readonly executable?: string;
  readonly defaultTimeoutMs?: number;
}

const isAbort = (error: unknown): boolean =>
  (error instanceof Error && error.name === 'AbortError') ||
  (typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ABORT_ERR');

/**
 * Runs the git binary directly via execFile: no shell is involved, arguments are passed as an
 * array, and only allowlisted read-only invocations execute.
 */
export const createNodeGitRunner = (options: NodeGitRunnerOptions = {}): GitRunner => {
  const executable = options.executable ?? 'git';
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    run: (args, runOptions = {}) =>
      new Promise<GitCommandResult>((resolve, reject) => {
        try {
          assertReadOnlyGitInvocation(args);
        } catch (error) {
          reject(error);
          return;
        }

        execFile(
          executable,
          [...args],
          {
            cwd: runOptions.cwd,
            env: OBSERVATION_ENVIRONMENT,
            timeout: runOptions.timeoutMs ?? defaultTimeoutMs,
            maxBuffer: MAX_BUFFER_BYTES,
            encoding: 'utf8',
            shell: false,
            windowsHide: true,
            ...(runOptions.signal ? { signal: runOptions.signal } : {}),
          },
          (error, stdout, stderr) => {
            if (error === null) {
              resolve({
                exitCode: 0,
                stdout: normalizeOutput(stdout),
                stderr: normalizeOutput(stderr),
              });
              return;
            }

            const code = (error as { code?: string | number }).code;
            if (isAbort(error)) {
              reject(new GitError('GIT_ABORTED', 'Git observation was aborted.'));
              return;
            }
            if (code === 'ENOENT') {
              reject(
                new GitError(
                  'GIT_NOT_AVAILABLE',
                  `Git executable "${executable}" was not found; install Git to use local truth checks.`,
                ),
              );
              return;
            }
            if (error.killed === true || code === 'ETIMEDOUT') {
              reject(new GitError('GIT_TIMEOUT', `git ${args[0] ?? ''} timed out.`));
              return;
            }
            if (typeof code !== 'number') {
              reject(
                new GitError(
                  'GIT_SPAWN_FAILED',
                  `Unable to run git: ${normalizeOutput(String(error.message))}`,
                ),
              );
              return;
            }

            resolve({
              exitCode: code,
              stdout: normalizeOutput(stdout ?? ''),
              stderr: normalizeOutput(stderr ?? ''),
            });
          },
        );
      }),
  };
};
