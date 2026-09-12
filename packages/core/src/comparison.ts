import { z } from 'zod';

import {
  checkNameSchema,
  findingStatusSchema,
  REPORT_SCHEMA_VERSION,
  safeValueSchema,
  severitySchema,
  topologyHealthSchema,
  verdictSchema,
  type CheckName,
  type EnvironmentTruth,
  type SafeValue,
  type Topology,
  type TopologyNode,
  type TruthFinding,
  type TruthReport,
  type Verdict,
} from './domain.js';
import { activeChecksFor, checkNameForFindingCode } from './rules.js';
import { topologyEdgeLabel, topologyNodeLabel } from './topology.js';

export const checkStateSchema = z.enum(['VERIFIED', 'WARNING', 'FAILED', 'UNKNOWN', 'NOT_CHECKED']);
export type CheckState = z.infer<typeof checkStateSchema>;

export const verdictTransitionKindSchema = z.enum(['unchanged', 'regression', 'recovered']);
export type VerdictTransitionKind = z.infer<typeof verdictTransitionKindSchema>;

export const findingLifecycleSchema = z.enum(['NEW', 'RESOLVED', 'PERSISTING', 'CHANGED']);
export type FindingLifecycle = z.infer<typeof findingLifecycleSchema>;

export const comparedRunSchema = z
  .object({
    runId: z.string().min(1),
    timestamp: z.string().datetime({ offset: true }),
    project: z.string().min(1),
    environment: z.string().min(1),
    verdict: verdictSchema,
    reportVersion: z.string().min(1),
    sourceCommit: z.string().min(1).optional(),
  })
  .strict();
export type ComparedRun = z.infer<typeof comparedRunSchema>;

export const verdictChangeSchema = z
  .object({
    from: verdictSchema,
    to: verdictSchema,
    kind: verdictTransitionKindSchema,
  })
  .strict();
export type VerdictChange = z.infer<typeof verdictChangeSchema>;

export const findingChangeSchema = z
  .object({
    identity: z.string().min(1),
    lifecycle: findingLifecycleSchema,
    code: z.string().min(1),
    title: z.string().min(1),
    relationship: z.string().min(1).optional(),
    fromStatus: findingStatusSchema.optional(),
    toStatus: findingStatusSchema.optional(),
    fromSeverity: severitySchema.optional(),
    toSeverity: severitySchema.optional(),
    fromExpected: safeValueSchema.optional(),
    toExpected: safeValueSchema.optional(),
    fromObserved: safeValueSchema.optional(),
    toObserved: safeValueSchema.optional(),
  })
  .strict();
export type FindingChange = z.infer<typeof findingChangeSchema>;

export const checkChangeSchema = z
  .object({
    check: checkNameSchema,
    from: checkStateSchema,
    to: checkStateSchema,
  })
  .strict();
export type CheckChange = z.infer<typeof checkChangeSchema>;

export const identityChangeSchema = z
  .object({
    kind: z.enum([
      'source_sha',
      'deployment_sha',
      'runtime_sha',
      'runtime_environment',
      'database_project',
      'migration_count',
    ]),
    label: z.string().min(1),
    from: z.string().min(1),
    to: z.string().min(1),
  })
  .strict();
export type IdentityChange = z.infer<typeof identityChangeSchema>;

export const topologyNodeChangeSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    change: z.enum(['added', 'removed', 'changed']),
    fromHealth: topologyHealthSchema.optional(),
    toHealth: topologyHealthSchema.optional(),
  })
  .strict();
export type TopologyNodeChange = z.infer<typeof topologyNodeChangeSchema>;

export const topologyEdgeChangeSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    change: z.enum(['added', 'removed', 'changed']),
    fromHealth: topologyHealthSchema.optional(),
    toHealth: topologyHealthSchema.optional(),
  })
  .strict();
export type TopologyEdgeChange = z.infer<typeof topologyEdgeChangeSchema>;

export const comparisonSummarySchema = z
  .object({
    newFindings: z.number().int().nonnegative(),
    resolvedFindings: z.number().int().nonnegative(),
    persistingFindings: z.number().int().nonnegative(),
    changedFindings: z.number().int().nonnegative(),
    identityChanges: z.number().int().nonnegative(),
    topologyChanges: z.number().int().nonnegative(),
    unchangedRelationships: z.array(z.string().min(1)),
  })
  .strict();
export type ComparisonSummary = z.infer<typeof comparisonSummarySchema>;

export const runComparisonSchema = z
  .object({
    from: comparedRunSchema,
    to: comparedRunSchema,
    verdictChange: verdictChangeSchema,
    findingChanges: z.array(findingChangeSchema),
    checkChanges: z.array(checkChangeSchema),
    observationChanges: z.array(identityChangeSchema),
    topologyChanges: z
      .object({
        nodes: z.array(topologyNodeChangeSchema),
        edges: z.array(topologyEdgeChangeSchema),
      })
      .strict(),
    summary: comparisonSummarySchema,
  })
  .strict();
