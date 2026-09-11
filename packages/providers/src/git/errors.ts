export type GitErrorCode =
  | 'GIT_NOT_AVAILABLE'
  | 'GIT_TIMEOUT'
  | 'GIT_ABORTED'
  | 'GIT_COMMAND_REJECTED'
  | 'GIT_SPAWN_FAILED'
  | 'NOT_A_REPOSITORY'
  | 'NOT_A_WORKTREE'
  | 'OBSERVATION_FAILED';

/**
 * Typed failure for local Git observation. `stderr` is already line-ending normalized and
 * contains no data derived from manifest values; callers must still redact before printing.
 */
export class GitError extends Error {
  public readonly code: GitErrorCode;
  public readonly exitCode?: number;
  public readonly stderr?: string;

  public constructor(
    code: GitErrorCode,
    message: string,
    options: { readonly exitCode?: number; readonly stderr?: string } = {},
  ) {
    super(message);
    this.name = 'GitError';
    this.code = code;
    if (options.exitCode !== undefined) {
      this.exitCode = options.exitCode;
    }
    if (options.stderr !== undefined) {
      this.stderr = options.stderr;
    }
  }
}
