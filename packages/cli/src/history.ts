import type { HistoryRunSummary } from '@deploytruth/reporter';

const pad = (value: string, width: number): string =>
  value.length >= width ? value : `${value}${' '.repeat(width - value.length)}`;

const formatTimestamp = (value: string | undefined): string => {
  if (value === undefined) return 'unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
};

export const formatHistoryList = (
  environment: string,
  runs: readonly HistoryRunSummary[],
): string => {
  const lines = ['DeployTruth History', '', environment, ''];
  if (runs.length === 0) {
    lines.push('No stored runs.');
    return lines.join('\n');
  }

  lines.push(`${pad('RUN ID', 28)} ${pad('TIME', 18)} ${pad('VERDICT', 9)} FINDINGS`);
  for (const run of runs) {
    if (run.status === 'unsupported') {
      lines.push(
        `${pad(run.runId, 28)} ${pad(formatTimestamp(run.timestamp), 18)} ${pad('UNSUPPORTED REPORT VERSION', 32)}`,
      );
      continue;
    }
    if (run.status === 'corrupt') {
      lines.push(`${pad(run.runId, 28)} ${pad(formatTimestamp(run.timestamp), 18)} CORRUPT`);
      continue;
    }
    lines.push(
      `${pad(run.runId, 28)} ${pad(formatTimestamp(run.timestamp), 18)} ${pad(run.verdict ?? 'unknown', 9)} ${run.findingCount ?? 0}`,
    );
  }
  return lines.join('\n');
};
