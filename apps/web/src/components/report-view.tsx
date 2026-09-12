import type { ReactNode } from 'react';
import type { EnvironmentTruth, TruthFinding, TruthReport } from '@deploytruth/core';
import {
  Code,
  Database,
  GitBranch,
  HardDrives,
  RocketLaunch,
  ShieldCheck,
  TerminalWindow,
  WarningCircle,
} from '@phosphor-icons/react';

import { reportCounts, shortId } from '../lib/report-presentation.js';
import { StatusBadge } from './status-badge.js';

interface ReportViewProps {
  readonly report: TruthReport;
  readonly onSelectFinding: (finding: TruthFinding) => void;
}
interface ReportRowProps {
  readonly icon: ReactNode;
  readonly title: string;
  readonly subtitle: string;
  readonly value: string;
  readonly detail: string;
  readonly finding?: TruthFinding | undefined;
  readonly onSelectFinding: (finding: TruthFinding) => void;
}

const findingForTypes = (
  environment: EnvironmentTruth,
  ...types: string[]
): TruthFinding | undefined =>
  environment.findings.find((finding) =>
    finding.affectedComponents.some((part) => types.includes(part.type)),
  );

const ReportRow = ({
  icon,
  title,
  subtitle,
  value,
  detail,
  finding,
  onSelectFinding,
}: ReportRowProps) => {
  const content = (
    <>
      <span className="report-row__icon">{icon}</span>
      <div className="report-row__name">
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </div>
      <div className="report-row__value">
        <strong>{value}</strong>
        <span>{detail}</span>
      </div>
      <StatusBadge status={finding?.status ?? 'VERIFIED'} />
      {finding ? (
        <span className="report-row__chevron" aria-hidden="true">
          ›
        </span>
      ) : null}
    </>
  );
  return finding ? (
    <button type="button" className="report-row" onClick={() => onSelectFinding(finding)}>
      {content}
    </button>
  ) : (
    <div className="report-row">{content}</div>
  );
};

