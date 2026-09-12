import {
  createLegacyRunId,
  LEGACY_REPORT_SCHEMA_VERSION,
  REPORT_SCHEMA_VERSION,
  legacyTruthReportSchema,
  sanitizeForReport,
  truthReportSchema,
  type TruthReport,
} from '@deploytruth/core';

/** Validates the normalized report and redacts again at its final serialization boundary. */
export const serializeTruthReport = (report: TruthReport): string => {
  const validated = truthReportSchema.parse(report);
  return `${JSON.stringify(sanitizeForReport(validated), null, 2)}\n`;
};

export const parseTruthReport = (contents: string): TruthReport =>
  truthReportSchema.parse(JSON.parse(contents));

export type ParsedStoredReport =
  | { readonly status: 'ok'; readonly report: TruthReport; readonly migrated: boolean }
  | { readonly status: 'unsupported'; readonly schemaVersion: string }
  | { readonly status: 'corrupt'; readonly reason: string };

/**
 * Reads a history file without inventing truth. Known 0.1 reports receive only an additive
 * runId so they can be listed; unknown versions stay unsupported.
 */
export const parseStoredReport = (contents: string): ParsedStoredReport => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return { status: 'corrupt', reason: 'invalid_json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 'corrupt', reason: 'invalid_json' };
  }
  const version =
    'schemaVersion' in parsed && parsed.schemaVersion !== undefined
      ? String(parsed.schemaVersion)
      : 'unknown';
  if (version === REPORT_SCHEMA_VERSION) {
    const result = truthReportSchema.safeParse(parsed);
    return result.success
      ? { status: 'ok', report: result.data, migrated: false }
      : { status: 'corrupt', reason: 'invalid_schema' };
  }
  if (version === LEGACY_REPORT_SCHEMA_VERSION) {
    const legacy = legacyTruthReportSchema.safeParse(parsed);
    if (!legacy.success) {
      return { status: 'corrupt', reason: 'invalid_schema' };
    }
    const migrated = truthReportSchema.safeParse({
      ...legacy.data,
      schemaVersion: REPORT_SCHEMA_VERSION,
      runId: createLegacyRunId(contents),
    });
    return migrated.success
      ? { status: 'ok', report: migrated.data, migrated: true }
      : { status: 'corrupt', reason: 'invalid_schema' };
  }
  return { status: 'unsupported', schemaVersion: version };
};
