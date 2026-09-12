import type { ReactNode } from 'react';
import type { TruthReport } from '@deploytruth/core';
import {
  ClockCounterClockwise,
  FileText,
  GitBranch,
  Graph,
  Info,
  MapTrifold,
} from '@phosphor-icons/react';

import type { View } from '../lib/history-types.js';
import { StatusBadge } from './status-badge.js';

interface AppShellProps {
  readonly report: TruthReport;
  readonly environment: string;
  readonly activeView: View;
  readonly onViewChange: (view: View) => void;
  readonly children: ReactNode;
}

export const AppShell = ({
  report,
  environment,
  activeView,
  onViewChange,
  children,
}: AppShellProps) => (
  <div className="app-shell">
    <aside className="sidebar">
      <div className="brand">
        <span className="brand__mark">
          <Graph weight="fill" />
        </span>
        <span>DeployTruth</span>
      </div>
      <nav className="primary-nav" aria-label="Report views">
        <button
          type="button"
          className={activeView === 'map' ? 'is-active' : ''}
          aria-current={activeView === 'map' ? 'page' : undefined}
          onClick={() => onViewChange('map')}
        >
          <MapTrifold weight="duotone" />
          Truth Map
        </button>
        <button
          type="button"
          className={activeView === 'report' ? 'is-active' : ''}
          aria-current={activeView === 'report' ? 'page' : undefined}
          onClick={() => onViewChange('report')}
        >
          <FileText weight="duotone" />
          Report
        </button>
        <button
          type="button"
          className={activeView === 'history' || activeView === 'comparison' ? 'is-active' : ''}
          aria-current={
            activeView === 'history' || activeView === 'comparison' ? 'page' : undefined
          }
          onClick={() => onViewChange('history')}
        >
          <ClockCounterClockwise weight="duotone" />
          History
        </button>
      </nav>
      <div className="sidebar__principle">
        <Info weight="duotone" />
        <div>
          <strong>Local & read-only</strong>
          <span>Evidence explains every verdict.</span>
        </div>
      </div>
    </aside>
    <div className="app-shell__content">
      <header className="topbar">
        <div className="project-context">
          <GitBranch weight="duotone" />
          <strong>{report.project}</strong>
          <span>/</span>
          <span>{environment}</span>
        </div>
        <div className="topbar__verdict">
          <StatusBadge status={report.verdict} />
          <span>
            {report.verdict === 'PASS'
              ? 'All declared truth verified'
              : `${report.findings.length} finding${report.findings.length === 1 ? '' : 's'}`}
          </span>
        </div>
      </header>
      {children}
    </div>
  </div>
);