export type RunComparison = z.infer<typeof runComparisonSchema>;

export class ComparisonError extends Error {
  readonly code: 'unsupported_version' | 'invalid_report';

  constructor(code: ComparisonError['code'], message: string) {
    super(message);
    this.name = 'ComparisonError';
    this.code = code;
  }
}

const CHECK_ORDER: readonly CheckName[] = [
  'local_git',
  'remote_source',
  'deployment_sha',
  'runtime_identity',
  'environment_variables',
  'environment_isolation',
  'migrations',
];

const VERDICT_RANK: Readonly<Record<Verdict, number>> = { PASS: 0, WARN: 1, FAIL: 2 };

const canonical = (value: SafeValue | undefined): string => {
  if (value === undefined) return '';
  const normalize = (entry: SafeValue): SafeValue => {
    if (Array.isArray(entry)) {
      return entry.map((item) => normalize(item));
    }
    if (entry !== null && typeof entry === 'object') {
      return Object.fromEntries(
        Object.entries(entry)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
};

/**
 * Finding identity is code + the sorted affected component tuples.
 * Expected, observed, evidence, and array position are intentionally excluded so a SHA
 * change on the same relationship is CHANGED rather than NEW+RESOLVED.
 */
export const findingIdentity = (finding: TruthFinding): string => {
  const components = finding.affectedComponents
    .map((part) => `${part.environment}:${part.type}:${part.identifier ?? ''}`)
    .sort((left, right) => left.localeCompare(right))
    .join(',');
  return `${finding.code}|${components}`;
};

const environmentOf = (report: TruthReport): EnvironmentTruth | undefined => report.environments[0];

const sourceCommitOf = (report: TruthReport): string | undefined => {
  const observation = environmentOf(report)?.observation;
  return observation?.remoteSource?.remoteHeadSha ?? observation?.source?.headSha;
};

const comparedRun = (report: TruthReport): ComparedRun => {
  const environment = environmentOf(report)?.environment ?? 'unknown';
  const sourceCommit = sourceCommitOf(report);
  return {
    runId: report.runId,
    timestamp: report.generatedAt,
    project: report.project,
    environment,
    verdict: report.verdict,
    reportVersion: report.schemaVersion,
    ...(sourceCommit === undefined ? {} : { sourceCommit }),
  };
};

export const verdictTransitionKind = (from: Verdict, to: Verdict): VerdictTransitionKind => {
  if (from === to) return 'unchanged';
  return VERDICT_RANK[to] > VERDICT_RANK[from] ? 'regression' : 'recovered';
};

const relationshipForFinding = (finding: TruthFinding, topology: Topology): string | undefined => {
  const edge = topology.edges.find((entry) => entry.findings.includes(finding.code));
  if (edge) {
    return topologyEdgeLabel(edge, topology);
  }
  const components = finding.affectedComponents
    .map((part) => part.type)
    .filter((value, index, all) => all.indexOf(value) === index);
  if (components.length >= 2) {
    return components.join(' → ');
  }
  return finding.affectedComponents[0]?.type;
};

const findingChange = (
  lifecycle: FindingLifecycle,
  identity: string,
  fromFinding: TruthFinding | undefined,
  toFinding: TruthFinding | undefined,
  fromTopology: Topology,
  toTopology: Topology,
): FindingChange => {
  const finding = toFinding ?? fromFinding;
  if (finding === undefined) {
    throw new ComparisonError('invalid_report', 'Finding change is missing both sides.');
  }
  const relationship = relationshipForFinding(finding, toFinding ? toTopology : fromTopology);
  return {
    identity,
    lifecycle,
    code: finding.code,
    title: finding.title,
    ...(relationship === undefined ? {} : { relationship }),
    ...(fromFinding ? { fromStatus: fromFinding.status, fromSeverity: fromFinding.severity } : {}),
    ...(toFinding ? { toStatus: toFinding.status, toSeverity: toFinding.severity } : {}),
    ...(fromFinding?.expected !== undefined ? { fromExpected: fromFinding.expected } : {}),
    ...(toFinding?.expected !== undefined ? { toExpected: toFinding.expected } : {}),
    ...(fromFinding?.observed !== undefined ? { fromObserved: fromFinding.observed } : {}),
    ...(toFinding?.observed !== undefined ? { toObserved: toFinding.observed } : {}),
  };
};

const unavailableChecks = (truth: EnvironmentTruth): readonly string[] => {
  const coverage = truth.findings.find(
    (finding) => finding.code === 'REQUIRED_OBSERVATION_UNAVAILABLE',
  );
  const raw = coverage?.evidence['unavailableChecks'];
  return Array.isArray(raw) ? raw.map(String) : [];
};

export const checkStateFor = (truth: EnvironmentTruth, check: CheckName): CheckState => {
  if (!activeChecksFor(truth.declaration).includes(check)) {
    return 'NOT_CHECKED';
  }
  const related = truth.findings.filter(
    (finding) => checkNameForFindingCode(finding.code) === check,
  );
  if (related.some((finding) => finding.status === 'FAIL')) {
    return 'FAILED';
  }
  if (related.some((finding) => finding.status === 'WARN')) {
    return 'WARNING';
  }
  if (unavailableChecks(truth).includes(check)) {
    return 'UNKNOWN';
  }
  return 'VERIFIED';
};

const checkChangesFor = (from: EnvironmentTruth, to: EnvironmentTruth): readonly CheckChange[] =>
  CHECK_ORDER.flatMap((check) => {
    const previous = checkStateFor(from, check);
    const next = checkStateFor(to, check);
    return previous === next ? [] : [{ check, from: previous, to: next }];
  });

const displaySha = (value: string | undefined): string => value ?? 'unknown';

const identityChangesFor = (
  from: EnvironmentTruth | undefined,
  to: EnvironmentTruth | undefined,
): readonly IdentityChange[] => {
  const changes: IdentityChange[] = [];
  const push = (
    kind: IdentityChange['kind'],
    label: string,
    previous: string,
    next: string,
  ): void => {
    if (previous !== next) {
      changes.push({ kind, label, from: previous, to: next });
    }
  };

  push(
    'source_sha',
    'GitHub source',
    displaySha(
      from?.observation?.remoteSource?.remoteHeadSha ?? from?.observation?.source?.headSha,
    ),
    displaySha(to?.observation?.remoteSource?.remoteHeadSha ?? to?.observation?.source?.headSha),
  );
  push(
    'deployment_sha',
    'Vercel deployment',
    displaySha(from?.observation?.deployment?.commitSha),
    displaySha(to?.observation?.deployment?.commitSha),
  );
  push(
    'runtime_sha',
    'Runtime',
    displaySha(from?.observation?.runtime?.commitSha),
    displaySha(to?.observation?.runtime?.commitSha),
  );
  push(
    'runtime_environment',
    'Runtime environment',
    from?.observation?.runtime?.environment ?? 'unknown',
    to?.observation?.runtime?.environment ?? 'unknown',
  );
  push(
    'database_project',
    'Supabase project',
    from?.observation?.database?.observedProjectRef ??
      from?.observation?.database?.projectRef ??
      from?.declaration.database?.projectRef ??
      'unknown',
    to?.observation?.database?.observedProjectRef ??
      to?.observation?.database?.projectRef ??
      to?.declaration.database?.projectRef ??
      'unknown',
  );

  const fromApplied = from?.observation?.database?.appliedMigrationIds.length ?? 0;
  const fromExpected = from?.observation?.repositoryMigrations?.migrationIds.length ?? 0;
  const toApplied = to?.observation?.database?.appliedMigrationIds.length ?? 0;
  const toExpected = to?.observation?.repositoryMigrations?.migrationIds.length ?? 0;
  push(
    'migration_count',
    'Migration history',
    `${fromApplied} / ${fromExpected}`,
    `${toApplied} / ${toExpected}`,
  );

  return changes;
};

const nodeTruth = (node: TopologyNode): string =>
  canonical({
    health: node.health,
    identity: node.metadata['identity'] ?? null,
    migrationHistory: node.metadata['migrationHistory'] ?? null,
    availability: node.metadata['availability'] ?? null,
    databaseTarget: node.metadata['databaseTarget'] ?? null,
    databaseConnection: node.metadata['databaseConnection'] ?? null,
  });

const topologyChangesFor = (
  from: Topology,
  to: Topology,
): {
  readonly nodes: TopologyNodeChange[];
  readonly edges: TopologyEdgeChange[];
  readonly unchangedRelationships: string[];
} => {
  const fromNodes = new Map(from.nodes.map((node) => [node.id, node]));
  const toNodes = new Map(to.nodes.map((node) => [node.id, node]));
  const nodeIds = [...new Set([...fromNodes.keys(), ...toNodes.keys()])].sort((left, right) =>
    left.localeCompare(right),
  );
  const nodes: TopologyNodeChange[] = [];
  for (const id of nodeIds) {
    const previous = fromNodes.get(id);
    const next = toNodes.get(id);
    if (previous === undefined && next !== undefined) {
      nodes.push({
        id,
        label: topologyNodeLabel(next),
        change: 'added',
        toHealth: next.health,
      });
      continue;
    }
    if (previous !== undefined && next === undefined) {
      nodes.push({
        id,
        label: topologyNodeLabel(previous),
        change: 'removed',
        fromHealth: previous.health,
      });
      continue;
    }
    if (previous !== undefined && next !== undefined && nodeTruth(previous) !== nodeTruth(next)) {
      nodes.push({
        id,
        label: topologyNodeLabel(next),
        change: 'changed',
        fromHealth: previous.health,
        toHealth: next.health,
      });
    }
  }

  const fromEdges = new Map(from.edges.map((edge) => [edge.id, edge]));
  const toEdges = new Map(to.edges.map((edge) => [edge.id, edge]));
  const edgeIds = [...new Set([...fromEdges.keys(), ...toEdges.keys()])].sort((left, right) =>
    left.localeCompare(right),
  );
  const unchangedRelationships: string[] = [];
  const edges: TopologyEdgeChange[] = [];
  for (const id of edgeIds) {
    const previous = fromEdges.get(id);
    const next = toEdges.get(id);
    if (previous === undefined && next !== undefined) {
      edges.push({
        id,
        label: topologyEdgeLabel(next, to),
        change: 'added',
        toHealth: next.health,
      });
      continue;
    }
    if (previous !== undefined && next === undefined) {
      edges.push({
        id,
        label: topologyEdgeLabel(previous, from),
        change: 'removed',
        fromHealth: previous.health,
      });
      continue;
    }
    if (previous !== undefined && next !== undefined) {
      const label = topologyEdgeLabel(next, to);
      if (
        previous.health === next.health &&
        previous.expected === next.expected &&
        previous.observed === next.observed
      ) {
        unchangedRelationships.push(label);
        continue;
      }
      edges.push({
        id,
        label,
        change: 'changed',
        fromHealth: previous.health,
        toHealth: next.health,
      });
    }
  }

  return { nodes, edges, unchangedRelationships };
};

const findingChangesFor = (from: TruthReport, to: TruthReport): readonly FindingChange[] => {
  const fromMap = new Map(from.findings.map((finding) => [findingIdentity(finding), finding]));
  const toMap = new Map(to.findings.map((finding) => [findingIdentity(finding), finding]));
  const identities = [...new Set([...fromMap.keys(), ...toMap.keys()])].sort((left, right) =>
    left.localeCompare(right),
  );

  return identities.map((identity) => {
    const previous = fromMap.get(identity);
    const next = toMap.get(identity);
    if (previous === undefined && next !== undefined) {
      return findingChange('NEW', identity, undefined, next, from.topology, to.topology);
    }
    if (previous !== undefined && next === undefined) {
      return findingChange('RESOLVED', identity, previous, undefined, from.topology, to.topology);
    }
    if (previous !== undefined && next !== undefined) {
      const changed =
        previous.status !== next.status ||
        previous.severity !== next.severity ||
        canonical(previous.expected) !== canonical(next.expected) ||
        canonical(previous.observed) !== canonical(next.observed);
      return findingChange(
        changed ? 'CHANGED' : 'PERSISTING',
        identity,
        previous,
        next,
        from.topology,
        to.topology,
      );
    }
    throw new ComparisonError('invalid_report', 'Finding identity comparison lost both sides.');
  });
};

export const compareTruthReports = (from: TruthReport, to: TruthReport): RunComparison => {
  if (from.schemaVersion !== REPORT_SCHEMA_VERSION || to.schemaVersion !== REPORT_SCHEMA_VERSION) {
    throw new ComparisonError('unsupported_version', 'UNSUPPORTED REPORT VERSION');
  }

  const fromTruth = environmentOf(from);
  const toTruth = environmentOf(to);
  const findingChanges = findingChangesFor(from, to);
  const checkChanges = fromTruth && toTruth ? checkChangesFor(fromTruth, toTruth) : [];
  const observationChanges = identityChangesFor(fromTruth, toTruth);
  const topology = topologyChangesFor(from.topology, to.topology);
  const comparison: RunComparison = {
    from: comparedRun(from),
    to: comparedRun(to),
    verdictChange: {
      from: from.verdict,
      to: to.verdict,
      kind: verdictTransitionKind(from.verdict, to.verdict),
    },
    findingChanges: [...findingChanges],
    checkChanges: [...checkChanges],
    observationChanges: [...observationChanges],
    topologyChanges: { nodes: topology.nodes, edges: topology.edges },
    summary: {
      newFindings: findingChanges.filter((change) => change.lifecycle === 'NEW').length,
      resolvedFindings: findingChanges.filter((change) => change.lifecycle === 'RESOLVED').length,
      persistingFindings: findingChanges.filter((change) => change.lifecycle === 'PERSISTING')
        .length,
      changedFindings: findingChanges.filter((change) => change.lifecycle === 'CHANGED').length,
      identityChanges: observationChanges.length,
      topologyChanges: topology.nodes.length + topology.edges.length,
      unchangedRelationships: topology.unchangedRelationships,
    },
  };

  return runComparisonSchema.parse(comparison);
};
