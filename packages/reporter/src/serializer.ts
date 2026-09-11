import { sanitizeForReport, truthReportSchema, type TruthReport } from '@deploytruth/core';

/** Validates the normalized report and redacts again at its final serialization boundary. */
export const serializeTruthReport = (report: TruthReport): string => {
  const validated = truthReportSchema.parse(report);
  return `${JSON.stringify(sanitizeForReport(validated), null, 2)}\n`;
};

export const parseTruthReport = (contents: string): TruthReport =>
  truthReportSchema.parse(JSON.parse(contents));
