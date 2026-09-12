import {
  migrationCatalogObservationSchema,
  type MigrationCatalogAvailability,
  type MigrationCatalogObservation,
} from '@deploytruth/core';
import { z } from 'zod';

import type { ObservationContext, ProviderDiagnostic, TruthProvider } from '../contracts.js';
import { GitError } from './errors.js';
import { createNodeGitRunner, type GitRunner } from './runner.js';

/**
 * A repository-relative directory path: safe-character segments only, so it can be passed
 * to `git ls-tree` without quoting, traversal, or option-injection risk.
 */
export const REPOSITORY_RELATIVE_PATH_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)*$/;

export const DEFAULT_MIGRATION_DIRECTORY = 'supabase/migrations';

export const gitMigrationCatalogConfigSchema = z
  .object({
    /** Directory inside the repository to inspect; resolved to the repository root. */
    directory: z.string().min(1).optional(),
    /** Repository-relative migration directory; defaults to the Supabase convention. */
    migrationDirectory: z
      .string()
      .regex(
        REPOSITORY_RELATIVE_PATH_PATTERN,
        'migrationDirectory must be a repository-relative path of safe segments',
      )
      .refine((value) => !value.split('/').some((segment) => segment === '.' || segment === '..'), {
        message: 'migrationDirectory must not contain . or .. segments',
      })
      .default(DEFAULT_MIGRATION_DIRECTORY),
  })
  .strict();
export type GitMigrationCatalogConfig = z.infer<typeof gitMigrationCatalogConfigSchema>;

/**
 * The Supabase CLI's migration grammar (`pkg/migration/file.go` migrateFilePattern):
 * `<digits>_<name>.sql` versions by timestamp; `r_<name>.sql` is a repeatable migration
 * whose recorded version is `r_<name>`. Non-.sql entries are never migrations; a `.sql`
 * file that fails the grammar is silently skipped by the CLI — DeployTruth reports it
 * instead of pretending it does not exist.
 */
const MIGRATION_FILENAME_PATTERN = /^([0-9]+|r)_(.*)\.sql$/;

/**
 * Backward-compatibility quirk mirrored from the CLI (`pkg/migration/list.go`
 * `shouldSkip`): a legacy `<14-digit-timestamp>_init.sql` earlier than 2021-12-09 is
 * ignored when it is the first entry in the directory.
 */
const LEGACY_INIT_PATTERN = /^([0-9]{14})_init\.sql$/;
const LEGACY_INIT_MAX_TIMESTAMP = 20211209000000n;

export const migrationVersionFromFilename = (filename: string): string | undefined => {
  const matches = MIGRATION_FILENAME_PATTERN.exec(filename);
  if (matches === null) {
    return undefined;
  }
  const version = matches[1] ?? '';
  const name = matches[2] ?? '';
  return version === 'r' ? `r_${name}` : version;
};

interface TreeEntry {
  readonly type: string;
  readonly path: string;
}

/** Parses `git ls-tree <rev> <path>` output lines (`<mode> <type> <sha>\t<path>`). */
const parseTreeEntries = (stdout: string): readonly TreeEntry[] =>
  stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [metadata, path] = line.split('\t', 2);
      const type = metadata?.trim().split(/\s+/)[1] ?? '';
      return { type, path: path ?? '' };
    })
    .filter((entry) => entry.path.length > 0);

const unavailable = (
  config: GitMigrationCatalogConfig,
  reason: NonNullable<MigrationCatalogAvailability['reason']>,
  detail: string,
  extras: Partial<MigrationCatalogAvailability> = {},
): MigrationCatalogObservation =>
  migrationCatalogObservationSchema.parse({
    directory: config.migrationDirectory,
    migrationIds: [],
    availability: { state: 'unavailable', reason, detail, ...extras },
  });

const trimOutput = (value: string): string => value.trim();