export const ReportView = ({ report, onSelectFinding }: ReportViewProps) => {
  const counts = reportCounts(report);
  const environment = report.environments[0];
  const declaration = environment?.declaration;
  const observation = environment?.observation;
  const source = observation?.remoteSource;
  const deployment = observation?.deployment;
  const runtime = observation?.runtime;
  const database = observation?.database;
  const migrations = observation?.repositoryMigrations;
  const requiredVariables = declaration?.requiredEnvironmentVariables.length ?? 0;
  const presentVariables =
    runtime?.environmentVariables?.filter((item) => item.present).length ??
    deployment?.environmentVariables?.filter((item) => item.present).length ??
    0;
  const rows: ReportRowProps[] = environment
    ? [
        {
          icon: <GitBranch weight="duotone" />,
          title: 'Source',
          subtitle: 'Authoritative repository and branch',
          value: source?.repository ?? declaration?.source?.repository ?? 'Not observed',
          detail: `${source?.branch ?? declaration?.source?.branch ?? 'unknown'} · ${shortId(source?.remoteHeadSha)}`,
          finding: findingForTypes(environment, 'source'),
          onSelectFinding,
        },
        {
          icon: <RocketLaunch weight="duotone" />,
          title: 'Deployment',
          subtitle: 'Hosting platform and active deployment',
          value: deployment?.project ?? declaration?.deployment?.project ?? 'Not observed',
          detail: `${deployment?.state?.toUpperCase() ?? 'UNKNOWN'} · ${shortId(deployment?.commitSha)}`,
          finding: findingForTypes(environment, 'deployment'),
          onSelectFinding,
        },
        {
          icon: <TerminalWindow weight="duotone" />,
          title: 'Runtime',
          subtitle: 'Live application attestation',
          value:
            runtime?.environment ?? declaration?.runtime?.expectedEnvironment ?? 'Not observed',
          detail: runtime?.reachable
            ? `Freshness ${runtime.freshness?.state ?? 'unknown'} · ${shortId(runtime.commitSha)}`
            : 'Target unavailable',
          finding: findingForTypes(environment, 'runtime'),
          onSelectFinding,
        },
        {
          icon: <Code weight="duotone" />,
          title: 'Environment Variables',
          subtitle: 'Presence only; values never enter reports',
          value: `${presentVariables} of ${requiredVariables} present`,
          detail:
            requiredVariables === presentVariables
              ? 'All required variables established'
              : 'Incomplete presence evidence',
          finding: findingForTypes(environment, 'environment-variable'),
          onSelectFinding,
        },
        {
          icon: <ShieldCheck weight="duotone" />,
          title: 'Environment Isolation',
          subtitle: 'Declared environment boundary',
          value: declaration?.kind ?? 'Unknown',
          detail: `${environment.environment} environment`,
          finding: environment.findings.find(
            (item) => item.code.includes('ENVIRONMENT') || item.code.includes('PRODUCTION'),
          ),
          onSelectFinding,
        },
        {
          icon: <Database weight="duotone" />,
          title: 'Database',
          subtitle: 'Project identity and read-only connection',
          value: database?.provider ?? declaration?.database?.provider ?? 'Not observed',
          detail: `${shortId(database?.observedProjectRef ?? database?.projectRef)} · ${database?.connection?.state ?? 'unknown'}`,
          finding: findingForTypes(environment, 'database'),
          onSelectFinding,
        },
        {
          icon: <HardDrives weight="duotone" />,
          title: 'Migrations',
          subtitle: 'Committed catalog and applied history',
          value: `${database?.appliedMigrationIds.length ?? 0} applied / ${migrations?.migrationIds.length ?? 0} expected`,
          detail: migrations?.availability?.state ?? 'Not observed',
          finding: environment.findings.find((item) => item.code.includes('MIGRATION')),
          onSelectFinding,
        },
      ]
    : [];
  const evidenceSources = [
    source ? ['GitHub API', 'Repository, branch, commit'] : undefined,
    deployment ? ['Vercel API', 'Deployment and configuration'] : undefined,
    runtime ? ['Runtime Attestation', 'Live application evidence'] : undefined,
    database?.controlPlane ? ['Supabase Management API', 'Project and region metadata'] : undefined,
    database?.connection
      ? ['Database Inspection', 'TLS read-only connection and migrations']
      : undefined,
    migrations ? ['Git Migration Catalog', 'Committed expected migration set'] : undefined,
  ].filter((source): source is string[] => source !== undefined);

  return (
    <div className="view report-view" data-testid="report-view">
      <header className="view-heading report-heading">
        <div>
          <p className="eyebrow">Deployment verification report</p>
          <h1>{environment?.environment ?? 'Environment'} Environment</h1>
          <p>Structured evidence for {report.project}.</p>
        </div>
        <div className="latest-run">
          <span>Latest run</span>
          <strong>{new Date(report.generatedAt).toLocaleString()}</strong>
        </div>
      </header>
      <div className="report-layout">
        <main>
          <section className={`report-hero report-hero--${report.verdict.toLowerCase()}`}>
            <StatusBadge status={report.verdict} />
            <div>
              <strong>{report.verdict}</strong>
              <span>
                {counts.verified} / {counts.total} verified
              </span>
            </div>
            <div>
              <h2>
                {report.verdict === 'PASS'
                  ? 'Your deployment is what it says it is.'
                  : 'Deployment truth needs attention.'}
              </h2>
              <p>
                {report.verdict === 'PASS'
                  ? 'All enabled checks agree with the normalized evidence for this environment.'
                  : `${report.findings.length} deterministic finding${report.findings.length === 1 ? '' : 's'} require review.`}
              </p>
            </div>
          </section>
          <section className="report-rows" aria-label="Report sections">
            {rows.map((row) => (
              <ReportRow key={row.title} {...row} />
            ))}
          </section>
        </main>
        <aside className="report-aside">
          <section>
            <div className="aside-heading">
              <WarningCircle weight="duotone" />
              <h2>Findings</h2>
            </div>
            <strong className="finding-count">{report.findings.length}</strong>
            <span>
              {report.findings.length === 0
                ? 'No issues or warnings detected.'
                : 'Open an affected section to inspect evidence.'}
            </span>
          </section>
          <section>
            <h2>Evidence Sources</h2>
            <div className="source-list">
              {evidenceSources.map(([name, detail]) => (
                <div key={name}>
                  <span className="source-check" aria-hidden="true">
                    ✓
                  </span>
                  <p>
                    <strong>{name}</strong>
                    <small>{detail}</small>
                  </p>
                </div>
              ))}
            </div>
            <p className="source-footnote">
              Only sources present in this normalized report are shown.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
};
