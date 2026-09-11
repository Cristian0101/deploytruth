export interface ParsedWorktree {
  readonly path: string;
  readonly headSha?: string;
  readonly branch?: string;
  readonly bare: boolean;
  readonly detached: boolean;
}

export interface ParsedStatus {
  readonly staged: readonly string[];
  readonly modified: readonly string[];
  readonly untracked: readonly string[];
  readonly unmerged: readonly string[];
}

const UNMERGED_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const STAGED_CODES = new Set(['M', 'A', 'D', 'R', 'C', 'T']);
const MODIFIED_CODES = new Set(['M', 'D', 'T']);

const sorted = (values: readonly string[]): readonly string[] =>
  [...values].sort((left, right) => left.localeCompare(right));

/**
 * Parses `git status --porcelain -z`. Entries are NUL-separated; rename/copy entries place the
 * destination path in the entry and the source path in the following NUL field.
 */
export const parseStatusPorcelain = (stdout: string): ParsedStatus => {
  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];
  const unmerged: string[] = [];

  const records = stdout.split('\0');
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length < 4) {
      continue;
    }

    const x = record[0] ?? ' ';
    const y = record[1] ?? ' ';
    const path = record.slice(3);
    const code = `${x}${y}`;

    if (code === '??') {
      untracked.push(path);
      continue;
    }
    if (code === '!!' || path.length === 0) {
      continue;
    }
    if (UNMERGED_CODES.has(code)) {
      unmerged.push(path);
      continue;
    }
    if (x === 'R' || x === 'C') {
      // The following NUL record holds the pre-rename source path.
      index += 1;
    }
    if (STAGED_CODES.has(x)) {
      staged.push(path);
    }
    if (MODIFIED_CODES.has(y)) {
      modified.push(path);
    }
  }

  return {
    staged: sorted(staged),
    modified: sorted(modified),
    untracked: sorted(untracked),
    unmerged: sorted(unmerged),
  };
};

/** Parses `git worktree list --porcelain` into per-worktree records. */
export const parseWorktreeList = (stdout: string): readonly ParsedWorktree[] =>
  stdout
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => {
      const lines = block.split('\n');
      const first = lines[0] ?? '';
      const path = first.startsWith('worktree ') ? first.slice('worktree '.length) : '';
      let headSha: string | undefined;
      let branch: string | undefined;
      let bare = false;
      let detached = false;

      for (const line of lines.slice(1)) {
        if (line.startsWith('HEAD ')) {
          headSha = line.slice('HEAD '.length).trim();
        } else if (line.startsWith('branch ')) {
          branch = line
            .slice('branch '.length)
            .trim()
            .replace(/^refs\/heads\//, '');
        } else if (line === 'bare') {
          bare = true;
        } else if (line === 'detached') {
          detached = true;
        }
      }

      return {
        path,
        ...(headSha !== undefined && headSha.length > 0 ? { headSha } : {}),
        ...(branch !== undefined && branch.length > 0 ? { branch } : {}),
        bare,
        detached,
      };
    });

/** Parses `git rev-list --left-right --count A...B` output ("<ahead>\t<behind>"). */
export const parseAheadBehind = (
  stdout: string,
): { readonly ahead: number; readonly behind: number } | undefined => {
  const parts = stdout.trim().split(/\s+/).map(Number);
  const ahead = parts[0];
  const behind = parts[1];
  return Number.isInteger(ahead) &&
    Number.isInteger(behind) &&
    (ahead ?? -1) >= 0 &&
    (behind ?? -1) >= 0
    ? { ahead: ahead as number, behind: behind as number }
    : undefined;
};

/** Parses bare `git remote` output into remote names (never URLs). */
export const parseRemoteNames = (stdout: string): readonly string[] =>
  sorted(
    stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
