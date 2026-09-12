import { useCallback, useEffect, useState } from 'react';
import type { RunComparison, TruthFinding, TruthReport } from '@deploytruth/core';

import { AppShell } from './components/app-shell.js';
import { ComparisonView } from './components/comparison-view.js';
import { HistoryView } from './components/history-view.js';
import { Inspector } from './components/inspector.js';
import { ReportView } from './components/report-view.js';
import { TruthMap } from './components/truth-map.js';
import type {
  HistoryListResponse,
  HistoryRunSummary,
  ReportMode,
  SessionMetadata,
  View,
} from './lib/history-types.js';
import { reportCounts } from './lib/report-presentation.js';

const getJson = async <T,>(url: string, init?: Parameters<typeof fetch>[1]): Promise<T> => {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? 'The local report request failed.');
  return value;
};

export const App = () => {
  const [latestReport, setLatestReport] = useState<TruthReport>();
  const [report, setReport] = useState<TruthReport>();
  const [session, setSession] = useState<SessionMetadata>();
  const [view, setView] = useState<View>('map');
  const [mode, setMode] = useState<ReportMode>('latest');
  const [selectedFinding, setSelectedFinding] = useState<TruthFinding>();
  const [loading, setLoading] = useState(true);
  const [rerunning, setRerunning] = useState(false);
  const [error, setError] = useState<string>();
  const [rerunMessage, setRerunMessage] = useState<string>();
  const [historyRuns, setHistoryRuns] = useState<readonly HistoryRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [compareA, setCompareA] = useState<string>();
  const [compareB, setCompareB] = useState<string>();
  const [comparison, setComparison] = useState<RunComparison>();

  const historyAvailable = Boolean(session?.historyAvailable) && !session?.static;
  const query = window.location.search;

  const loadHistory = useCallback(async () => {
    if (!historyAvailable) {
      setHistoryRuns([]);
      return;
    }
    try {
      const payload = await getJson<HistoryListResponse>(`/api/history${query}`);
      setHistoryRuns(payload.runs);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'History unavailable.');
    }
  }, [historyAvailable, query]);

  useEffect(() => {
    let active = true;
    Promise.all([
      getJson<TruthReport>(`/api/report${query}`),
      getJson<SessionMetadata>('/api/session'),
    ])
      .then(([nextReport, nextSession]) => {
        if (!active) return;
        setLatestReport(nextReport);
        setReport(nextReport);
        setSession(nextSession);
        setMode(nextSession.static ? 'static' : 'latest');
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Report unavailable.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [query]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const returnToLatest = useCallback(() => {
    if (!latestReport) return;
    setReport(latestReport);
    setMode(session?.static ? 'static' : 'latest');
    setSelectedFinding(undefined);
    setView('map');
    setComparison(undefined);
  }, [latestReport, session?.static]);

  const viewSnapshot = useCallback(
    async (runId: string) => {
      try {
        const snapshot = await getJson<TruthReport>(
          `/api/history/${encodeURIComponent(runId)}${query}`,
        );
        setReport(snapshot);
        setSelectedRunId(runId);
        setMode('historical');
        setSelectedFinding(undefined);
        setView('map');
        setComparison(undefined);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Historical run unavailable.');
      }
    },
    [query],
  );

  const loadComparison = useCallback(
    async (from: string | undefined, to: string) => {
      try {
        const params = new URLSearchParams(query);
        if (from) params.set('from', from);
        params.set('to', to);
        const next = await getJson<RunComparison>(`/api/compare?${params.toString()}`);
        setComparison(next);
        setView('comparison');
        setSelectedFinding(undefined);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Comparison unavailable.');
      }
    },
    [query],
  );

  const rerun = useCallback(async () => {
    if (!session?.rerunAvailable || rerunning || mode !== 'latest') return;
    setRerunning(true);
    setError(undefined);
    setRerunMessage(undefined);
    try {
      const nextReport = await getJson<TruthReport>('/api/rerun', {
        method: 'POST',
        headers: { 'X-DeployTruth-Session': session.token },
      });
      setLatestReport(nextReport);
      setReport(nextReport);
      setSelectedFinding(undefined);
      setRerunMessage(
        `Checks completed at ${new Date(nextReport.generatedAt).toLocaleTimeString()}.`,
      );
      await loadHistory();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The report could not be refreshed.');
    } finally {
      setRerunning(false);
    }
  }, [loadHistory, mode, rerunning, session]);

  if (loading) {
    return (
      <main className="system-state" aria-live="polite">
        <span className="loading-mark" aria-hidden="true" />
        <h1>Reading deployment truth</h1>
        <p>The local report is loading.</p>
      </main>
    );
  }

  if (!report) {
    return (
      <main className="system-state system-state--error" role="alert">
        <h1>Report unavailable</h1>
        <p>{error ?? 'DeployTruth did not return a normalized report.'}</p>
      </main>
    );
  }

  const environment = report.environments[0]?.environment ?? 'unknown';
  const counts = reportCounts(report);
  const inspectorOpen = Boolean(selectedFinding) && (view === 'map' || view === 'report');
  const rerunEnabled = Boolean(session?.rerunAvailable) && mode === 'latest' && !rerunning;

  return (
    <AppShell
      report={report}
      environment={environment}
      activeView={view}
      onViewChange={(nextView) => {
        setView(nextView);
        setSelectedFinding(undefined);
      }}
    >
      <div className={`workspace ${inspectorOpen ? 'workspace--inspector-open' : ''}`}>
        <section className="workspace__main">
          {error ? (
            <div className="inline-notice inline-notice--error" role="alert">
              <strong>Error</strong>
              <span>{error}</span>
              <button type="button" onClick={() => setError(undefined)} aria-label="Dismiss error">
                Dismiss
              </button>
            </div>
          ) : null}
          {rerunMessage ? (
            <div className="inline-notice" role="status">
              <strong>Report updated</strong>
              <span>{rerunMessage}</span>
              <button
                type="button"
                onClick={() => setRerunMessage(undefined)}
                aria-label="Dismiss update"
              >
                Dismiss
              </button>
            </div>
          ) : null}
          {mode === 'historical' ? (
            <div className="mode-banner" role="status" data-testid="historical-banner">
              <strong>Historical run</strong>
              <span>
                {new Date(report.generatedAt).toLocaleString()} · Read-only snapshot. Providers are
                not contacted.
              </span>
            </div>
          ) : null}
          {mode === 'static' ? (
            <div className="mode-banner" role="status">
              <strong>Static report mode</strong>
              <span>History is unavailable in static report mode.</span>
            </div>
          ) : null}

          {view === 'map' ? (
            <TruthMap
              report={report}
              selectedFinding={selectedFinding}
              onSelectFinding={setSelectedFinding}
            />
          ) : null}
          {view === 'report' ? (
            <ReportView report={report} onSelectFinding={setSelectedFinding} />
          ) : null}
          {view === 'history' ? (
            <HistoryView
              available={historyAvailable}
              staticMode={Boolean(session?.static)}
              runs={historyRuns}
              selectedRunId={selectedRunId}
              compareA={compareA}
              compareB={compareB}
              onSelect={setSelectedRunId}
              onViewSnapshot={(runId) => void viewSnapshot(runId)}
              onComparePrevious={(runId) => void loadComparison(undefined, runId)}
              onSelectA={setCompareA}
              onSelectB={setCompareB}
              onCompareAB={() => {
                if (compareA && compareB) void loadComparison(compareA, compareB);
              }}
            />
          ) : null}
          {view === 'comparison' && comparison ? (
            <ComparisonView
              comparison={comparison}
              onBack={() => setView('history')}
              onViewFrom={() => void viewSnapshot(comparison.from.runId)}
              onViewTo={() => void viewSnapshot(comparison.to.runId)}
            />
          ) : null}

          {view === 'map' || view === 'report' ? (
            <footer className="run-summary" aria-label="Run summary">
              <div className="run-summary__metric run-summary__metric--verified">
                <span aria-hidden="true">✓</span>
                <strong>{counts.verified}</strong> verified
              </div>
              <div className="run-summary__metric run-summary__metric--warning">
                <span aria-hidden="true">△</span>
                <strong>{counts.warnings}</strong> warning{counts.warnings === 1 ? '' : 's'}
              </div>
              <div className="run-summary__metric run-summary__metric--failed">
                <span aria-hidden="true">×</span>
                <strong>{counts.failures}</strong> failure{counts.failures === 1 ? '' : 's'}
              </div>
              <div className="run-summary__actions">
                <span>
                  {mode === 'static'
                    ? 'Saved report'
                    : mode === 'historical'
                      ? `Historical run ${new Date(report.generatedAt).toLocaleString()}`
                      : `Checked ${new Date(report.generatedAt).toLocaleString()}`}
                </span>
                {mode === 'historical' ? (
                  <button
                    className="button button--secondary"
                    type="button"
                    onClick={returnToLatest}
                  >
                    Return to latest
                  </button>
                ) : (
                  <button
                    className="button button--secondary"
                    type="button"
                    onClick={rerun}
                    disabled={!rerunEnabled}
                  >
                    <span className={rerunning ? 'spin' : ''} aria-hidden="true">
                      ↻
                    </span>
                    {rerunning
                      ? 'Running checks…'
                      : session?.static
                        ? 'Static report'
                        : 'Re-run checks'}
                  </button>
                )}
              </div>
            </footer>
          ) : null}
        </section>
        <Inspector
          finding={selectedFinding}
          report={report}
          onClose={() => setSelectedFinding(undefined)}
        />
      </div>
    </AppShell>
  );
};
