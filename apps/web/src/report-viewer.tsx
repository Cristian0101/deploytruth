import type { TruthReport } from '@deploytruth/core';

export interface ReportViewerProps {
  readonly report: TruthReport;
}

const verdictClass = (verdict: TruthReport['verdict']): string =>
  `verdict verdict--${verdict.toLowerCase()}`;

/**
 * A deliberately passive report renderer. Rule evaluation and verdict aggregation live in core,
 * so this component only renders already-safe report data.
 */
export const ReportViewer = ({ report }: ReportViewerProps) => (
  <main className="report-viewer">
    <header className="report-header">
      <div>
        <h1>Deployment Health</h1>
        <p>
          {report.project} · generated {new Date(report.generatedAt).toLocaleString()}
        </p>
      </div>
      <span className={verdictClass(report.verdict)}>{report.verdict}</span>
    </header>

    <section aria-labelledby="topology-heading">
      <h2 id="topology-heading">Topology</h2>
      <div className="topology-list">
        {report.topology.nodes.map((node) => (
          <article className={`topology-node topology-node--${node.health}`} key={node.id}>
            <span>{node.type}</span>
            <strong>{node.label}</strong>
            <small>
              {node.provider} · {node.environment} · {node.health}
            </small>
          </article>
        ))}
      </div>
    </section>

    <section aria-labelledby="findings-heading">
      <h2 id="findings-heading">Findings</h2>
      {report.findings.length === 0 ? (
        <p className="empty-state">No findings were returned by the truth engine.</p>
      ) : (
        <ol className="findings-list">
          {report.findings.map((finding) => (
            <li key={`${finding.code}-${finding.affectedComponents[0]?.environment ?? 'project'}`}>
              <span className={`severity severity--${finding.severity.toLowerCase()}`}>
                {finding.severity}
              </span>
              <div>
                <strong>{finding.title}</strong>
                <p>{finding.description}</p>
                <p className="remediation">{finding.remediation}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  </main>
);
