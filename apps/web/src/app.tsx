import { useCallback, useEffect, useState } from 'react';
import type { TruthFinding, TruthReport } from '@deploytruth/core';

import { AppShell } from './components/app-shell.js';
import { Inspector } from './components/inspector.js';
import { ReportView } from './components/report-view.js';
import { TruthMap } from './components/truth-map.js';
import { reportCounts } from './lib/report-presentation.js';

type View = 'map' | 'report';

interface SessionMetadata {
  readonly token: string;
  readonly static: boolean;
  readonly rerunAvailable: boolean;
}

const getJson = async <T,>(url: string, init?: Parameters<typeof fetch>[1]): Promise<T> => {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? 'The local report request failed.');
  return value;
};

export const App = () => {
  const [report, setReport] = useState<TruthReport>();
  const [session, setSession] = useState<SessionMetadata>();
  const [view, setView] = useState<View>('map');
  const [selectedFinding, setSelectedFinding] = useState<TruthFinding>();
  const [loading, setLoading] = useState(true);
  const [rerunning, setRerunning] = useState(false);
  const [error, setError] = useState<string>();
  const [rerunMessage, setRerunMessage] = useState<string>();

  useEffect(() => {
    let active = true;
    Promise.all([
      getJson<TruthReport>(`/api/report${window.location.search}`),
      getJson<SessionMetadata>('/api/session'),
    ])
      .then(([nextReport, nextSession]) => {
        if (!active) return;
        setReport(nextReport);
        setSession(nextSession);
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
  }, []);

  const rerun = useCallback(async () => {
    if (!session?.rerunAvailable || rerunning) return;
    setRerunning(true);
    setError(undefined);
    setRerunMessage(undefined);
    try {
      const nextReport = await getJson<TruthReport>('/api/rerun', {
        method: 'POST',
        headers: { 'X-DeployTruth-Session': session.token },
      });
      setReport(nextReport);
      setSelectedFinding(undefined);
      setRerunMessage(
        `Checks completed at ${new Date(nextReport.generatedAt).toLocaleTimeString()}.`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The report could not be refreshed.');
    } finally {
      setRerunning(false);
    }
  }, [rerunning, session]);

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
      <div className={`workspace ${selectedFinding ? 'workspace--inspector-open' : ''}`}>
        <section className="workspace__main">
          {error ? (
            <div className="inline-notice inline-notice--error" role="alert">
              <strong>Re-run failed</strong>
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

          {view === 'map' ? (
            <TruthMap
              report={report}
              selectedFinding={selectedFinding}
              onSelectFinding={setSelectedFinding}
            />
          ) : (
            <ReportView report={report} onSelectFinding={setSelectedFinding} />
          )}

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
                {session?.static
                  ? 'Saved report'
                  : `Checked ${new Date(report.generatedAt).toLocaleString()}`}
              </span>
              <button
                className="button button--secondary"
                type="button"
                onClick={rerun}
                disabled={!session?.rerunAvailable || rerunning}
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
            </div>
          </footer>
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
