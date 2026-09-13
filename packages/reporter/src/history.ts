import { access, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { isRunId, type TruthReport, type Verdict } from '@deploytruth/core';

import { writeFileAtomic } from './atomic-write.js';
import { assertInside, filesystemKey, HistoryPathError } from './paths.js';
import { parseStoredReport, serializeTruthReport } from './serializer.js';
import { reportFindingCounts } from './summary.js';

export class HistoryError extends Error {
  readonly code:
    'not_found' | 'unsupported' | 'corrupt' | 'invalid_id' | 'invalid_path' | 'invalid_report';

  constructor(code: HistoryError['code'], message: string) {
    super(message);
    this.name = 'HistoryError';
    this.code = code;
  }
}

export interface StoredReportPaths {
  readonly latest: string;
  readonly archived: string;
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

export interface ReportHistoryStore {
  readonly rootDirectory: string;
  readonly reportsDirectory: string;
  save: (report: TruthReport) => Promise<StoredReportPaths>;
  list: (project: string, environment: string) => Promise<readonly HistoryRunSummary[]>;
  get: (runId: string) => Promise<TruthReport>;
  latest: (project: string, environment: string) => Promise<TruthReport | undefined>;
  previous: (runId: string) => Promise<TruthReport | undefined>;
}

const environmentId = (report: TruthReport): string => {
  const environment = report.environments[0]?.environment;
  if (environment === undefined) {
    throw new HistoryError('invalid_report', 'A stored report must include an environment.');
  }
  return environment;
};

/** True when a stored report belongs to the requested project/environment namespace. */
export const reportMatchesNamespace = (
  report: TruthReport,
  project: string,
  environment: string,
): boolean => report.project === project && environmentId(report) === environment;

const sourceSha = (report: TruthReport): string | undefined => {
  const observation = report.environments[0]?.observation;
  return observation?.remoteSource?.remoteHeadSha ?? observation?.source?.headSha;
};

const summarize = (report: TruthReport): HistoryRunSummary => {
  const counts = reportFindingCounts(report);
  const sha = sourceSha(report);
  return {
    runId: report.runId,
    timestamp: report.generatedAt,
    project: report.project,
    environment: environmentId(report),
    verdict: report.verdict,
    reportVersion: report.schemaVersion,
    findingCount: counts.findings,
    warningCount: counts.warnings,
    failureCount: counts.failures,
    verifiedCount: counts.verified,
    ...(sha === undefined ? {} : { sourceSha: sha }),
    status: 'ok',
    schemaVersion: report.schemaVersion,
  };
};

const isHistoryJson = (filename: string): boolean =>
  filename.endsWith('.json') && filename !== 'latest.json' && !filename.endsWith('.tmp');

const isTempArtifact = (filename: string): boolean => filename.endsWith('.tmp');

const isEnoent = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

const compareSummaries = (left: HistoryRunSummary, right: HistoryRunSummary): number => {
  const leftTime = left.timestamp ?? '';
  const rightTime = right.timestamp ?? '';
  if (leftTime !== rightTime) {
    return rightTime.localeCompare(leftTime);
  }
  return left.runId.localeCompare(right.runId);
};

export const createReportHistoryStore = (rootDirectory: string): ReportHistoryStore => {
  const reportsDirectory = join(rootDirectory, '.deploytruth', 'reports');

  const namespaceDirectory = (project: string, environment: string): string => {
    try {
      const directory = join(reportsDirectory, filesystemKey(project), filesystemKey(environment));
      return assertInside(reportsDirectory, directory);
    } catch (error) {
      if (error instanceof HistoryPathError) {
        throw new HistoryError('invalid_path', error.message);
      }
      throw error;
    }
  };

  const listSafeDirectories = async (directory: string): Promise<readonly string[]> => {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => {
          try {
            filesystemKey(name);
            return true;
          } catch {
            return false;
          }
        })
        .sort((left, right) => left.localeCompare(right));
    } catch (error) {
      if (isEnoent(error)) {
        return [];
      }
      throw error;
    }
  };

  const locate = async (runId: string): Promise<string> => {
    if (!isRunId(runId)) {
      throw new HistoryError('invalid_id', 'Run IDs must be 26-character Crockford ULIDs.');
    }
    const projects = await listSafeDirectories(reportsDirectory);
    for (const project of projects) {
      const environments = await listSafeDirectories(join(reportsDirectory, project));
      for (const environment of environments) {
        const directory = assertInside(
          reportsDirectory,
          join(reportsDirectory, project, environment),
        );
        const direct = assertInside(directory, join(directory, `${runId}.json`));
        try {
          await access(direct);
          return direct;
        } catch (error) {
          if (!isEnoent(error)) {
            throw error;
          }
        }
        let filenames: readonly string[] = [];
        try {
          filenames = await readdir(directory);
        } catch (error) {
          if (isEnoent(error)) {
            continue;
          }
          throw error;
        }
        for (const filename of filenames) {
          if (!isHistoryJson(filename)) continue;
          const filePath = assertInside(directory, join(directory, filename));
          const parsed = parseStoredReport(await readFile(filePath, 'utf8'));
          if (parsed.status === 'ok' && parsed.report.runId === runId) {
            return filePath;
          }
        }
      }
    }
    throw new HistoryError('not_found', 'Unknown run ID.');
  };

  const readLocated = async (filePath: string): Promise<TruthReport> => {
    const parsed = parseStoredReport(await readFile(filePath, 'utf8'));
    if (parsed.status === 'ok') {
      return parsed.report;
    }
    if (parsed.status === 'unsupported') {
      throw new HistoryError('unsupported', 'UNSUPPORTED REPORT VERSION');
    }
    throw new HistoryError('corrupt', 'Stored report is not valid JSON truth.');
  };

  const save = async (report: TruthReport): Promise<StoredReportPaths> => {
    const serialized = serializeTruthReport(report);
    const environment = environmentId(report);
    const directory = namespaceDirectory(report.project, environment);
    const archived = join(directory, `${report.runId}.json`);
    const latest = join(directory, 'latest.json');
    const pointer = join(reportsDirectory, 'latest.json');
    await writeFileAtomic(archived, serialized);
    await writeFileAtomic(latest, serialized);
    await writeFileAtomic(pointer, serialized);
    return { latest, archived };
  };

  const list = async (
    project: string,
    environment: string,
  ): Promise<readonly HistoryRunSummary[]> => {
    const directory = namespaceDirectory(project, environment);
    let entries: readonly string[] = [];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if (isEnoent(error)) {
        return [];
      }
      throw error;
    }

    const summaries: HistoryRunSummary[] = [];
    for (const filename of entries) {
      if (isTempArtifact(filename)) {
        await unlink(join(directory, filename)).catch(() => undefined);
        continue;
      }
      if (!isHistoryJson(filename)) {
        continue;
      }
      const filePath = assertInside(directory, join(directory, filename));
      const stem = filename.replace(/\.json$/, '');
      try {
        const parsed = parseStoredReport(await readFile(filePath, 'utf8'));
        if (parsed.status === 'ok') {
          summaries.push(summarize(parsed.report));
          continue;
        }
        if (parsed.status === 'unsupported') {
          summaries.push({
            runId: isRunId(stem) ? stem : parsed.schemaVersion,
            status: 'unsupported',
            schemaVersion: parsed.schemaVersion,
          });
          continue;
        }
        summaries.push({
          runId: isRunId(stem) ? stem : stem.slice(0, 26) || 'unknown',
          status: 'corrupt',
        });
      } catch {
        summaries.push({
          runId: isRunId(stem) ? stem : 'unknown',
          status: 'corrupt',
        });
      }
    }

    return summaries.sort(compareSummaries);
  };

  const get = async (runId: string): Promise<TruthReport> => readLocated(await locate(runId));

  const latest = async (project: string, environment: string): Promise<TruthReport | undefined> => {
    const usable = (await list(project, environment)).filter((entry) => entry.status === 'ok');
    const first = usable[0];
    return first === undefined ? undefined : get(first.runId);
  };

  const previous = async (runId: string): Promise<TruthReport | undefined> => {
    const current = await get(runId);
    const usable = (await list(current.project, environmentId(current))).filter(
      (entry) => entry.status === 'ok',
    );
    const index = usable.findIndex((entry) => entry.runId === runId);
    const prior = index >= 0 ? usable[index + 1] : undefined;
    return prior === undefined ? undefined : get(prior.runId);
  };

  return {
    rootDirectory,
    reportsDirectory,
    save,
    list,
    get,
    latest,
    previous,
  };
};
