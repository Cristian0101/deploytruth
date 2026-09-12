import { describe, expect, it } from 'vitest';

import { compareTruthReports, findingIdentity } from '@deploytruth/core';
import { serializeTruthReport } from '@deploytruth/reporter';

import {
  historySequences,
  reportFromScenario,
  withDatabaseProject,
  withShas,
  fixedRunId,
} from './history-sequences.js';

const secretFree = (value: unknown): void => {
  expect(JSON.stringify(value)).not.toMatch(/ghp_|Bearer\s|postgres(?:ql)?:\/\/|service_role/i);
};

describe('semantic run comparison', () => {
  it('PASS → PASS surfaces identity SHA changes and ignores timestamp churn', () => {
    const [from, to] = historySequences.healthyUpdate;
    const comparison = compareTruthReports(from!, to!);
    expect(comparison.verdictChange).toEqual({ from: 'PASS', to: 'PASS', kind: 'unchanged' });
    expect(comparison.summary.newFindings).toBe(0);
    expect(comparison.observationChanges.map((change) => change.kind)).toEqual([
      'source_sha',
      'deployment_sha',
      'runtime_sha',
    ]);
    expect(
      comparison.observationChanges.find((change) => change.kind === 'source_sha'),
    ).toMatchObject({
      from: 'abc123',
      to: 'def456',
    });
    expect(comparison.checkChanges).toEqual([]);
    expect(comparison.topologyChanges.nodes).toEqual([]);
    expect(
      comparison.observationChanges.some((change) =>
        change.label.toLowerCase().includes('timestamp'),
      ),
    ).toBe(false);
    secretFree(comparison);
  });

  it('detects PASS → FAIL with a NEW finding and FAIL → PASS recovery', () => {
    const regression = compareTruthReports(
      historySequences.regression[0]!,
      historySequences.regression[1]!,
    );
    expect(regression.verdictChange).toEqual({ from: 'PASS', to: 'FAIL', kind: 'regression' });
    expect(
      regression.findingChanges.some(
        (change) => change.lifecycle === 'NEW' && change.code === 'DEPLOYMENT_SHA_MISMATCH',
      ),
    ).toBe(true);
    expect(regression.checkChanges).toContainEqual({
      check: 'deployment_sha',
      from: 'VERIFIED',
      to: 'FAILED',
    });
    expect(regression.topologyChanges.edges.some((change) => change.toHealth === 'failed')).toBe(
      true,
    );

    const recovery = compareTruthReports(
      historySequences.recovery[0]!,
      historySequences.recovery[1]!,
    );
    expect(recovery.verdictChange).toEqual({ from: 'FAIL', to: 'PASS', kind: 'recovered' });
    expect(
      recovery.findingChanges.some(
        (change) => change.lifecycle === 'RESOLVED' && change.code === 'DEPLOYMENT_SHA_MISMATCH',
      ),
    ).toBe(true);
  });

  it('classifies PASS → WARN and WARN → PASS', () => {
    const warning = compareTruthReports(
      historySequences.healthyUpdate[0]!,
      historySequences.persistentWarning[0]!,
    );
    expect(warning.verdictChange.kind).toBe('regression');
    expect(warning.verdictChange.to).toBe('WARN');
    const recovered = compareTruthReports(
      historySequences.persistentWarning[0]!,
      historySequences.healthyUpdate[0]!,
    );
    expect(recovered.verdictChange).toMatchObject({ from: 'WARN', to: 'PASS', kind: 'recovered' });
  });

  it('classifies FAIL → WARN as recovery and WARN → FAIL as regression', () => {
    const failToWarn = compareTruthReports(
      historySequences.regression[1]!,
      historySequences.persistentWarning[0]!,
    );
    expect(failToWarn.verdictChange.kind).toBe('recovered');
    const warnToFail = compareTruthReports(
      historySequences.warningToFail[0]!,
      historySequences.warningToFail[1]!,
    );
    expect(warnToFail.verdictChange).toEqual({ from: 'WARN', to: 'FAIL', kind: 'regression' });
    expect(warnToFail.findingChanges.some((change) => change.lifecycle === 'NEW')).toBe(true);
    expect(warnToFail.findingChanges.some((change) => change.lifecycle === 'PERSISTING')).toBe(
      true,
    );
  });

  it('keeps a persistent finding PERSISTING when identity is unchanged', () => {
    const comparison = compareTruthReports(
      historySequences.persistentWarning[0]!,
      historySequences.persistentWarning[1]!,
    );
    expect(comparison.findingChanges.every((change) => change.lifecycle === 'PERSISTING')).toBe(
      true,
    );
    expect(comparison.summary.persistingFindings).toBeGreaterThan(0);
  });

  it('marks CHANGED when expected or observed evidence changes for the same finding identity', () => {
    const base = reportFromScenario('deployment-sha-mismatch', {
      runId: fixedRunId(Date.parse('2026-09-12T17:00:00Z'), 40),
      generatedAt: '2026-09-12T17:00:00.000Z',
    });
    const shifted = reportFromScenario('deployment-sha-mismatch', {
      runId: fixedRunId(Date.parse('2026-09-12T18:00:00Z'), 41),
      generatedAt: '2026-09-12T18:00:00.000Z',
      transform: (context) => withShas(context, 'ccc111', 'def456'),
    });
    const comparison = compareTruthReports(base, shifted);
    const changed = comparison.findingChanges.find(
      (change) => change.code === 'DEPLOYMENT_SHA_MISMATCH',
    );
    expect(changed?.lifecycle).toBe('CHANGED');
    expect(findingIdentity(base.findings[0]!)).toBe(findingIdentity(shifted.findings[0]!));
  });

  it('surfaces database project and migration count changes', () => {
    const from = reportFromScenario('healthy-production', {
      runId: fixedRunId(Date.parse('2026-09-12T17:00:00Z'), 42),
      generatedAt: '2026-09-12T17:00:00.000Z',
    });
    const to = reportFromScenario('healthy-production', {
      runId: fixedRunId(Date.parse('2026-09-12T18:00:00Z'), 43),
      generatedAt: '2026-09-12T18:00:00.000Z',
      transform: (context) => withDatabaseProject(context, 'otherref99'),
    });
    const identity = compareTruthReports(from, to);
    expect(identity.observationChanges.some((change) => change.kind === 'database_project')).toBe(
      true,
    );

    const migrations = compareTruthReports(
      historySequences.migrationDivergence[0]!,
      historySequences.migrationDivergence[1]!,
    );
    expect(migrations.observationChanges).toContainEqual({
      kind: 'migration_count',
      label: 'Migration history',
      from: '2 / 2',
      to: '3 / 2',
    });
  });

  it('surfaces a runtime database warning while upstream relationships stay healthy', () => {
    const comparison = compareTruthReports(
      historySequences.runtimeDbWarning[0]!,
      historySequences.runtimeDbWarning[1]!,
    );
    expect(comparison.verdictChange.to).toBe('WARN');
    expect(comparison.findingChanges.some((change) => change.lifecycle === 'NEW')).toBe(true);
    expect(
      comparison.summary.unchangedRelationships.some(
        (label) => label.includes('GitHub') && label.includes('Vercel'),
      ),
    ).toBe(true);
  });

  it('produces deterministic safe JSON without metadata churn', () => {
    const from = historySequences.regression[0]!;
    const to = historySequences.regression[1]!;
    const first = compareTruthReports(from, to);
    const second = compareTruthReports(from, to);
    expect(first).toEqual(second);
    expect(serializeTruthReport(from)).not.toMatch(/ghp_|Bearer\s|postgres(?:ql)?:\/\//i);
    secretFree(first);
  });
});
