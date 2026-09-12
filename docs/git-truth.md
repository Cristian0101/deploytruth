# Local Git truth (M1)

DeployTruth's first evidence source is the local Git repository. This document defines what the
`local-git` adapter observes, how to read it, and — most importantly — what it does **not** prove.

## What is observed

The adapter runs a fixed set of read-only commands through an injectable `GitRunner` and produces a
normalized `SourceObservation` (`provider: "git"`):

| Question                                       | How it is answered                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| Inside a repository?                           | `git rev-parse --is-inside-work-tree`                                         |
| Repository root                                | `git rev-parse --show-toplevel`                                               |
| Current branch / detached HEAD                 | `git symbolic-ref --quiet --short HEAD` (+ `rev-parse --verify HEAD`)         |
| HEAD SHA                                       | `git rev-parse --verify HEAD`                                                 |
| Dirty state and per-bucket file lists          | `git status --porcelain -z --untracked-files=normal`                          |
| Configured remotes (names only, never URLs)    | `git remote`                                                                  |
| Configured upstream                            | `git config --get branch.<name>.remote` / `branch.<name>.merge`               |
| Local tracking ref and its SHA                 | `git rev-parse --symbolic-full-name @{upstream}` / `--verify @{upstream}`     |
| Ahead / behind counts                          | `git rev-list --left-right --count HEAD...@{upstream}`                        |
| Worktrees, common Git directory, linked status | `git worktree list --porcelain`, `--absolute-git-dir`, `--git-common-dir`     |
| Operation in progress                          | `git rev-parse --git-path <marker>` for MERGE_HEAD, rebase-merge/-apply, etc. |

`aheadBy`/`behindBy` are commit counts from symmetric-difference rev-list between `HEAD` and the
local tracking ref: `aheadBy` counts commits only in `HEAD`, `behindBy` counts commits only in the
tracking ref. Both > 0 means diverged.

## Tracking refs are not remote truth

`upstream.sha` is the SHA of the **local** `refs/remotes/<remote>/<branch>` tracking ref. It reflects
the last time the local repository fetched — it is _not_ evidence that GitHub currently has that
commit. DeployTruth never runs `git fetch` in M1, so the tracking ref may be stale.

Authoritative remote state is a separate field: `remoteHeadSha` is reserved for remote-aware
adapters (M2, GitHub). The local adapter deliberately leaves it unset, and rules that compare
deployed SHAs fall back to the local `headSha` in the meantime. Reports and CLI output always label
tracking refs as local (e.g. `local ref; remote unverified`).

## Read-only guarantee

- Commands execute via `execFile` with `shell: false`; arguments are an array, never a string.
- A fixed allowlist (`assertReadOnlyGitInvocation`) permits only `version`, `rev-parse`,
  `rev-list`, `status` (safe flags only), bare `remote`, `config --get`, read-form `symbolic-ref`,
  `worktree list`, and `ls-tree <rev> <path>` (added in M4 for the immutable migration catalog;
  revisions limited to `HEAD`/`@`/hex object ids, paths to safe repository-relative segments).
  Mutating subcommands, git-level flags (`-c`, `--git-dir`, `-C`), and
  config writes are rejected before any process spawns.
- `GIT_OPTIONAL_LOCKS=0` prevents `status` from refreshing the index on disk.
- `GIT_DIR`-style environment overrides are stripped so observation always targets the requested
  directory; `LC_ALL=C` keeps diagnostics deterministic.
- No file contents are read. Changed-file lists are repository-relative paths only, capped at 100
  entries per bucket (counts remain exact).

## Rules

| Code                               | Severity | Meaning                                            |
| ---------------------------------- | -------- | -------------------------------------------------- |
| `DIRTY_WORKTREE`                   | WARNING  | Uncommitted changes make local evidence unreliable |
| `REPOSITORY_OPERATION_IN_PROGRESS` | WARNING  | Merge/rebase/cherry-pick/revert/bisect unfinished  |
| `DETACHED_HEAD`                    | WARNING  | HEAD not on a branch                               |
| `NO_UPSTREAM_CONFIGURED`           | WARNING  | Branch has no upstream; drift is unverifiable      |
| `LOCAL_BRANCH_AHEAD_OF_UPSTREAM`   | INFO     | Unpushed commits exist locally                     |
| `LOCAL_BRANCH_BEHIND_UPSTREAM`     | WARNING  | Tracking ref has commits the branch lacks          |
| `LOCAL_BRANCH_DIVERGED`            | HIGH     | Both sides have unique commits                     |

Divergence suppresses the separate ahead/behind findings. A detached HEAD suppresses the
upstream-drift rules (there is no branch to drift). All are `WARN` status — interesting or unsafe
local states never produce a hard `FAIL` on their own.

A directory outside any Git working tree (or a bare repository, or a `.git` internals directory)
produces a typed `GitError` (`NOT_A_REPOSITORY` / `NOT_A_WORKTREE`). `check` reports it as a
diagnostic plus `REQUIRED_OBSERVATION_UNAVAILABLE` — never as a verdict about deployment truth.

## Known limitations

- `upstream.sha` can be arbitrarily stale; only a fetch or remote API proves remote state.
- A configured upstream whose tracking ref does not exist locally reports `upstream` without `sha`
  and without ahead/behind counts.
- Non-default fetch refspecs may make the synthesized ref name imprecise when
  `--symbolic-full-name @{upstream}` cannot resolve.
- Bare repositories are rejected as `NOT_A_WORKTREE`; DeployTruth observes working trees only.

## Example

```text
$ deploytruth check --environment production

SOURCE
  Git repository       /private/repo
  Branch               main
  HEAD                 c6797ac
  Working tree         DIRTY (0 staged, 0 modified, 1 untracked)
  Tracking ref         origin/main -> c6797ac (local ref; remote unverified)
  Ahead / behind       0 / 0

DEPLOYMENT
  Vercel
    Project            example
    Target             production
    Deployment         dpl_abc123
    State              READY
    Source SHA         c6797ac

FINDINGS
  [WARN/WARNING] DIRTY_WORKTREE — Local worktree has uncommitted changes
  [WARN/WARNING] REQUIRED_OBSERVATION_UNAVAILABLE — A required observation was unavailable

VERDICT
  WARN
```
