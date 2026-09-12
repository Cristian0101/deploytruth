import { useMemo } from 'react';
import type { TopologyEdge, TopologyNode, TruthFinding, TruthReport } from '@deploytruth/core';
import {
  Background,
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  ReactFlow,
  getStraightPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Database,
  GitBranch,
  HardDrives,
  RocketLaunch,
  TerminalWindow,
} from '@phosphor-icons/react';

import {
  edgeLabel,
  findingForEdge,
  operationalStatus,
  shortId,
} from '../lib/report-presentation.js';
import { StatusBadge, StatusIcon, type DisplayStatus } from './status-badge.js';

interface TruthMapProps {
  readonly report: TruthReport;
  readonly selectedFinding?: TruthFinding | undefined;
  readonly onSelectFinding: (finding: TruthFinding) => void;
}

interface NodeData extends Record<string, unknown> {
  readonly node: TopologyNode;
  readonly report: TruthReport;
  readonly status: DisplayStatus;
}

interface EdgeData extends Record<string, unknown> {
  readonly label: string;
  readonly status: DisplayStatus;
  readonly finding?: TruthFinding | undefined;
  readonly onSelectFinding: (finding: TruthFinding) => void;
}

const NodeIcon = ({ type }: { readonly type: TopologyNode['type'] }) => {
  if (type === 'source') return <GitBranch weight="duotone" />;
  if (type === 'deployment') return <RocketLaunch weight="duotone" />;
  if (type === 'runtime') return <TerminalWindow weight="duotone" />;
  if (type === 'database') return <Database weight="duotone" />;
  return <HardDrives weight="duotone" />;
};

const primaryLabel = (node: TopologyNode): string => {
  if (node.id.endsWith(':migration-history')) return 'Migration History';
  if (node.type === 'source')
    return node.provider.toLowerCase() === 'github' ? 'GitHub' : node.provider;
  if (node.type === 'deployment')
    return `${node.provider[0]?.toUpperCase() ?? ''}${node.provider.slice(1)} Production`;
  if (node.type === 'runtime') return 'Runtime';
  if (node.type === 'database') return node.provider[0]?.toUpperCase() + node.provider.slice(1);
  return node.label;
};

const nodeFacts = (node: TopologyNode, report: TruthReport): readonly string[] => {
  const environment = report.environments.find((entry) => entry.environment === node.environment);
  const observation = environment?.observation;
  if (node.id.endsWith(':migration-history'))
    return [
      `${observation?.database?.appliedMigrationIds.length ?? 0} applied`,
      `${observation?.repositoryMigrations?.migrationIds.length ?? 0} expected`,
      observation?.repositoryMigrations?.availability?.state ?? 'Not observed',
    ];
  if (node.type === 'source')
    return [String(node.metadata.branch ?? 'unknown'), shortId(node.metadata.sha)];
  if (node.type === 'deployment')
    return [
      observation?.deployment?.state?.toUpperCase() ?? 'Observed',
      shortId(node.metadata.sha),
    ];
  if (node.type === 'runtime')
    return [
      String(node.metadata.environment ?? node.environment),
      `Freshness ${String(node.metadata.freshness ?? 'unknown')}`,
      shortId(node.metadata.sha),
    ];
  if (node.type === 'database')
    return [
      shortId(node.label),
      observation?.database?.connection?.state === 'available'
        ? 'Read-only probe OK'
        : 'Connection not established',
    ];
  return [node.provider, node.environment];
};

const TruthNodeCard = ({ data }: NodeProps<Node<NodeData>>) => (
  <article className="truth-node" aria-label={`${primaryLabel(data.node)} ${data.status}`}>
    <Handle type="target" position={Position.Top} isConnectable={false} />
    <div className="truth-node__icon">
      <NodeIcon type={data.node.type} />
    </div>
    <div className="truth-node__body">
      <strong>{primaryLabel(data.node)}</strong>
      <div className="truth-node__facts">
        {nodeFacts(data.node, data.report).map((fact, index) => (
          <span key={`${fact}-${index}`}>{fact}</span>
        ))}
      </div>
    </div>
    <StatusBadge status={data.status} />
    <Handle type="source" position={Position.Bottom} isConnectable={false} />
  </article>
);

const TruthRelationship = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps<Edge<EdgeData>>) => {
  const [path, labelX, labelY] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  const status = data?.status ?? 'UNKNOWN';
  const tone =
    status === 'FAIL'
      ? 'failed'
      : status === 'WARN'
        ? 'warning'
        : status === 'UNKNOWN'
          ? 'unknown'
          : 'verified';
  return (
    <>
      <BaseEdge id={id} path={path} className={`truth-edge truth-edge--${tone}`} />
      <EdgeLabelRenderer>
        <button
          type="button"
          className={`edge-label edge-label--${tone} nodrag nopan`}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          onClick={() => data?.finding && data.onSelectFinding(data.finding)}
          disabled={!data?.finding}
          aria-label={`${data?.label ?? 'Relationship'}: ${status}${data?.finding ? ', open finding' : ''}`}
        >
          <StatusIcon status={status} />
          <span>{data?.label}</span>
        </button>
      </EdgeLabelRenderer>
    </>
  );
};

const nodeTypes = { truth: TruthNodeCard };
const edgeTypes = { truth: TruthRelationship };

