import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const createdDirectories: string[] = [];

export const git = (args: readonly string[], cwd: string): string =>
  execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim();

/** Creates an isolated temporary directory; registers it for cleanup. */
export const tempDir = (prefix: string): string => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  createdDirectories.push(directory);
  return directory;
};

export const cleanupTempDirs = (): void => {
  while (createdDirectories.length > 0) {
    const directory = createdDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
};

/** Initializes a repo on branch `main` with one empty commit and a local identity. */
export const initRepo = (directory: string): string => {
  git(['init', '-b', 'main'], directory);
  git(['config', 'user.email', 'deploytruth-test@example.invalid'], directory);
  git(['config', 'user.name', 'DeployTruth Test'], directory);
  git(['commit', '--allow-empty', '-m', 'initial'], directory);
  return directory;
};

export const commit = (directory: string, message: string): string => {
  git(['commit', '--allow-empty', '-m', message], directory);
  return git(['rev-parse', 'HEAD'], directory);
};

export const write = (directory: string, relativePath: string, contents: string): void => {
  writeFileSync(join(directory, relativePath), contents);
};

/**
 * Configures `origin/main` as upstream for `main` and points the local remote-tracking ref at
 * `sha`, without any fetch — a pure local arrangement of refs and config.
 */
export const configureUpstream = (directory: string, trackingSha: string): void => {
  git(['remote', 'add', 'origin', 'https://example.invalid/repo.git'], directory);
  git(['update-ref', 'refs/remotes/origin/main', trackingSha], directory);
  git(['config', 'branch.main.remote', 'origin'], directory);
  git(['config', 'branch.main.merge', 'refs/heads/main'], directory);
};

/** Canonical path for comparisons; macOS temp dirs are symlinked. */
export const canonical = (path: string): string => realpathSync(path);
