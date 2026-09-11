import {
  evaluateTruth,
  sourceObservationSchema,
  type SourceObservation,
  type TruthContext,
} from '@deploytruth/core';
import { describe, expect, it } from 'vitest';

const declaration = {
  version: 1,
  project: 'meridia',
  environments: {
    production: {
      id: 'production',
      kind: 'production',
      source: { provider: 'github', repository: 'acme/meridia', branch: 'main' },
      requiredEnvironmentVariables: [],
      checks: { local_git: true },
    },
  },
} as const;

const context = (source: SourceObservation): TruthContext => ({
  declaration: {
    ...declaration,
    environments: { ...declaration.environments },
  },
  observations: {
    project: 'meridia',
    environments: {
      production: { environment: 'production', source },
    },
  },
  generatedAt: '2026-09-11T00:00:00Z',
});

const gitSource = (overrides: Partial<SourceObservation>): SourceObservation =>
  sourceObservationSchema.parse({
    provider: 'git',
    branch: 'main',
    headSha: 'a'.repeat(40),
    workingTree: 'clean',
    ...overrides,
  });

const codes = (source: SourceObservation): readonly string[] =>
  evaluateTruth(context(source)).findings.map((finding) => finding.code);

describe('local Git truth rules', () => {
  it('emits no findings for a clean branch tracking upstream evenly', () => {
    const source = gitSource({
      upstream: {
        remote: 'origin',
        branch: 'main',
        ref: 'refs/remotes/origin/main',
        sha: 'a'.repeat(40),
      },
      aheadBy: 0,
      behindBy: 0,
    });

    expect(codes(source)).toEqual([]);
    expect(evaluateTruth(context(source)).verdict).toBe('PASS');
  });

  it('warns when the worktree is dirty with file counts as evidence', () => {
    const source = gitSource({
      workingTree: 'dirty',
      stagedCount: 1,
      untrackedCount: 2,
      stagedFiles: ['staged.ts'],
      untrackedFiles: ['a.ts', 'b.ts'],
      upstream: { remote: 'origin', branch: 'main', ref: 'refs/remotes/origin/main' },
      aheadBy: 0,
      behindBy: 0,
    });

    expect(codes(source)).toContain('DIRTY_WORKTREE');
  });

  it('warns when behind the local tracking ref', () => {
    const report = evaluateTruth(
      context(
        gitSource({
          upstream: { remote: 'origin', branch: 'main', ref: 'refs/remotes/origin/main' },
          aheadBy: 0,
          behindBy: 2,
        }),
      ),
    );

    const finding = report.findings.find((entry) => entry.code === 'LOCAL_BRANCH_BEHIND_UPSTREAM');
    expect(finding?.severity).toBe('WARNING');
    expect(finding?.status).toBe('WARN');
    expect(report.findings.map((entry) => entry.code)).toContain('LOCAL_BRANCH_BEHIND_UPSTREAM');
  });

  it('reports divergence at HIGH severity without also firing ahead/behind', () => {
    const source = gitSource({
      upstream: { remote: 'origin', branch: 'main', ref: 'refs/remotes/origin/main' },
      aheadBy: 1,
      behindBy: 3,
    });

    const result = codes(source);
    expect(result).toContain('LOCAL_BRANCH_DIVERGED');
    expect(result).not.toContain('LOCAL_BRANCH_AHEAD_OF_UPSTREAM');
    expect(result).not.toContain('LOCAL_BRANCH_BEHIND_UPSTREAM');
  });

  it('reports unpushed commits as informational', () => {
    const report = evaluateTruth(
      context(
        gitSource({
          upstream: { remote: 'origin', branch: 'main', ref: 'refs/remotes/origin/main' },
          aheadBy: 2,
          behindBy: 0,
        }),
      ),
    );

    const finding = report.findings.find(
      (entry) => entry.code === 'LOCAL_BRANCH_AHEAD_OF_UPSTREAM',
    );
    expect(finding?.severity).toBe('INFO');
    expect(report.verdict).toBe('WARN');
  });

  it('warns on detached HEAD and does not demand an upstream', () => {
    const source = gitSource({ branch: undefined, detachedHead: true });

    const result = codes(source);
    expect(result).toContain('DETACHED_HEAD');
    expect(result).not.toContain('NO_UPSTREAM_CONFIGURED');
    expect(result).not.toContain('LOCAL_BRANCH_AHEAD_OF_UPSTREAM');
  });

  it('warns when a committed branch has no upstream', () => {
    const result = codes(gitSource({}));
    expect(result).toContain('NO_UPSTREAM_CONFIGURED');
  });

  it('warns when a repository operation is in progress', () => {
    const source = gitSource({
      operationsInProgress: ['merge'],
      upstream: { remote: 'origin', branch: 'main', ref: 'refs/remotes/origin/main' },
      aheadBy: 0,
      behindBy: 0,
    });

    expect(codes(source)).toContain('REPOSITORY_OPERATION_IN_PROGRESS');
  });

  it('does not run local-only rules against non-git source observations', () => {
    const githubSource = sourceObservationSchema.parse({
      provider: 'github',
      repository: 'acme/meridia',
      branch: 'main',
      remoteHeadSha: 'b'.repeat(40),
    });

    const result = codes(githubSource);
    expect(result).not.toContain('NO_UPSTREAM_CONFIGURED');
    expect(result).not.toContain('DETACHED_HEAD');
  });

  it('reports REQUIRED_OBSERVATION_UNAVAILABLE instead of passing when source is absent', () => {
    const contextWithoutObservation: TruthContext = {
      declaration: context(gitSource({})).declaration,
      observations: { project: 'meridia', environments: {} },
      generatedAt: '2026-09-11T00:00:00Z',
    };

    const report = evaluateTruth(contextWithoutObservation);
    expect(report.verdict).toBe('WARN');
    expect(report.findings.map((finding) => finding.code)).toContain(
      'REQUIRED_OBSERVATION_UNAVAILABLE',
    );
  });
});
