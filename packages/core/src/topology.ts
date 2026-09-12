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

type TopologyRelationship =
  | 'source_to_deployment'
  | 'deployment_to_runtime'
  | 'runtime_to_database'
  | 'deployment_to_database';

const findingRelationships: Readonly<Record<string, TopologyRelationship>> = {
  DEPLOYMENT_SHA_MISMATCH: 'source_to_deployment',
  DEPLOYMENT_SOURCE_UNVERIFIED: 'source_to_deployment',
  RUNTIME_SHA_MISMATCH: 'deployment_to_runtime',
  RUNTIME_ATTESTATION_UNAVAILABLE: 'deployment_to_runtime',
  RUNTIME_ATTESTATION_FRESHNESS_UNVERIFIED: 'deployment_to_runtime',
  RUNTIME_ENVIRONMENT_MISMATCH: 'deployment_to_runtime',
  RUNTIME_DATABASE_PROJECT_MISMATCH: 'runtime_to_database',
  RUNTIME_DATABASE_IDENTITY_UNVERIFIED: 'runtime_to_database',
  RUNTIME_DATABASE_CONNECTION_UNAVAILABLE: 'runtime_to_database',
  WRONG_DATABASE_PROJECT: 'deployment_to_database',
  PREVIEW_USES_PRODUCTION_DATABASE: 'deployment_to_database',
};

const findingsForRelationship = (
  findings: readonly TruthFinding[],
  relationship: TopologyRelationship,
): readonly TruthFinding[] =>
  findings.filter((finding) => findingRelationships[finding.code] === relationship);

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

const runtimeAttestationVerified = (observation: EnvironmentObservation | undefined): boolean => {
  const runtime = observation?.runtime;
  if (runtime === undefined) {
    return false;
  }
  return runtime.availability === undefined
    ? runtime.reachable
    : runtime.availability.state === 'available' && runtime.freshness?.state === 'verified';
};

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
        {
          availability: observation?.runtime?.availability?.state ?? 'unknown',
          freshness: observation?.runtime?.freshness?.state ?? 'unknown',
          sha: observation?.runtime?.commitSha ?? 'unknown',
          environment: observation?.runtime?.environment ?? 'unknown',
          requiredEnvironmentVariables: environment.requiredEnvironmentVariables.length,
          presentEnvironmentVariables:
            observation?.runtime?.environmentVariables?.filter((variable) => variable.present)
              .length ?? 0,
          ...(observation?.runtime?.databaseConnection !== undefined
            ? {
                databaseProvider: observation.runtime.databaseConnection.provider,
                databaseTarget:
                  observation.runtime.databaseConnection.targetProjectRef ?? 'unverified',
                databaseConnection: observation.runtime.databaseConnection.status,
              }
            : {}),
        },
      ),
    );
  }

  if (environment.source && environment.deployment) {
    edges.push(
      edge(
        source,
        deployment,
        true,
        Boolean(observation?.deployment),
        findingsForRelationship(findings, 'source_to_deployment'),
      ),
    );
  }

  if (environment.deployment && environment.database && !environment.runtime) {
    const connection = observation?.deployment?.connectedResources.find(
      (resource) => resource.type === 'database',
    );
    edges.push(
      edge(
        deployment,
        database,
        true,
        connection?.identifier === environment.database.projectRef,
        findingsForRelationship(findings, 'deployment_to_database'),
      ),
    );
  }

  if (environment.deployment && environment.runtime) {
    const deploymentSha = observation?.deployment?.commitSha;
    const runtimeSha = observation?.runtime?.commitSha;
    edges.push(
      edge(
        deployment,
        runtime,
        true,
        runtimeAttestationVerified(observation) &&
          deploymentSha !== undefined &&
          runtimeSha !== undefined &&
          deploymentSha === runtimeSha,
        findingsForRelationship(findings, 'deployment_to_runtime'),
      ),
    );
  }

  if (environment.runtime && environment.database) {
    const runtimeConnection = observation?.runtime?.databaseConnection;
    edges.push(
      edge(
        runtime,
        database,
        true,
        runtimeAttestationVerified(observation) &&
          runtimeConnection?.identity === 'verified' &&
          runtimeConnection.targetProjectRef === environment.database.projectRef &&
          runtimeConnection.status === 'connected',
        findingsForRelationship(findings, 'runtime_to_database'),
      ),
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
