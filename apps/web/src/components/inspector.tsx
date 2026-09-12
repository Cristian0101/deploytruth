import { useEffect } from 'react';
import type { SafeValue, TruthFinding, TruthReport } from '@deploytruth/core';
import { ArrowSquareOut, CheckCircle, Copy, X } from '@phosphor-icons/react';

import { evidenceLabel, formatSafeValue } from '../lib/report-presentation.js';
import { StatusBadge } from './status-badge.js';

interface InspectorProps {
  readonly finding?: TruthFinding | undefined;
  readonly report: TruthReport;
  readonly onClose: () => void;
}

const EvidenceValue = ({
  label,
  value,
}: {
  readonly label: string;
  readonly value: SafeValue | undefined;
}) => {
  const formatted = formatSafeValue(value);
  const copyable = typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{6,}$/.test(value);
  return (
    <div className="evidence-value">
      <span>{label}</span>
      <pre>{formatted}</pre>
      {copyable ? (
        <button
          type="button"
          onClick={() => void navigator.clipboard.writeText(value)}
          aria-label={`Copy ${label}`}
        >
          <Copy />
        </button>
      ) : null}
    </div>
  );
};

export const Inspector = ({ finding, report, onClose }: InspectorProps) => {
  useEffect(() => {
    if (!finding) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [finding, onClose]);
  if (!finding) return null;
  const affected = finding.affectedComponents
    .map((part) => `${part.environment} ${part.type}`)
    .join(' → ');
  return (
    <aside className="inspector" aria-label="Finding inspector" data-testid="finding-inspector">
      <header className="inspector__header">
        <span>Inspector</span>
        <button type="button" onClick={onClose} aria-label="Close inspector">
          <X />
        </button>
      </header>
      <div className="inspector__content">
        <div className="inspector__title">
          <StatusBadge status={finding.status} />
          <h2>{finding.code}</h2>
          <p>{finding.title}</p>
        </div>
        <div className="inspector__meta">
          <StatusBadge status={finding.status} />
          <span className="severity-pill">{finding.severity}</span>
          <code>{affected}</code>
        </div>
        <section>
          <h3>What happened?</h3>
          <p>{finding.description}</p>
        </section>
        <div className="expected-observed">
          <EvidenceValue label="Expected" value={finding.expected} />
          <EvidenceValue label="Observed" value={finding.observed} />
        </div>
        {Object.keys(finding.evidence).length > 0 ? (
          <section>
            <h3>Evidence</h3>
            <div className="evidence-list">
              {Object.entries(finding.evidence).map(([key, value]) => (
                <div key={key}>
                  <CheckCircle weight="fill" />
                  <span>{evidenceLabel(key)}</span>
                  <code>{formatSafeValue(value)}</code>
                </div>
              ))}
            </div>
          </section>
        ) : null}
        <section className="next-steps">
          <h3>Next steps</h3>
          <p>{finding.remediation}</p>
        </section>
        <p className="inspector__provenance">
          <ArrowSquareOut /> Rendered from normalized report schema {report.schemaVersion}. No
          provider requests originate here.
        </p>
      </div>
    </aside>
  );
};
