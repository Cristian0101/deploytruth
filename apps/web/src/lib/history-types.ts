import type { Verdict } from '@deploytruth/core';

export type View = 'map' | 'report' | 'history' | 'comparison';
export type ReportMode = 'latest' | 'historical' | 'static';

export interface SessionMetadata {
  readonly token: string;
  readonly static: boolean;
  readonly rerunAvailable: boolean;
  readonly historyAvailable?: boolean;
}

export interface HistoryRunSummary {
  readonly runId: string;
  readonly timestamp?: string;
  readonly project?: string;
  readonly environment?: string;
  readonly verdict?: Verdict;
  readonly reportVersion?: string;
  readonly findingCount?: number;
  readonly warningCount?: number;
  readonly failureCount?: number;
  readonly verifiedCount?: number;
  readonly sourceSha?: string;
  readonly status: 'ok' | 'corrupt' | 'unsupported';
  readonly schemaVersion?: string;
}

export interface HistoryListResponse {
  readonly project: string;
  readonly environment: string;
  readonly runs: readonly HistoryRunSummary[];
}
