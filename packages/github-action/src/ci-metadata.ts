import { RUN_ID_PATTERN, verdictSchema, type TruthReport } from '@deploytruth/core';
import { z } from 'zod';

export const CI_METADATA_SCHEMA_VERSION = '1' as const;

const safeField = (value: string | undefined, max = 200): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex -- deliberately strips control characters
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  if (cleaned.length === 0) {
    return undefined;
  }
  return cleaned.slice(0, max);
};

const sanitizedString = z.string().min(1).max(512);
const digits = z.string().regex(/^[0-9]+$/);
const GITHUB_REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const GIT_SHA = /^[0-9a-f]{7,64}$/i;
const GIT_REF = /^refs\/[A-Za-z0-9._/-]+$/;

/**
 * CI execution provenance — never infrastructure truth. Explicit allowlisted fields only:
 * no event payload, no actor identity, no server URLs, no environment dump, no runner paths.
 */
export const ciMetadataSchema = z
  .object({
    schemaVersion: z.literal(CI_METADATA_SCHEMA_VERSION),
    provider: z.literal('github-actions'),
    repository: z.string().regex(GITHUB_REPOSITORY).optional(),
    workflow: sanitizedString.optional(),
    job: sanitizedString.optional(),
    githubRunId: digits.optional(),
    githubRunAttempt: digits.optional(),
    githubRunNumber: digits.optional(),
    eventName: sanitizedString.optional(),
    gitSha: z.string().regex(GIT_SHA).optional(),
    gitRef: z.string().regex(GIT_REF).optional(),
    environment: sanitizedString,
    truthRunId: z.string().regex(RUN_ID_PATTERN),
    verdict: verdictSchema,
    generatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type CiMetadata = z.infer<typeof ciMetadataSchema>;

/**
 * Builds provenance from the Actions environment. Fields that fail their shape check are
 * dropped rather than trusted; required identity fields always come from DeployTruth itself.
 */
export const buildCiMetadata = (input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly report: TruthReport;
  readonly environment: string;
  readonly generatedAt: string;
}): CiMetadata => {
  const fields: Record<string, string> = {};
  const put = (key: string, value: string | undefined, pattern?: RegExp): void => {
    const cleaned = safeField(value);
    if (cleaned !== undefined && (pattern === undefined || pattern.test(cleaned))) {
      fields[key] = cleaned;
    }
  };
  const env = input.env;
  put('repository', env['GITHUB_REPOSITORY'], GITHUB_REPOSITORY);
  put('workflow', env['GITHUB_WORKFLOW']);
  put('job', env['GITHUB_JOB']);
  put('githubRunId', env['GITHUB_RUN_ID'], /^[0-9]+$/);
  put('githubRunAttempt', env['GITHUB_RUN_ATTEMPT'], /^[0-9]+$/);
  put('githubRunNumber', env['GITHUB_RUN_NUMBER'], /^[0-9]+$/);
  put('eventName', env['GITHUB_EVENT_NAME']);
  put('gitSha', env['GITHUB_SHA'], GIT_SHA);
  put('gitRef', env['GITHUB_REF'], GIT_REF);

  return ciMetadataSchema.parse({
    schemaVersion: CI_METADATA_SCHEMA_VERSION,
    provider: 'github-actions',
    ...fields,
    environment: safeField(input.environment, 200) ?? input.environment,
    truthRunId: input.report.runId,
    verdict: input.report.verdict,
    generatedAt: input.generatedAt,
  });
};

export const serializeCiMetadata = (metadata: CiMetadata): string =>
  `${JSON.stringify(ciMetadataSchema.parse(metadata), null, 2)}\n`;
