import { evaluateTruth, type TopologyEdge, type TruthContext } from '@deploytruth/core';
import { describe, expect, it } from 'vitest';

import { loadScenario } from './scenario-loader.js';

const codes = (scenario: string): readonly string[] =>
  evaluateTruth(loadScenario(scenario)).findings.map((finding) => finding.code);

const edge = (
  report: ReturnType<typeof evaluateTruth>,
  source: string,
  target: string,
): TopologyEdge => {
  const match = report.topology.edges.find(
    (entry) => entry.source === `production:${source}` && entry.target === `production:${target}`,
  );
  expect(match).toBeDefined();
  return match!;
};

const withEvidence = (
  sourceSha: string,
  deploymentSha: string,
  runtimeSha: string,
  runtimeDatabaseProject = 'proddbx',
): TruthContext => {
  const context = loadScenario('healthy-production');
  const observed = context.observations.environments.production!;
  return {
    ...context,
    observations: {
      ...context.observations,
      environments: {
        ...context.observations.environments,
        production: {
          ...observed,
          source: {
            ...observed.source!,
            headSha: sourceSha,
            upstream: { ...observed.source!.upstream!, sha: sourceSha },
          },
          remoteSource: { ...observed.remoteSource!, remoteHeadSha: sourceSha },
          deployment: { ...observed.deployment!, commitSha: deploymentSha },
          runtime: {
            ...observed.runtime!,
            commitSha: runtimeSha,
            databaseConnection: {
              ...observed.runtime!.databaseConnection!,
              targetProjectRef: runtimeDatabaseProject,
            },
          },
          repositoryMigrations: {
            ...observed.repositoryMigrations!,
            sourceSha,
          },
        },
      },
    },
  };
};

describe('deterministic truth engine fixtures', () => {
  it('returns PASS for a healthy production topology', () => {
    const report = evaluateTruth(loadScenario('healthy-production'));

    expect(report.verdict).toBe('PASS');
    expect(report.findings).toEqual([]);
    expect(report.topology.nodes.map((node) => node.type)).toEqual([
      'database',
      'deployment',
      'runtime',
      'source',
    ]);
  });

  it('returns WARN for a dirty local worktree', () => {
    const report = evaluateTruth(loadScenario('dirty-worktree'));

    expect(report.verdict).toBe('WARN');
    expect(codes('dirty-worktree')).toContain('DIRTY_WORKTREE');
  });

  it('returns FAIL when deployment SHA differs from source', () => {
    const report = evaluateTruth(loadScenario('deployment-sha-mismatch'));

    expect(report.verdict).toBe('FAIL');
    expect(codes('deployment-sha-mismatch')).toContain('DEPLOYMENT_SHA_MISMATCH');
  });

  it('returns FAIL when preview is wired to production database', () => {
    const report = evaluateTruth(loadScenario('preview-production-database'));

    expect(report.verdict).toBe('FAIL');
    expect(codes('preview-production-database')).toEqual(
      expect.arrayContaining(['PREVIEW_USES_PRODUCTION_DATABASE', 'WRONG_DATABASE_PROJECT']),
    );
  });

  it('returns FAIL when production migrations are behind repository migrations', () => {
    const report = evaluateTruth(loadScenario('migrations-behind'));

    expect(report.verdict).toBe('FAIL');
    expect(codes('migrations-behind')).toContain('DATABASE_MIGRATIONS_BEHIND');
  });

  it('returns FAIL when runtime identity SHA differs from deployment SHA', () => {
    const report = evaluateTruth(loadScenario('runtime-sha-mismatch'));

    expect(report.verdict).toBe('FAIL');
    expect(codes('runtime-sha-mismatch')).toContain('RUNTIME_SHA_MISMATCH');
  });

  describe('topology finding attribution', () => {
    it('isolates a source/deployment mismatch from the healthy deployment/runtime edge', () => {
      const report = evaluateTruth(withEvidence('abc123', 'def456', 'def456'));
      expect(edge(report, 'source', 'deployment')).toMatchObject({
        health: 'failed',
        findings: ['DEPLOYMENT_SHA_MISMATCH'],
      });
      expect(edge(report, 'deployment', 'runtime')).toMatchObject({
        health: 'healthy',
        observed: true,
      });
      expect(edge(report, 'deployment', 'runtime').findings).not.toContain(
        'DEPLOYMENT_SHA_MISMATCH',
      );
      expect(edge(report, 'runtime', 'database')).toMatchObject({
        health: 'healthy',
        observed: true,
      });
    });

    it('isolates a runtime mismatch from the healthy source/deployment edge', () => {
      const report = evaluateTruth(withEvidence('abc123', 'abc123', 'def456'));
      expect(edge(report, 'source', 'deployment')).toMatchObject({
        health: 'healthy',
        observed: true,
      });
      expect(edge(report, 'source', 'deployment').findings).not.toContain('RUNTIME_SHA_MISMATCH');
      expect(edge(report, 'deployment', 'runtime')).toMatchObject({
        health: 'failed',
        findings: ['RUNTIME_SHA_MISMATCH'],
      });
    });

    it('keeps simultaneous source and runtime mismatches on their own edges', () => {
      const report = evaluateTruth(withEvidence('aaa111', 'bbb222', 'ccc333'));
      expect(edge(report, 'source', 'deployment').findings).toEqual(['DEPLOYMENT_SHA_MISMATCH']);
      expect(edge(report, 'deployment', 'runtime').findings).toEqual(['RUNTIME_SHA_MISMATCH']);
    });

    it('keeps both SHA relationships healthy when all evidence agrees', () => {
      const report = evaluateTruth(withEvidence('abc123', 'abc123', 'abc123'));
      expect(edge(report, 'source', 'deployment')).toMatchObject({
        health: 'healthy',
        observed: true,
      });
      expect(edge(report, 'deployment', 'runtime')).toMatchObject({
        health: 'healthy',
        observed: true,
      });
    });

    it('isolates a runtime/database mismatch from both upstream edges', () => {
      const report = evaluateTruth(withEvidence('abc123', 'abc123', 'abc123', 'other-project'));
      expect(edge(report, 'source', 'deployment')).toMatchObject({
        health: 'healthy',
        findings: [],
      });
      expect(edge(report, 'deployment', 'runtime')).toMatchObject({
        health: 'healthy',
        findings: [],
      });
      expect(edge(report, 'runtime', 'database')).toMatchObject({
        health: 'failed',
        findings: ['RUNTIME_DATABASE_PROJECT_MISMATCH'],
      });
    });
  });

  it('treats warnings as failures only when strict mode is selected', () => {
    const context = loadScenario('dirty-worktree');
    const report = evaluateTruth({ ...context, strict: true });

    expect(report.verdict).toBe('FAIL');
  });
});