const observeCatalog = async (
  runner: GitRunner,
  directory: string,
  config: GitMigrationCatalogConfig,
  signal?: AbortSignal,
): Promise<MigrationCatalogObservation> => {
  const run = (args: readonly string[], cwd: string = directory) =>
    runner.run(args, { cwd, ...(signal ? { signal } : {}) });

  let root: string;
  let headSha: string;
  try {
    const inside = await run(['rev-parse', '--is-inside-work-tree']);
    if (inside.exitCode !== 0 || trimOutput(inside.stdout) !== 'true') {
      return unavailable(
        config,
        'not_a_repository',
        `${directory} is not inside a Git working tree; the expected migration catalog cannot be read.`,
      );
    }
    const rootResult = await run(['rev-parse', '--show-toplevel']);
    if (rootResult.exitCode !== 0) {
      return unavailable(
        config,
        'not_a_repository',
        'The repository root could not be resolved; the expected migration catalog cannot be read.',
      );
    }
    root = trimOutput(rootResult.stdout);

    const head = await run(['rev-parse', '--verify', 'HEAD'], root);
    if (head.exitCode !== 0 || trimOutput(head.stdout).length === 0) {
      return unavailable(
        config,
        'head_unavailable',
        'HEAD does not resolve to a commit; the expected migration catalog cannot be read.',
      );
    }
    headSha = trimOutput(head.stdout);
  } catch (error) {
    return unavailable(
      config,
      'git_unavailable',
      error instanceof GitError ? error.message : 'Git observation failed.',
    );
  }

  const dir = config.migrationDirectory;
  const listing = await run(['ls-tree', headSha, dir], root);
  if (listing.exitCode !== 0) {
    return unavailable(
      config,
      'git_unavailable',
      `git ls-tree failed for ${dir}; the expected migration catalog cannot be read.`,
    );
  }
  const [self] = parseTreeEntries(listing.stdout);
  if (self === undefined) {
    return unavailable(
      config,
      'directory_missing',
      `The migration directory ${dir} is not present in the source tree at ${headSha.slice(0, 7)}.`,
    );
  }
  if (self.type !== 'tree') {
    return unavailable(
      config,
      'not_a_directory',
      `The migration path ${dir} is not a directory in the source tree at ${headSha.slice(0, 7)}.`,
    );
  }

  const entries = await run(['ls-tree', headSha, `${dir}/`], root);
  if (entries.exitCode !== 0) {
    return unavailable(
      config,
      'git_unavailable',
      `git ls-tree failed for ${dir}/; the expected migration catalog cannot be read.`,
    );
  }

  const filenames = parseTreeEntries(entries.stdout)
    .filter((entry) => entry.type === 'blob')
    .map((entry) => entry.path.slice(entry.path.lastIndexOf('/') + 1));

  // The CLI ignores a legacy first-entry <timestamp>_init.sql schema dump.
  const [first, ...rest] = filenames;
  const legacyInit = LEGACY_INIT_PATTERN.exec(first ?? '');
  const candidates =
    legacyInit !== null && BigInt(legacyInit[1] ?? '0') < LEGACY_INIT_MAX_TIMESTAMP
      ? rest
      : filenames;

  const invalidFilenames = candidates.filter(
    (filename) => filename.endsWith('.sql') && migrationVersionFromFilename(filename) === undefined,
  );
  if (invalidFilenames.length > 0) {
    return unavailable(
      config,
      'invalid_filenames',
      'One or more .sql files cannot be interpreted under the Supabase migration grammar.',
      { invalidFilenames: [...invalidFilenames].sort() },
    );
  }

  const versions = candidates
    .map((filename) => migrationVersionFromFilename(filename))
    .filter((version): version is string => version !== undefined);
  const counts = new Map<string, number>();
  for (const version of versions) {
    counts.set(version, (counts.get(version) ?? 0) + 1);
  }
  const duplicateVersions = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([version]) => version)
    .sort();
  if (duplicateVersions.length > 0) {
    return unavailable(
      config,
      'duplicate_versions',
      'More than one migration file claims the same version.',
      { duplicateVersions },
    );
  }

  return migrationCatalogObservationSchema.parse({
    directory: dir,
    migrationIds: [...new Set(versions)].sort(),
    sourceSha: headSha,
    origin: 'git-tree',
    availability: { state: 'available' },
  });
};

const diagnostic = (
  code: string,
  title: string,
  status: ProviderDiagnostic['status'],
  message: string,
): ProviderDiagnostic => ({ code, title, status, message });

/**
 * Reads the expected migration catalog from the immutable Git object tree at HEAD via
 * `git ls-tree` — never the working-tree filesystem, so untracked or modified files cannot
 * contaminate expected truth. Which commit the catalog represents is reported as
 * `sourceSha`; whether that commit is authoritative for the environment is a truth-rule
 * decision, not an adapter decision.
 */
export const createGitMigrationCatalogProvider = (
  options: { readonly runner?: GitRunner } = {},
): TruthProvider<GitMigrationCatalogConfig, MigrationCatalogObservation> => {
  const runner = options.runner ?? createNodeGitRunner();

  return {
    id: 'git-migrations',
    capabilities: ['migration-status'],
    validateConfig: (config: unknown) => gitMigrationCatalogConfigSchema.parse(config),
    observe: async (context: ObservationContext<GitMigrationCatalogConfig>) =>
      observeCatalog(
        runner,
        context.config.directory ?? process.cwd(),
        context.config,
        context.signal,
      ),
    diagnose: async (context: ObservationContext<GitMigrationCatalogConfig>) => {
      const observation = await observeCatalog(
        runner,
        context.config.directory ?? process.cwd(),
        context.config,
        context.signal,
      );
      return observation.availability?.state === 'available'
        ? [
            diagnostic(
              'GIT_MIGRATION_CATALOG',
              `Migration catalog ${observation.directory}`,
              'ok',
              `${observation.migrationIds.length} expected migration(s) at ${observation.sourceSha?.slice(0, 7) ?? 'unknown'}`,
            ),
          ]
        : [
            diagnostic(
              'GIT_MIGRATION_CATALOG',
              `Migration catalog ${observation.directory}`,
              'error',
              observation.availability?.detail ?? 'unavailable',
            ),
          ];
    },
  };
};

export const gitMigrationCatalogProvider = createGitMigrationCatalogProvider();
