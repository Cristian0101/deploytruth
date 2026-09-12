import type { HistoryRunSummary } from '../lib/history-types.js';
import { StatusBadge } from './status-badge.js';

interface HistoryViewProps {
  readonly available: boolean;
  readonly staticMode: boolean;
  readonly runs: readonly HistoryRunSummary[];
  readonly selectedRunId?: string | undefined;
  readonly compareA?: string | undefined;
  readonly compareB?: string | undefined;
  readonly onSelect: (runId: string) => void;
  readonly onViewSnapshot: (runId: string) => void;
  readonly onComparePrevious: (runId: string) => void;
  readonly onSelectA: (runId: string) => void;
  readonly onSelectB: (runId: string) => void;
  readonly onCompareAB: () => void;
}

const dayLabel = (timestamp: string | undefined): string => {
  if (timestamp === undefined) return 'Unknown';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  const today = new Date();
  const sameDay = (left: Date, right: Date): boolean =>
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate();
  if (sameDay(date, today)) return 'Today';
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

const timeLabel = (timestamp: string | undefined): string => {
  if (timestamp === undefined) return 'unknown';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
};

export const HistoryView = ({
  available,
  staticMode,
  runs,
  selectedRunId,
  compareA,
  compareB,
  onSelect,
  onViewSnapshot,
  onComparePrevious,
  onSelectA,
  onSelectB,
  onCompareAB,
}: HistoryViewProps) => {
  const groups = new Map<string, HistoryRunSummary[]>();
  for (const run of runs) {
    const label = dayLabel(run.timestamp);
    const group = groups.get(label) ?? [];
    group.push(run);
    groups.set(label, group);
  }

  return (
    <div className="view history-view" data-testid="history-view">
      <header className="view-heading">
        <div>
          <p className="eyebrow">History</p>
          <h1>History</h1>
          <p>When checks ran, what they verified, and whether truth changed.</p>
        </div>
      </header>

      {!available ? (
        <div className="history-empty" role="status">
          <strong>{staticMode ? 'Static report mode' : 'History unavailable'}</strong>
          <span>
            {staticMode
              ? 'History unavailable. This view only renders the saved report.'
              : 'This local session has no managed report history.'}
          </span>
        </div>
      ) : runs.length === 0 ? (
        <div className="history-empty" role="status">
          <strong>No stored runs</strong>
          <span>Completed checks for this environment will appear here.</span>
        </div>
      ) : (
        <div className="history-timeline">
          {[...groups.entries()].map(([label, group]) => (
            <section key={label} className="history-day">
              <h2>{label}</h2>
              <ol>
                {group.map((run, index) => {
                  const previous = group[index + 1] ?? runs[runs.indexOf(run) + 1];
                  const selected = run.runId === selectedRunId;
                  return (
                    <li key={run.runId}>
                      <button
                        type="button"
                        className={`history-row ${selected ? 'is-selected' : ''} ${run.status !== 'ok' ? 'is-invalid' : ''}`}
                        onClick={() => onSelect(run.runId)}
                      >
                        <time dateTime={run.timestamp}>{timeLabel(run.timestamp)}</time>
                        {run.status === 'ok' && run.verdict ? (
                          <StatusBadge status={run.verdict} />
                        ) : (
                          <span className="history-invalid">
                            {run.status === 'unsupported'
                              ? 'UNSUPPORTED REPORT VERSION'
                              : 'CORRUPT'}
                          </span>
                        )}
                        <span className="history-row__counts">
                          {run.status === 'ok' ? (
                            <>
                              <strong>{run.verifiedCount ?? 0}</strong> verified
                              {(run.warningCount ?? 0) > 0
                                ? ` · ${run.warningCount} warning${run.warningCount === 1 ? '' : 's'}`
                                : ''}
                              {(run.failureCount ?? 0) > 0
                                ? ` · ${run.failureCount} failure${run.failureCount === 1 ? '' : 's'}`
                                : ''}
                            </>
                          ) : (
                            'Not interpreted as truth'
                          )}
                        </span>
                        {run.sourceSha ? (
                          <code>
                            {run.sourceSha.length > 12
                              ? `${run.sourceSha.slice(0, 7)}…`
                              : run.sourceSha}
                          </code>
                        ) : null}
                      </button>
                      {selected && run.status === 'ok' ? (
                        <div className="history-row__actions">
                          <button
                            type="button"
                            className="button"
                            onClick={() => onViewSnapshot(run.runId)}
                          >
                            View snapshot
                          </button>
                          <button
                            type="button"
                            className="button"
                            onClick={() => onComparePrevious(run.runId)}
                            disabled={previous?.status !== 'ok'}
                          >
                            Compare to previous
                          </button>
                          <button
                            type="button"
                            className="button button--secondary"
                            onClick={() => onSelectA(run.runId)}
                          >
                            {compareA === run.runId ? 'A selected' : 'Select as A'}
                          </button>
                          <button
                            type="button"
                            className="button button--secondary"
                            onClick={() => onSelectB(run.runId)}
                          >
                            {compareB === run.runId ? 'B selected' : 'Select as B'}
                          </button>
                          {compareA && compareB ? (
                            <button type="button" className="button" onClick={onCompareAB}>
                              Compare A → B
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  );
};
