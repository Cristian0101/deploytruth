import type { FindingChange, RunComparison } from '@deploytruth/core';

import { formatSafeValue } from '../lib/report-presentation.js';
import { StatusBadge } from './status-badge.js';

interface ComparisonViewProps {
  readonly comparison: RunComparison;
  readonly onViewTo: () => void;
  readonly onViewFrom: () => void;
  readonly onBack: () => void;
}

const lifecycleClass = (lifecycle: FindingChange['lifecycle']): string =>
  `comparison-finding comparison-finding--${lifecycle.toLowerCase()}`;

export const ComparisonView = ({
  comparison,
  onViewTo,
  onViewFrom,
  onBack,
}: ComparisonViewProps) => {
  const { verdictChange, findingChanges, observationChanges, topologyChanges, summary } =
    comparison;
  const headline = `${verdictChange.from} → ${verdictChange.to}`;
  const kindLabel =
    verdictChange.kind === 'regression'
      ? 'REGRESSION'
      : verdictChange.kind === 'recovered'
        ? 'RECOVERED'
        : 'UNCHANGED VERDICT';

  return (
    <div className="view comparison-view" data-testid="comparison-view">
      <header className="view-heading">
        <div>
          <p className="eyebrow">Comparison</p>
          <h1>{headline}</h1>
          <p>
            {comparison.from.environment} · {new Date(comparison.from.timestamp).toLocaleString()} →{' '}
            {new Date(comparison.to.timestamp).toLocaleString()}
          </p>
        </div>
        <div className="comparison-heading-actions">
          <StatusBadge status={verdictChange.to} />
          <button type="button" className="button button--secondary" onClick={onBack}>
            Back to history
          </button>
        </div>
      </header>

      <div className="comparison-kicker">
        <span className={`comparison-kind comparison-kind--${verdictChange.kind}`}>
          {kindLabel}
        </span>
        <span>
          From {new Date(comparison.from.timestamp).toLocaleString()} →{' '}
          {new Date(comparison.to.timestamp).toLocaleString()}
        </span>
      </div>

      <section className="comparison-metrics" aria-label="Finding lifecycle">
        <div>
          <strong>{summary.newFindings}</strong>
          <span>New findings</span>
        </div>
        <div>
          <strong>{summary.resolvedFindings}</strong>
          <span>Resolved findings</span>
        </div>
        <div>
          <strong>{summary.persistingFindings}</strong>
          <span>Persisting</span>
        </div>
        <div>
          <strong>{summary.changedFindings}</strong>
          <span>Changed</span>
        </div>
      </section>

      {observationChanges.length > 0 ? (
        <section className="comparison-section">
          <h2>Identity changes</h2>
          <ul className="comparison-identities">
            {observationChanges.map((change) => (
              <li key={`${change.kind}:${change.label}`}>
                <strong>{change.label}</strong>
                <span>
                  {change.from} → {change.to}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {topologyChanges.edges.length > 0 ? (
        <section className="comparison-section">
          <h2>Relationship changes</h2>
          <ul className="comparison-relationships">
            {topologyChanges.edges.map((change) => (
              <li key={change.id}>
                <strong>{change.label}</strong>
                <span>
                  {(change.fromHealth ?? 'none').toUpperCase()} →{' '}
                  {(change.toHealth ?? 'none').toUpperCase()}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {summary.unchangedRelationships.length > 0 ? (
        <section className="comparison-section comparison-section--muted">
          <h2>Unchanged</h2>
          <ul>
            {summary.unchangedRelationships.map((relationship) => (
              <li key={relationship}>{relationship}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {findingChanges.map((change) => (
        <article
          key={change.identity}
          className={lifecycleClass(change.lifecycle)}
          data-testid={`finding-${change.lifecycle.toLowerCase()}`}
        >
          <span className="comparison-lifecycle">{change.lifecycle}</span>
          <h3>{change.code}</h3>
          <p>{change.title}</p>
          {(change.toSeverity ?? change.fromSeverity) ? (
            <span className="severity-pill">{change.toSeverity ?? change.fromSeverity}</span>
          ) : null}
          {change.relationship ? (
            <p className="comparison-relationship">{change.relationship}</p>
          ) : null}
          {change.lifecycle !== 'RESOLVED' &&
          (change.toExpected !== undefined || change.toObserved !== undefined) ? (
            <div className="expected-observed">
              <div className="evidence-value">
                <span>Expected</span>
                <pre>{formatSafeValue(change.toExpected ?? change.fromExpected)}</pre>
              </div>
              <div className="evidence-value">
                <span>Observed</span>
                <pre>{formatSafeValue(change.toObserved ?? change.fromObserved)}</pre>
              </div>
            </div>
          ) : null}
        </article>
      ))}

      <footer className="comparison-footer">
        <button type="button" className="button button--secondary" onClick={onViewFrom}>
          View previous snapshot
        </button>
        <button type="button" className="button" onClick={onViewTo}>
          View current snapshot
        </button>
      </footer>
    </div>
  );
};
