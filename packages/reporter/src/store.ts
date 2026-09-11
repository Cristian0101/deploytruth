import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { TruthReport } from '@deploytruth/core';

import { serializeTruthReport } from './serializer.js';

const filenameFor = (report: TruthReport): string =>
  `${report.generatedAt.replace(/[:.]/g, '-').replace(/\+/g, '_')}.json`;

export interface StoredReportPaths {
  readonly latest: string;
  readonly archived: string;
}

/** Stores only sanitized report JSON under a project-local .deploytruth/reports directory. */
export const writeLocalReport = async (
  rootDirectory: string,
  report: TruthReport,
): Promise<StoredReportPaths> => {
  const reportDirectory = join(rootDirectory, '.deploytruth', 'reports');
  const serialized = serializeTruthReport(report);
  const archived = join(reportDirectory, filenameFor(report));
  const latest = join(reportDirectory, 'latest.json');

  await mkdir(reportDirectory, { recursive: true });
  await Promise.all([
    writeFile(archived, serialized, 'utf8'),
    writeFile(latest, serialized, 'utf8'),
  ]);

  return { latest, archived };
};

/** A narrow helper for callers that choose a non-default report path. */
export const writeReportFile = async (filePath: string, report: TruthReport): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, serializeTruthReport(report), 'utf8');
};
