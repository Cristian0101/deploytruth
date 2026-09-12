import type { FindingChange, IdentityChange, RunComparison } from '@deploytruth/core';

const formatValue = (value: unknown): string => {
  if (value === undefined) return 'unknown';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
};

const formatFinding = (change: FindingChange): readonly string[] => {
  const heading =
    change.lifecycle === 'NEW'
      ? 'NEW FINDING'
      : change.lifecycle === 'RESOLVED'
        ? 'RESOLVED'
        : change.lifecycle === 'CHANGED'
          ? 'CHANGED FINDING'
          : 'PERSISTING';
  const lines = ['', heading, '', change.code];
  const severity = change.toSeverity ?? change.fromSeverity;
  if (severity !== undefined) {
    lines.push(severity);
  }
  if (
    change.lifecycle !== 'RESOLVED' &&
    (change.toExpected !== undefined || change.fromExpected !== undefined)
  ) {
    lines.push('', 'Expected', formatValue(change.toExpected ?? change.fromExpected));
  }
  if (
    change.lifecycle !== 'RESOLVED' &&
    (change.toObserved !== undefined || change.fromObserved !== undefined)
  ) {
    lines.push('', 'Observed', formatValue(change.toObserved ?? change.fromObserved));
  }
  if (change.lifecycle === 'CHANGED') {
    if (change.fromExpected !== undefined || change.toExpected !== undefined) {
      lines.push(
        '',
        `Expected ${formatValue(change.fromExpected)} → ${formatValue(change.toExpected)}`,
      );
    }
    if (change.fromObserved !== undefined || change.toObserved !== undefined) {
      lines.push(
        `Observed ${formatValue(change.fromObserved)} → ${formatValue(change.toObserved)}`,
      );
    }
  }
  if (change.relationship !== undefined) {
    lines.push('', 'Relationship', change.relationship);
  }
  return lines;
};

const formatIdentity = (change: IdentityChange): readonly string[] => [
  change.label,
  `${change.from} → ${change.to}`,
  '',
];

export const formatRunComparison = (comparison: RunComparison): string => {
  const { from, to, verdictChange, findingChanges, observationChanges, summary } = comparison;
  const lines = [
    'DeployTruth Diff',
    '',
    to.environment,
    '',
    `${verdictChange.from} → ${verdictChange.to}`,
    '',
  ];

  if (verdictChange.kind === 'regression') {
    lines.push('REGRESSION', '');
  } else if (verdictChange.kind === 'recovered') {
    lines.push('RECOVERED', '');
  }

  const identities = observationChanges.filter((change) => change.from !== change.to);
  if (identities.length > 0) {
    lines.push('CHANGED');
    for (const change of identities) {
      lines.push(...formatIdentity(change));
    }
  }

  if (summary.unchangedRelationships.length > 0) {
    lines.push('UNCHANGED');
    for (const relationship of summary.unchangedRelationships) {
      lines.push(relationship);
    }
    lines.push('');
  }

  const notable = findingChanges.filter((change) => change.lifecycle !== 'PERSISTING');
  for (const change of notable) {
    lines.push(...formatFinding(change));
  }

  lines.push(
    '',
    'Findings',
    `${summary.newFindings} new`,
    `${summary.resolvedFindings} resolved`,
    `${summary.persistingFindings} persisting`,
  );
  if (summary.changedFindings > 0) {
    lines.push(`${summary.changedFindings} changed`);
  }

  lines.push('', `From ${from.runId}`, `To   ${to.runId}`);
  return lines.join('\n');
};
