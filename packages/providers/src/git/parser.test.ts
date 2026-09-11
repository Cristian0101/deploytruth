import { describe, expect, it } from 'vitest';

import {
  parseAheadBehind,
  parseRemoteNames,
  parseStatusPorcelain,
  parseWorktreeList,
} from './parser.js';

describe('parseStatusPorcelain', () => {
  it('returns empty buckets for a clean tree', () => {
    expect(parseStatusPorcelain('')).toEqual({
      staged: [],
      modified: [],
      untracked: [],
      unmerged: [],
    });
  });

  it('classifies staged, modified, untracked, and unmerged entries', () => {
    // v1 -z: "XY <path>\0"; unmerged shows as UU/AA/... pairs.
    const output =
      [
        'M  staged.ts', // staged modification
        ' M dirty.ts', // unstaged modification
        'MM both.ts', // staged + unstaged
        '?? new-file.ts',
        'UU conflicted.ts',
        'A  added.ts',
        'D  deleted.ts',
        ' D lost.ts',
      ].join('\0') + '\0';

    const parsed = parseStatusPorcelain(output);
    expect(parsed.staged).toEqual(['added.ts', 'both.ts', 'deleted.ts', 'staged.ts']);
    expect(parsed.modified).toEqual(['both.ts', 'dirty.ts', 'lost.ts']);
    expect(parsed.untracked).toEqual(['new-file.ts']);
    expect(parsed.unmerged).toEqual(['conflicted.ts']);
  });

  it('consumes the source path of rename entries', () => {
    const output = 'R  new-name.ts\0old-name.ts\0 M other.ts\0';
    const parsed = parseStatusPorcelain(output);

    expect(parsed.staged).toEqual(['new-name.ts']);
    expect(parsed.modified).toEqual(['other.ts']);
  });

  it('keeps paths repository-relative and ignores ignored entries', () => {
    const parsed = parseStatusPorcelain('!! ignored.bin\0?? dir/nested.txt\0');
    expect(parsed.untracked).toEqual(['dir/nested.txt']);
  });
});

describe('parseWorktreeList', () => {
  it('parses main and linked worktrees', () => {
    const output = [
      'worktree /repo/main\nHEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nbranch refs/heads/main',
      'worktree /repo/linked\nHEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nbranch refs/heads/feature',
      'worktree /repo/detached\nHEAD cccccccccccccccccccccccccccccccccccccccc\ndetached',
      '',
    ].join('\n\n');

    const parsed = parseWorktreeList(output);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toMatchObject({ path: '/repo/main', branch: 'main', bare: false });
    expect(parsed[1]).toMatchObject({ path: '/repo/linked', branch: 'feature' });
    expect(parsed[2]).toMatchObject({ path: '/repo/detached', detached: true });
    expect(parsed[2]?.branch).toBeUndefined();
  });

  it('marks bare entries', () => {
    const parsed = parseWorktreeList('worktree /repo/bare\nbare\n');
    expect(parsed[0]).toMatchObject({ path: '/repo/bare', bare: true });
  });
});

describe('parseAheadBehind', () => {
  it('parses tab-separated counts', () => {
    expect(parseAheadBehind('3\t2\n')).toEqual({ ahead: 3, behind: 2 });
    expect(parseAheadBehind('0 0')).toEqual({ ahead: 0, behind: 0 });
  });

  it('returns undefined for unparseable output', () => {
    expect(parseAheadBehind('')).toBeUndefined();
    expect(parseAheadBehind('fatal: ambiguous')).toBeUndefined();
    expect(parseAheadBehind('1')).toBeUndefined();
  });
});

describe('parseRemoteNames', () => {
  it('lists names only, sorted, never URLs', () => {
    expect(parseRemoteNames('upstream\norigin\n\n')).toEqual(['origin', 'upstream']);
    expect(parseRemoteNames('')).toEqual([]);
  });
});
