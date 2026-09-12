import type {
  DeclaredEnvironment,
  EnvironmentObservation,
  Topology,
  TopologyEdge,
  TopologyHealth,
  TopologyNode,
  TruthFinding,
} from './domain.js';

const nodeId = (environment: string, type: string): string => `${environment}:${type}`;

const healthFor = (findings: readonly TruthFinding[]): TopologyHealth => {
  if (findings.some((finding) => finding.status === 'FAIL')) {
    return 'failed';
  }
  if (findings.some((finding) => finding.status === 'WARN')) {
    return 'warning';
  }
  return 'healthy';
};

const findingsFor = (
  findings: readonly TruthFinding[],
  environment: string,
  type: TopologyNode['type'],
): readonly TruthFinding[] =>
  findings.filter((finding) =>
    finding.affectedComponents.some(
      (affected) => affected.environment === environment && affected.type === type,
    ),
  );

const node = (
  id: string,
  provider: string,
  type: TopologyNode['type'],
  environment: string,
  label: string,
  findings: readonly TruthFinding[],
  metadata: TopologyNode['metadata'] = {},
): TopologyNode => ({
  id,
  provider,
  type,
  environment,
  label,
  health: healthFor(findings),
  metadata,
});

const edge = (
  source: string,
  target: string,
  expected: boolean,
  observed: boolean,
  findings: readonly TruthFinding[],
): TopologyEdge => ({
  id: `${source}->${target}`,
  source,
  target,
  expected,
  observed,
  health: healthFor(findings),
  findings: findings.map((finding) => finding.code).sort(),
});

export const buildEnvironmentTopology = (
  environment: DeclaredEnvironment,
  observation: EnvironmentObservation | undefined,
  findings: readonly TruthFinding[],
): Topology => {
  const nodes: TopologyNode[] = [];
  const edges: TopologyEdge[] = [];
  const source = nodeId(environment.id, 'source');
  const deployment = nodeId(environment.id, 'deployment');
  const database = nodeId(environment.id, 'database');
  const runtime = nodeId(environment.id, 'runtime');

  if (environment.source) {
    nodes.push(
      node(
        source,
        environment.source.provider,
        'source',
        environment.id,
        environment.source.repository ?? environment.source.provider,
        findingsFor(findings, environment.id, 'source'),
        {
          branch: environment.source.branch ?? 'unknown',
          sha:
            observation?.remoteSource?.remoteHeadSha ??
            observation?.source?.remoteHeadSha ??
            observation?.source?.headSha ??
            'unknown',
        },
      ),
    );
  }

  if (environment.deployment) {
    nodes.push(
      node(
        deployment,
        environment.deployment.provider,
        'deployment',
        environment.id,
        environment.deployment.project,
        findingsFor(findings, environment.id, 'deployment'),
        { sha: observation?.deployment?.commitSha ?? 'unknown' },
      ),
    );
  }

  if (environment.database) {
    nodes.push(
      node(
        database,
        environment.database.provider,
        'database',
        environment.id,
        environment.database.projectRef,
        findingsFor(findings, environment.id, 'database'),
        {
          identity: observation?.database?.identity ?? 'unknown',
          migrationHistory: observation?.database?.migrationHistory?.state ?? 'unknown',
        },
      ),
    );
  }

  if (environment.runtime) {
    nodes.push(
      node(
        runtime,
        'runtime',
        'runtime',
        environment.id,
        environment.runtime.url,
        findingsFor(findings, environment.id, 'runtime'),
        { sha: observation?.runtime?.commitSha ?? 'unknown' },
      ),
    );
  }

  if (environment.source && environment.deployment) {
    edges.push(
      edge(source, deployment, true, Boolean(observation?.deployment), [
        ...findingsFor(findings, environment.id, 'source'),
        ...findingsFor(findings, environment.id, 'deployment'),
      ]),
    );
  }

  if (environment.deployment && environment.database) {
    const connection = observation?.deployment?.connectedResources.find(
      (resource) => resource.type === 'database',
    );
    edges.push(
      edge(deployment, database, true, connection?.identifier === environment.database.projectRef, [
        ...findingsFor(findings, environment.id, 'deployment'),
        ...findingsFor(findings, environment.id, 'database'),
      ]),
    );
  }

  if (environment.deployment && environment.runtime) {
    edges.push(
      edge(deployment, runtime, true, Boolean(observation?.runtime?.reachable), [
        ...findingsFor(findings, environment.id, 'deployment'),
        ...findingsFor(findings, environment.id, 'runtime'),
      ]),
    );
  }

  return {
    nodes: nodes.sort((left, right) => left.id.localeCompare(right.id)),
    edges: edges.sort((left, right) => left.id.localeCompare(right.id)),
  };
};

export const mergeTopologies = (topologies: readonly Topology[]): Topology => ({
  nodes: topologies
    .flatMap((topology) => topology.nodes)
    .sort((left, right) => left.id.localeCompare(right.id)),
  edges: topologies
    .flatMap((topology) => topology.edges)
    .sort((left, right) => left.id.localeCompare(right.id)),
});
