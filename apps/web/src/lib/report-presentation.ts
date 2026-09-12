import type {
  EnvironmentTruth,
  SafeValue,
  TopologyEdge,
  TopologyNode,
  TruthFinding,
  TruthReport,
} from '@deploytruth/core';
import type { DisplayStatus } from '../components/status-badge.js';

export interface ReportCounts {
  readonly total: number;
  readonly verified: number;
  readonly warnings: number;
  readonly failures: number;
}

export const reportCounts = (report: TruthReport): ReportCounts => {
  const total = report.environments.reduce(
    (sum, environment) =>
      sum + Object.values(environment.declaration.checks).filter(Boolean).length,
    0,
  );
  const warnings = report.findings.filter((finding) => finding.status === 'WARN').length;
  const failures = report.findings.filter((finding) => finding.status === 'FAIL').length;
  return { total, warnings, failures, verified: Math.max(0, total - warnings - failures) };
};

export const shortId = (value: SafeValue | undefined): string => {
  if (typeof value !== 'string') return 'Not observed';
  if (value.length <= 14) return value;
  return `${value.slice(0, 7)}…${value.slice(-4)}`;
};

export const environmentForNode = (
  report: TruthReport,
  node: TopologyNode,
): EnvironmentTruth | undefined =>
  report.environments.find((entry) => entry.environment === node.environment);

export const operationalStatus = (report: TruthReport, node: TopologyNode): DisplayStatus => {
  const observation = environmentForNode(report, node)?.observation;
  if (node.type === 'source')
    return observation?.remoteSource?.availability?.state === 'available' ? 'VERIFIED' : 'UNKNOWN';
  if (node.type === 'deployment') {
    if (observation?.deployment?.availability?.state === 'unavailable') return 'UNKNOWN';
    return observation?.deployment?.state === 'ready' || observation?.deployment !== undefined
      ? 'READY'
      : 'UNKNOWN';
  }
  if (node.type === 'runtime') return observation?.runtime?.reachable ? 'VERIFIED' : 'UNKNOWN';
  if (node.type === 'database')
    return observation?.database?.connection?.state === 'available' ? 'CONNECTED' : 'UNKNOWN';
  return node.health === 'failed'
    ? 'FAIL'
    : node.health === 'warning'
      ? 'WARN'
      : node.health === 'unknown'
        ? 'UNKNOWN'
        : 'VERIFIED';
};

export const findingForEdge = (
  report: TruthReport,
  edge: TopologyEdge,
): TruthFinding | undefined => {
  const byCode = report.findings.find((finding) => edge.findings.includes(finding.code));
  if (byCode) return byCode;
  const source = report.topology.nodes.find((node) => node.id === edge.source);
  const target = report.topology.nodes.find((node) => node.id === edge.target);
  return report.findings.find(
    (finding) =>
      source &&
      target &&
      finding.affectedComponents.some(
        (part) => part.environment === source.environment && part.type === source.type,
      ) &&
      finding.affectedComponents.some(
        (part) => part.environment === target.environment && part.type === target.type,
      ),
  );
};

export const edgeLabel = (report: TruthReport, edge: TopologyEdge): string => {
  const finding = findingForEdge(report, edge);
  if (finding) return finding.title;
  if (edge.target.endsWith(':migration-history')) {
    const environment = report.environments.find((entry) =>
      edge.target.startsWith(`${entry.environment}:`),
    );
    const applied = environment?.observation?.database?.appliedMigrationIds.length ?? 0;
    const expected = environment?.observation?.repositoryMigrations?.migrationIds.length ?? 0;
    return `${applied} / ${expected} migrations verified`;
  }
  const source = report.topology.nodes.find((node) => node.id === edge.source);
  const target = report.topology.nodes.find((node) => node.id === edge.target);
  if (source?.type === 'source' && target?.type === 'deployment') return 'Source SHA verified';
  if (source?.type === 'deployment' && target?.type === 'runtime') return 'Runtime SHA verified';
  if (source?.type === 'runtime' && target?.type === 'database')
    return 'Target + read-only probe verified';
  return edge.observed ? 'Relationship verified' : 'Evidence not established';
};

export const evidenceLabel = (key: string): string =>
  key
    .replaceAll(/([a-z])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replace(/^./, (value) => value.toUpperCase());
export const formatSafeValue = (value: SafeValue | undefined): string =>
  value === undefined
    ? 'Not provided'
    : typeof value === 'string'
      ? value
      : JSON.stringify(value, null, 2);