const layout = (report: TruthReport): { nodes: Node<NodeData>[]; edges: Edge<EdgeData>[] } => {
  const auxiliaryNodes: TopologyNode[] = [];
  const auxiliaryEdges: TopologyEdge[] = [];
  for (const environment of report.environments) {
    const databaseNode = report.topology.nodes.find(
      (node) => node.environment === environment.environment && node.type === 'database',
    );
    const catalog = environment.observation?.repositoryMigrations;
    if (!databaseNode || !catalog) continue;
    const migrationFindings = environment.findings.filter((finding) =>
      finding.code.includes('MIGRATION'),
    );
    const health = migrationFindings.some((finding) => finding.status === 'FAIL')
      ? 'failed'
      : migrationFindings.some((finding) => finding.status === 'WARN')
        ? 'warning'
        : catalog.availability?.state === 'unavailable'
          ? 'unknown'
          : 'healthy';
    const id = `${environment.environment}:migration-history`;
    auxiliaryNodes.push({
      id,
      provider: 'git',
      type: 'database',
      environment: environment.environment,
      label: catalog.directory,
      health,
      metadata: {
        applied: environment.observation?.database?.appliedMigrationIds.length ?? 0,
        expected: catalog.migrationIds.length,
      },
    });
    auxiliaryEdges.push({
      id: `${databaseNode.id}->${id}`,
      source: databaseNode.id,
      target: id,
      expected: true,
      observed: health === 'healthy',
      health,
      findings: migrationFindings.map((finding) => finding.code),
    });
  }
  const topologyNodes = [...report.topology.nodes, ...auxiliaryNodes];
  const topologyEdges = [...report.topology.edges, ...auxiliaryEdges];
  const byId = new Map(topologyNodes.map((node) => [node.id, node]));
  const incoming = new Map(topologyNodes.map((node) => [node.id, 0]));
  for (const edge of topologyEdges) incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  const roots = topologyNodes.filter((node) => (incoming.get(node.id) ?? 0) === 0);
  const ordered: TopologyNode[] = [];
  const visited = new Set<string>();
  const visit = (node: TopologyNode): void => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    ordered.push(node);
    topologyEdges
      .filter((edge) => edge.source === node.id)
      .map((edge) => byId.get(edge.target))
      .filter((target): target is TopologyNode => target !== undefined)
      .sort((left, right) => left.id.localeCompare(right.id))
      .forEach(visit);
  };
  roots.sort((left, right) => left.id.localeCompare(right.id)).forEach(visit);
  topologyNodes.forEach(visit);

  const nodes = ordered.map<Node<NodeData>>((node, index) => ({
    id: node.id,
    type: 'truth',
    position: { x: 0, y: index * 164 },
    draggable: false,
    selectable: false,
    data: {
      node,
      report,
      status: node.id.endsWith(':migration-history')
        ? node.health === 'failed'
          ? 'FAIL'
          : node.health === 'warning'
            ? 'WARN'
            : node.health === 'unknown'
              ? 'UNKNOWN'
              : 'VERIFIED'
        : operationalStatus(report, node),
    },
  }));
  const edges = topologyEdges.map<Edge<EdgeData>>((edge) => {
    const finding = findingForEdge(report, edge);
    const status: DisplayStatus =
      edge.health === 'failed'
        ? 'FAIL'
        : edge.health === 'warning'
          ? 'WARN'
          : edge.health === 'unknown' || !edge.observed
            ? 'UNKNOWN'
            : 'VERIFIED';
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'truth',
      selectable: false,
      data: {
        label: edgeLabel(report, edge),
        status,
        ...(finding ? { finding } : {}),
        onSelectFinding: () => undefined,
      },
    };
  });
  return { nodes, edges };
};

export const TruthMap = ({ report, selectedFinding, onSelectFinding }: TruthMapProps) => {
  const graph = useMemo(() => layout(report), [report]);
  const edges = useMemo(
    () =>
      graph.edges.map((edge) => ({
        ...edge,
        className: edge.data?.finding?.code === selectedFinding?.code ? 'is-selected' : '',
        data: { ...(edge.data ?? {}), onSelectFinding },
      })),
    [graph.edges, onSelectFinding, selectedFinding],
  );
  return (
    <div className="view truth-map-view">
      <header className="view-heading">
        <div>
          <p className="eyebrow">Controlled deployment target</p>
          <h1>Truth Map</h1>
          <p>End-to-end verification of what was declared and what actually runs.</p>
        </div>
        <StatusLegend />
      </header>
      <div className="truth-canvas" data-testid="truth-map">
        <ReactFlow
          nodes={graph.nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{ padding: 0.12, minZoom: 0.62, maxZoom: 1 }}
          minZoom={0.55}
          maxZoom={1.15}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
          aria-label="Deployment truth topology"
        >
          <Background color="rgba(129, 153, 181, 0.16)" gap={24} size={1} />
        </ReactFlow>
      </div>
    </div>
  );
};

const StatusLegend = () => (
  <aside className="status-legend" aria-label="Status language">
    <span>Status language</span>
    <div>
      <StatusIcon status="VERIFIED" />
      <p>
        <strong>Verified</strong>
        <small>Matches expected truth</small>
      </p>
    </div>
    <div>
      <StatusIcon status="WARN" />
      <p>
        <strong>Warning</strong>
        <small>Needs attention</small>
      </p>
    </div>
    <div>
      <StatusIcon status="FAIL" />
      <p>
        <strong>Failed</strong>
        <small>Deterministic contradiction</small>
      </p>
    </div>
    <div>
      <StatusIcon status="UNKNOWN" />
      <p>
        <strong>Unknown</strong>
        <small>Not yet established</small>
      </p>
    </div>
  </aside>
);
