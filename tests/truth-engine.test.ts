import { evaluateTruth } from '@deploytruth/core';
import { describe, expect, it } from 'vitest';

import { loadScenario } from './scenario-loader.js';

const codes = (scenario: string): readonly string[] =>
  evaluateTruth(loadScenario(scenario)).findings.map((finding) => finding.code);

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

  it('treats warnings as failures only when strict mode is selected', () => {
    const context = loadScenario('dirty-worktree');
    const report = evaluateTruth({ ...context, strict: true });

    expect(report.verdict).toBe('FAIL');
  });
});
