import { mkdtemp, rename, rm } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { isRunId } from '@deploytruth/core';
import { parseStoredReport, writeFileAtomic } from '@deploytruth/reporter';

import { ciMetadataSchema, serializeCiMetadata, type CiMetadata } from './ci-metadata.js';

export class BundleError extends Error {
  readonly code = 'bundle_error' as const;

  constructor(message: string) {
    super(message);
    this.name = 'BundleError';
  }
}

export interface CiBundlePaths {
  /** Final bundle directory exposed as the `artifact-directory` output. */
  readonly directory: string;
  readonly reportPath: string;
  readonly summaryPath: string;
  readonly metadataPath: string;
}

export const CI_BUNDLE_FILENAMES = {
  report: 'truth-report.json',
  summary: 'summary.md',
  metadata: 'ci-metadata.json',
} as const;

/**
 * Writes the CI evidence bundle under a trusted runner temp root: contents are validated
 * before anything is written, staged in a private directory, then atomically renamed into
 * place. A partial bundle is never exposed as certification evidence.
 */
export const writeCiBundle = async (input: {
  readonly tempRoot: string;
  readonly runId: string;
  readonly reportJson: string;
  readonly summaryMarkdown: string;
  readonly metadata: CiMetadata;
}): Promise<CiBundlePaths> => {
  if (!isRunId(input.runId)) {
    throw new BundleError('CI bundle identity must be the report run ID.');
  }
  if (parseStoredReport(input.reportJson).status !== 'ok') {
    throw new BundleError('The serialized TruthReport is not valid.');
  }
  const metadataJson = serializeCiMetadata(ciMetadataSchema.parse(input.metadata));
  if (input.summaryMarkdown.trim().length === 0) {
    throw new BundleError('The CI summary is empty.');
  }

  const base = join(input.tempRoot, 'deploytruth');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(base, 'staging-'));
  try {
    const reportPath = join(staging, CI_BUNDLE_FILENAMES.report);
    const summaryPath = join(staging, CI_BUNDLE_FILENAMES.summary);
    const metadataPath = join(staging, CI_BUNDLE_FILENAMES.metadata);
    await writeFileAtomic(reportPath, input.reportJson);
    await writeFileAtomic(summaryPath, input.summaryMarkdown);
    await writeFileAtomic(metadataPath, metadataJson);

    const directory = join(base, input.runId);
    await rename(staging, directory);
    return {
      directory,
      reportPath: join(directory, CI_BUNDLE_FILENAMES.report),
      summaryPath: join(directory, CI_BUNDLE_FILENAMES.summary),
      metadataPath: join(directory, CI_BUNDLE_FILENAMES.metadata),
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error instanceof BundleError
      ? error
      : new BundleError(
          `Failed to write the CI evidence bundle: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
  }
};
