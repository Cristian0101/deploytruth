import type { TruthReport } from '@deploytruth/core';

import { createReportHistoryStore, type StoredReportPaths } from './history.js';
import { serializeTruthReport } from './serializer.js';
import { writeFileAtomic } from './atomic-write.js';

export type { StoredReportPaths } from './history.js';

/** Stores only sanitized report JSON in the project-local environment-scoped history. */
export const writeLocalReport = async (
  rootDirectory: string,
  report: TruthReport,
): Promise<StoredReportPaths> => createReportHistoryStore(rootDirectory).save(report);

/** A narrow helper for callers that choose a non-default report path. */
export const writeReportFile = async (filePath: string, report: TruthReport): Promise<void> => {
  await writeFileAtomic(filePath, serializeTruthReport(report));
};
