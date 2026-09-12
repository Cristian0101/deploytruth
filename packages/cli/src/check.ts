import { dirname } from 'node:path';

import {
  evaluateTruth,
  redactText,
  type DatabaseObservation,
  type DeploymentObservation,
  type EnvironmentTruth,
  type MigrationCatalogObservation,
  type ProjectDeclaration,
  type RuntimeObservation,
  type SourceObservation,
  type TruthReport,
} from '@deploytruth/core';
import { ConfigError, loadDeployTruthManifest } from '@deploytruth/config';
import {
  GitError,
  createGitHubProvider,
  createGitMigrationCatalogProvider,
  createSupabaseProvider,
  createRuntimeProvider,
  createVercelProvider,
  localGitProvider,
  type GitHubSourceConfig,
  type GitMigrationCatalogConfig,
  type TruthProvider,
  type LocalGitConfig,
  type RuntimeAttestationConfig,
  type SupabaseDatabaseConfig,
  type VercelDeploymentConfig,
} from '@deploytruth/providers';

export interface CheckOptions {
  readonly configPath: string;
  readonly environmentName?: string;
  readonly strict?: boolean;
  /** Injectable for tests; defaults to the execFile-based local Git adapter. */
  readonly gitProvider?: TruthProvider<LocalGitConfig, SourceObservation>;
  /** Injectable for tests; defaults to a GitHub adapter over the live GET-only transport. */
  readonly githubProvider?: TruthProvider<GitHubSourceConfig, SourceObservation>;
  /** Injectable for tests; defaults to a Vercel adapter over the live GET-only transport. */
  readonly vercelProvider?: TruthProvider<VercelDeploymentConfig, DeploymentObservation>;
  /** Injectable for tests; defaults to a Supabase adapter over the live GET-only transport. */
  readonly supabaseProvider?: TruthProvider<SupabaseDatabaseConfig, DatabaseObservation>;
  /** Injectable for tests; defaults to the Git ls-tree migration catalog reader. */
  readonly migrationCatalogProvider?: TruthProvider<
    GitMigrationCatalogConfig,
    MigrationCatalogObservation
  >;
  /** Injectable for tests; defaults to the strict GET-only runtime attestation adapter. */
  readonly runtimeProvider?: TruthProvider<RuntimeAttestationConfig, RuntimeObservation>;
  /** Environment for credential resolution; defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface CheckExecution {
  readonly report: TruthReport;
  readonly environmentId: string;
  /** Human-readable diagnostics when an observation could not be produced. */
  readonly diagnostics: readonly string[];
}

export const selectEnvironment = (
  declaration: ProjectDeclaration,
  environmentName?: string,
): { readonly id: string } => {
  const ids = Object.keys(declaration.environments).sort();

  if (environmentName === undefined) {
    if (ids.length === 1 && ids[0] !== undefined) {
      return { id: ids[0] };
    }
    throw new ConfigError('Multiple environments are declared; pass --environment.', [
      `Declared environments: ${ids.join(', ')}`,
    ]);
  }

  if (declaration.environments[environmentName] === undefined) {
    throw new ConfigError(`Environment "${environmentName}" is not declared in the manifest.`, [
      `Declared environments: ${ids.join(', ')}`,
    ]);
  }

  return { id: environmentName };
};

const observeLocalGit = async (
  provider: TruthProvider<LocalGitConfig, SourceObservation>,
  context: { project: string; environment: string; directory: string; signal?: AbortSignal },
): Promise<{ observation?: SourceObservation; diagnostic?: string }> => {
  try {
    const config = provider.validateConfig({ directory: context.directory });
    const observation = await provider.observe({
      project: context.project,
      environment: context.environment,
      config,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    return { observation };
  } catch (error) {
    const message =
      error instanceof GitError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Unknown Git observation failure';
    return { diagnostic: redactText(message) };
  }
};

const observeGitHub = async (
  provider: TruthProvider<GitHubSourceConfig, SourceObservation>,
  context: {
    project: string;
    environment: string;
    repository: string;
    branch: string;
    signal?: AbortSignal;
  },
): Promise<{ observation?: SourceObservation; diagnostic?: string }> => {
  let config: GitHubSourceConfig;
  try {
    config = provider.validateConfig({
      repository: context.repository,
      branch: context.branch,
    });
  } catch {
    return {
      diagnostic:
        'Invalid GitHub source declaration; expected repository in owner/repo form and a valid branch name.',
    };
  }

  try {
    const observation = await provider.observe({
      project: context.project,
      environment: context.environment,
      config,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    return { observation };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown GitHub observation failure';
    return { diagnostic: redactText(message) };
  }
};

const observeVercel = async (
  provider: TruthProvider<VercelDeploymentConfig, DeploymentObservation>,
  context: {
    project: string;
    environment: string;
    deployment: {
      project: string;
      target?: 'production';
      scope?: string;
      domain?: string;
    };
    signal?: AbortSignal;
  },
): Promise<{ observation?: DeploymentObservation; diagnostic?: string }> => {
  let config: VercelDeploymentConfig;
  try {
    config = provider.validateConfig({
      project: context.deployment.project,
      ...(context.deployment.target !== undefined ? { target: context.deployment.target } : {}),
      ...(context.deployment.scope !== undefined ? { scope: context.deployment.scope } : {}),
      ...(context.deployment.domain !== undefined ? { domain: context.deployment.domain } : {}),
    });
  } catch {
    return {
      diagnostic:
        'Invalid Vercel deployment declaration; expected a project name/id, target "production", and an optional scope or bare-hostname domain.',
    };
  }

  try {
    const observation = await provider.observe({
      project: context.project,
      environment: context.environment,
      config,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    return { observation };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Vercel observation failure';
    return { diagnostic: redactText(message) };
  }
};

const observeSupabase = async (
  provider: TruthProvider<SupabaseDatabaseConfig, DatabaseObservation>,
  context: {
    project: string;
    environment: string;
    database: { projectRef: string };
    signal?: AbortSignal;
  },
): Promise<{ observation?: DatabaseObservation; diagnostic?: string }> => {
  let config: SupabaseDatabaseConfig;
  try {
    config = provider.validateConfig({ projectRef: context.database.projectRef });
  } catch {
    return {
      diagnostic:
        'Invalid Supabase database declaration; expected a project ref (lowercase letters and digits).',
    };
  }

  try {
    const observation = await provider.observe({
      project: context.project,
      environment: context.environment,
      config,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    return { observation };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Supabase observation failure';
    return { diagnostic: redactText(message) };
  }
};

const observeMigrationCatalog = async (
  provider: TruthProvider<GitMigrationCatalogConfig, MigrationCatalogObservation>,
  context: {
    project: string;
    environment: string;
    directory: string;
    migrationDirectory: string;
    signal?: AbortSignal;
  },
): Promise<{ observation?: MigrationCatalogObservation; diagnostic?: string }> => {
  let config: GitMigrationCatalogConfig;
  try {
    config = provider.validateConfig({
      directory: context.directory,
      migrationDirectory: context.migrationDirectory,
    });
  } catch {
    return {
      diagnostic:
        'Invalid migration directory declaration; expected a repository-relative path of safe segments.',
    };
  }

  try {
    const observation = await provider.observe({
      project: context.project,
      environment: context.environment,
      config,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    return { observation };
  } catch (error) {
    const message =
      error instanceof GitError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Unknown migration catalog observation failure';
    return { diagnostic: redactText(message) };
  }
};

const observeRuntime = async (
  provider: TruthProvider<RuntimeAttestationConfig, RuntimeObservation>,
  context: {
    project: string;
    environment: string;
    runtimeUrl: string;
    requiredEnvironmentVariables: readonly string[];
    signal?: AbortSignal;
  },
): Promise<{ observation?: RuntimeObservation; diagnostic?: string }> => {
  let config: RuntimeAttestationConfig;
  try {
    config = provider.validateConfig({
      url: context.runtimeUrl,
      requiredEnvironmentVariables: [...context.requiredEnvironmentVariables],
    });
  } catch {
    return { diagnostic: 'Invalid runtime attestation URL or required-variable declaration.' };
  }

  try {
    const observation = await provider.observe({
      project: context.project,
      environment: context.environment,
      config,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    return { observation };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown runtime observation failure';
    return { diagnostic: redactText(message) };
  }
};

/**
 * Loads the manifest, observes local Git truth, remote-authoritative source truth (GitHub when
 * declared), deployment truth (Vercel when declared), and database truth (Supabase when
 * declared, plus the committed migration catalog) for the selected environment, then
 * evaluates the deterministic rule set. Missing provider evidence remains an explicit
 * UNKNOWN/WARN signal; it never produces a false PASS.
 */
export const runEnvironmentCheck = async (options: CheckOptions): Promise<CheckExecution> => {
  const manifest = await loadDeployTruthManifest(options.configPath);
  const { id: environmentId } = selectEnvironment(manifest, options.environmentName);
  const environment = manifest.environments[environmentId];
  const diagnostics: string[] = [];

  let source: SourceObservation | undefined;
  let remoteSource: SourceObservation | undefined;
  let deployment: DeploymentObservation | undefined;
  let database: DatabaseObservation | undefined;
  let runtime: RuntimeObservation | undefined;
  let repositoryMigrations: MigrationCatalogObservation | undefined;

  const pending: Promise<void>[] = [];

  if (environment?.runtime !== undefined) {
    pending.push(
      observeRuntime(options.runtimeProvider ?? createRuntimeProvider(), {
        project: manifest.project,
        environment: environmentId,
        runtimeUrl: environment.runtime.url,
        requiredEnvironmentVariables: environment.requiredEnvironmentVariables,
      }).then((result) => {
        runtime = result.observation;
        if (result.diagnostic !== undefined) {
          diagnostics.push(`runtime: ${result.diagnostic}`);
        }
      }),
    );
  }

  if (environment?.database !== undefined && environment.database.provider === 'supabase') {
    const declared = environment.database;
    const supabaseProvider =
      options.supabaseProvider ??
      createSupabaseProvider({
        ...(options.env !== undefined ? { env: options.env } : {}),
      });
    pending.push(
      observeSupabase(supabaseProvider, {
        project: manifest.project,
        environment: environmentId,
        database: { projectRef: declared.projectRef },
      }).then((result) => {
        database = result.observation;
        if (result.diagnostic !== undefined) {
          diagnostics.push(`supabase: ${result.diagnostic}`);
        }
      }),
    );
  }

  if (environment?.database?.migrationDirectory !== undefined) {
    const declared = environment.database;
    pending.push(
      observeMigrationCatalog(
        options.migrationCatalogProvider ?? createGitMigrationCatalogProvider(),
        {
          project: manifest.project,
          environment: environmentId,
          directory: dirname(options.configPath),
          migrationDirectory: declared.migrationDirectory ?? 'supabase/migrations',
        },
      ).then((result) => {
        repositoryMigrations = result.observation;
        if (result.diagnostic !== undefined) {
          diagnostics.push(`migrations: ${result.diagnostic}`);
        }
      }),
    );
  }

  if (environment?.deployment !== undefined && environment.deployment.provider === 'vercel') {
    const declared = environment.deployment;
    const vercelProvider =
      options.vercelProvider ??
      createVercelProvider({
        ...(options.env !== undefined ? { env: options.env } : {}),
      });
    pending.push(
      observeVercel(vercelProvider, {
        project: manifest.project,
        environment: environmentId,
        deployment: {
          project: declared.project,
          ...(declared.target !== undefined ? { target: declared.target } : {}),
          ...(declared.scope !== undefined ? { scope: declared.scope } : {}),
          ...(declared.domain !== undefined ? { domain: declared.domain } : {}),
        },
      }).then((result) => {
        deployment = result.observation;
        if (result.diagnostic !== undefined) {
          diagnostics.push(`vercel: ${result.diagnostic}`);
        }
      }),
    );
  }

  if (environment?.source !== undefined) {
    const declared = environment.source;
    pending.push(
      Promise.all([
        observeLocalGit(options.gitProvider ?? localGitProvider, {
          project: manifest.project,
          environment: environmentId,
          directory: dirname(options.configPath),
        }),
        declared.provider === 'github'
          ? declared.repository !== undefined && declared.branch !== undefined
            ? observeGitHub(
                options.githubProvider ??
                  createGitHubProvider({
                    ...(options.env !== undefined ? { env: options.env } : {}),
                  }),
                {
                  project: manifest.project,
                  environment: environmentId,
                  repository: declared.repository,
                  branch: declared.branch,
                },
              )
            : Promise.resolve<{
                observation?: SourceObservation;
                diagnostic?: string;
              }>({
                diagnostic:
                  'GitHub source declarations require both repository (owner/repo) and branch.',
              })
          : Promise.resolve<{ observation?: SourceObservation; diagnostic?: string }>({}),
      ]).then(([localResult, remoteResult]) => {
        source = localResult?.observation;
        if (localResult?.diagnostic !== undefined) {
          diagnostics.push(`local-git: ${localResult.diagnostic}`);
        }
        if (remoteResult !== undefined) {
          remoteSource = remoteResult.observation;
          if (remoteResult.diagnostic !== undefined) {
            diagnostics.push(`github: ${remoteResult.diagnostic}`);
          }
        }
      }),
    );
  }

  await Promise.all(pending);

  const report = evaluateTruth(
    {
      declaration: manifest,
      observations: {
        project: manifest.project,
        environments: {
          [environmentId]: {
            environment: environmentId,
            ...(source !== undefined ? { source } : {}),
            ...(remoteSource !== undefined ? { remoteSource } : {}),
            ...(deployment !== undefined ? { deployment } : {}),
            ...(database !== undefined ? { database } : {}),
            ...(runtime !== undefined ? { runtime } : {}),
            ...(repositoryMigrations !== undefined ? { repositoryMigrations } : {}),
          },
        },
      },
      generatedAt: new Date().toISOString(),
      ...(options.strict !== undefined ? { strict: options.strict } : {}),
    },
    undefined,
    { environments: [environmentId] },
  );

  return { report, environmentId, diagnostics };
};

const shortSha = (sha: string | undefined): string =>
  sha === undefined ? 'unknown' : sha.slice(0, 7);

const row = (label: string, value: string): string => `  ${label.padEnd(20)} ${value}`;

const formatSourceSection = (
  truth: EnvironmentTruth,
  diagnostics: readonly string[],
): readonly string[] => {
  const lines = ['SOURCE'];
  const source = truth.observation?.source;

  if (source === undefined) {
    const reason =
      diagnostics
        .find((entry) => entry.startsWith('local-git:'))
        ?.slice('local-git:'.length)
        .trim() ?? 'no local Git observation available';
    lines.push(row('Git repository', `NOT OBSERVED — ${reason}`));
    return lines;
  }

  lines.push(row('Git repository', source.repositoryRoot ?? 'detected'));
  if (source.detachedHead) {
    lines.push(row('Branch', `DETACHED at ${shortSha(source.headSha)}`));
  } else {
    lines.push(row('Branch', source.branch ?? 'unknown'));
  }
  lines.push(row('HEAD', shortSha(source.headSha)));

  if (source.workingTree === 'clean') {
    lines.push(row('Working tree', 'CLEAN'));
  } else {
    const parts = [
      `${source.stagedCount} staged`,
      `${source.modifiedCount} modified`,
      `${source.untrackedCount} untracked`,
      ...(source.unmergedCount > 0 ? [`${source.unmergedCount} unmerged`] : []),
    ];
    lines.push(row('Working tree', `${source.workingTree.toUpperCase()} (${parts.join(', ')})`));
  }

  if (source.upstream !== undefined) {
    lines.push(
      row(
        'Tracking ref',
        `${source.upstream.remote}/${source.upstream.branch} -> ${shortSha(source.upstream.sha)} (local ref; remote unverified)`,
      ),
    );
    lines.push(
      row('Ahead / behind', `${source.aheadBy ?? 'unknown'} / ${source.behindBy ?? 'unknown'}`),
    );
  } else if (!source.detachedHead && source.branch !== undefined) {
    lines.push(row('Tracking ref', 'none configured'));
  }

  if (source.operationsInProgress.length > 0) {
    lines.push(row('Operations', source.operationsInProgress.join(', ')));
  }
  if (source.isLinkedWorktree || source.worktrees.length > 1) {
    const others = source.worktrees.length - 1;
    lines.push(
      row(
        'Worktrees',
        `${source.worktrees.length} total${source.isLinkedWorktree ? ' (current is linked)' : ''}, ${others} other`,
      ),
    );
  }
  return lines;
};

const subRow = (label: string, value: string): string => `    ${label.padEnd(18)} ${value}`;

const formatGitHubSection = (
  truth: EnvironmentTruth,
  diagnostics: readonly string[],
): readonly string[] => {
  const remote = truth.observation?.remoteSource;
  const lines = ['  GitHub'];

  if (remote === undefined) {
    const reason =
      diagnostics
        .find((entry) => entry.startsWith('github:'))
        ?.slice('github:'.length)
        .trim() ?? 'no GitHub observation available';
    lines.push(subRow('Status', `NOT OBSERVED — ${reason}`));
    return lines;
  }

  lines.push(subRow('Repository', remote.repository ?? 'unknown'));

  if (remote.availability?.state === 'unavailable') {
    const availability = remote.availability;
    lines.push(
      subRow(
        'Status',
        `UNAVAILABLE — ${availability.detail ?? availability.reason ?? 'authoritative source unavailable'}`,
      ),
    );
    if (availability.rateLimit?.resetAt !== undefined) {
      lines.push(subRow('Retry after', availability.rateLimit.resetAt));
    }
    return lines;
  }

  lines.push(subRow('Branch', remote.branch ?? 'unknown'));
  lines.push(subRow('Authoritative SHA', shortSha(remote.remoteHeadSha)));
  if (remote.defaultBranch !== undefined) {
    lines.push(subRow('Default branch', remote.defaultBranch));
  }
  if (remote.visibility !== undefined) {
    lines.push(subRow('Visibility', remote.visibility));
  }
  if (remote.archived === true) {
    lines.push(subRow('Archived', 'yes (read-only on GitHub)'));
  }
  return lines;
};

/** VERIFIED only when local HEAD, the local tracking ref, and the GitHub head all agree. */
const formatSourceTruthSummary = (truth: EnvironmentTruth): readonly string[] => {
  const source = truth.observation?.source;
  const remote = truth.observation?.remoteSource;
  const remoteSha = remote?.remoteHeadSha;
  if (remote?.availability?.state !== 'available' || remoteSha === undefined) {
    return [];
  }
  const trackingSha = source?.upstream?.sha;
  const agrees =
    source?.headSha !== undefined &&
    trackingSha !== undefined &&
    source.headSha === remoteSha &&
    trackingSha === remoteSha;
  return agrees
    ? [
        row(
          'Source truth',
          `VERIFIED — local HEAD, tracking ref, and GitHub ${remote.branch ?? 'branch'} all point to ${shortSha(remoteSha)}`,
        ),
      ]
    : [];
};

const formatVercelSection = (
  truth: EnvironmentTruth,
  diagnostics: readonly string[],
): readonly string[] => {
  const deployment = truth.observation?.deployment;
  const lines = ['  Vercel'];

  if (deployment === undefined) {
    const reason =
      diagnostics
        .find((entry) => entry.startsWith('vercel:'))
        ?.slice('vercel:'.length)
        .trim() ?? 'no Vercel observation available';
    lines.push(subRow('Status', `NOT OBSERVED — ${reason}`));
    return lines;
  }

  lines.push(subRow('Project', deployment.project ?? 'unknown'));

  if (deployment.availability?.state === 'unavailable') {
    const availability = deployment.availability;
    lines.push(
      subRow(
        'Status',
        `UNAVAILABLE — ${availability.detail ?? availability.reason ?? 'deployment truth unavailable'}`,
      ),
    );
    if (availability.rateLimit?.resetAt !== undefined) {
      lines.push(subRow('Retry after', availability.rateLimit.resetAt));
    } else if (availability.rateLimit?.retryAfter !== undefined) {
      lines.push(subRow('Retry after', `${availability.rateLimit.retryAfter}s`));
    }
    return lines;
  }

  lines.push(subRow('Target', deployment.target ?? 'unknown'));
  lines.push(subRow('Deployment', deployment.deploymentId ?? 'unknown'));
  lines.push(subRow('State', (deployment.state ?? 'unknown').toUpperCase()));
  if (deployment.sourceBranch !== undefined) {
    lines.push(subRow('Source branch', deployment.sourceBranch));
  }
  lines.push(subRow('Source SHA', shortSha(deployment.commitSha)));
  if (deployment.sourceRepository !== undefined) {
    lines.push(subRow('Source repo', deployment.sourceRepository));
  }
  if (deployment.deploymentUrl !== undefined) {
    lines.push(subRow('URL', deployment.deploymentUrl));
  }
  if (deployment.stableDomain !== undefined) {
    lines.push(
      subRow(
        'Domain',
        `${deployment.stableDomain}${
          deployment.stableDomainVerified === true
            ? ' (verified)'
            : deployment.stableDomainVerified === false
              ? ' (STALE — not serving production)'
              : ' (unverified)'
        }`,
      ),
    );
  }
  if (deployment.createdAt !== undefined) {
    lines.push(subRow('Created', deployment.createdAt));
  }
  return lines;
};

/**
 * Deployment truth is VERIFIED only when the observed production deployment is ready, its
 * recorded source commit matches the authoritative source SHA, and any declared stable domain
 * is confirmed to resolve to it.
 */
const formatDeploymentTruthSummary = (truth: EnvironmentTruth): readonly string[] => {
  const deployment = truth.observation?.deployment;
  const remote = truth.observation?.remoteSource;
  const expectedSha =
    remote !== undefined
      ? remote.remoteHeadSha
      : (truth.observation?.source?.remoteHeadSha ?? truth.observation?.source?.headSha);
  const verified =
    deployment?.availability?.state === 'available' &&
    deployment.state === 'ready' &&
    deployment.commitSha !== undefined &&
    expectedSha !== undefined &&
    deployment.commitSha === expectedSha &&
    (deployment.stableDomain === undefined || deployment.stableDomainVerified === true);
  return verified
    ? [row('Deployment truth', `VERIFIED — production serves ${shortSha(deployment?.commitSha)}`)]
    : [];
};

const formatSupabaseSection = (
  truth: EnvironmentTruth,
  diagnostics: readonly string[],
): readonly string[] => {
  const database = truth.observation?.database;
  const lines = ['  Supabase'];
  const declared = truth.declaration.database;

  if (database === undefined) {
    const reason =
      diagnostics
        .find((entry) => entry.startsWith('supabase:'))
        ?.slice('supabase:'.length)
        .trim() ?? 'no Supabase observation available';
    lines.push(subRow('Status', `NOT OBSERVED — ${reason}`));
    return lines;
  }

  lines.push(subRow('Declared project', database.projectRef ?? declared?.projectRef ?? 'unknown'));

  const controlPlane = database.controlPlane;
  if (controlPlane?.state === 'available') {
    const facts = [controlPlane.projectName, controlPlane.region, controlPlane.status].filter(
      (part): part is string => part !== undefined,
    );
    lines.push(
      subRow('Project access', `AVAILABLE${facts.length > 0 ? ` (${facts.join(' · ')})` : ''}`),
    );
  } else {
    lines.push(
      subRow(
        'Project access',
        `UNAVAILABLE — ${controlPlane?.detail ?? controlPlane?.reason ?? 'not observed'}`,
      ),
    );
  }

  const connection = database.connection;
  if (connection?.state === 'available') {
    lines.push(
      subRow(
        'Connection',
        `AVAILABLE${connection.identitySource !== undefined ? ` (identity via ${connection.identitySource})` : ''}`,
      ),
    );
    if (database.identity === 'verified') {
      lines.push(subRow('Database identity', `VERIFIED — ${database.observedProjectRef}`));
    } else if (database.identity === 'mismatch') {
      lines.push(
        subRow(
          'Database identity',
          `MISMATCH — observed ${database.observedProjectRef ?? 'unknown'}, declared ${database.projectRef ?? declared?.projectRef ?? 'unknown'}`,
        ),
      );
    } else {
      lines.push(
        subRow('Database identity', 'UNVERIFIED — endpoint does not expose a project ref'),
      );
    }
  } else {
    lines.push(
      subRow(
        'Connection',
        `UNAVAILABLE — ${connection?.detail ?? connection?.reason ?? 'not observed'}`,
      ),
    );
    if (connection?.targetProjectRef !== undefined) {
      lines.push(
        subRow(
          'Connection target',
          `${connection.targetProjectRef} (endpoint-derived — not an observed identity)`,
        ),
      );
    }
    lines.push(subRow('Database identity', 'NOT OBSERVED'));
  }

  const catalog = truth.observation?.repositoryMigrations;
  if (catalog === undefined) {
    lines.push(subRow('Migration source', 'NOT OBSERVED'));
  } else if (catalog.availability?.state === 'available') {
    lines.push(
      subRow('Migration source', `Git ${shortSha(catalog.sourceSha)} (${catalog.directory})`),
    );
    lines.push(subRow('Expected migrations', String(catalog.migrationIds.length)));
  } else {
    lines.push(
      subRow(
        'Migration source',
        `UNAVAILABLE — ${catalog.availability?.detail ?? catalog.availability?.reason ?? 'unknown'}`,
      ),
    );
  }

  const history = database.migrationHistory;
  if (history?.state === 'available') {
    lines.push(subRow('Applied migrations', String(database.appliedMigrationIds.length)));
  } else if (history !== undefined) {
    lines.push(
      subRow('Migration history', `UNAVAILABLE — ${history.detail ?? history.reason ?? 'unknown'}`),
    );
  } else {
    lines.push(subRow('Migration history', 'NOT OBSERVED'));
  }

  return lines;
};

/**
 * Migration history is VERIFIED only when the expected catalog is authoritative for the
 * declared source, the observed database is provably the declared project, history was
 * actually read, and the version sets match exactly. Anything less is never claimed.
 */
const formatDatabaseTruthSummary = (truth: EnvironmentTruth): readonly string[] => {
  const database = truth.observation?.database;
  const catalog = truth.observation?.repositoryMigrations;
  const remote = truth.observation?.remoteSource;
  const remoteDeclared = truth.declaration.source !== undefined;
  const sourceAuthoritative =
    catalog?.availability?.state === 'available' &&
    (!remoteDeclared ||
      (remote?.availability?.state === 'available' &&
        remote.remoteHeadSha !== undefined &&
        catalog.sourceSha === remote.remoteHeadSha));
  const verified =
    sourceAuthoritative &&
    database?.identity === 'verified' &&
    database.migrationHistory?.state === 'available' &&
    catalog !== undefined &&
    catalog.migrationIds.length === database.appliedMigrationIds.length &&
    catalog.migrationIds.every((id) => database.appliedMigrationIds.includes(id));
  return verified
    ? [
        row(
          'Database truth',
          `MIGRATIONS VERIFIED — ${database?.appliedMigrationIds.length} applied migration(s) match ${catalog?.directory ?? 'source'}`,
        ),
      ]
    : [];
};

const formatRuntimeSection = (
  truth: EnvironmentTruth,
  diagnostics: readonly string[],
): readonly string[] => {
  const runtime = truth.observation?.runtime;
  const lines = ['RUNTIME'];
  if (runtime === undefined) {
    const reason =
      diagnostics
        .find((entry) => entry.startsWith('runtime:'))
        ?.slice('runtime:'.length)
        .trim() ?? 'no runtime attestation available';
    lines.push(row('Endpoint', truth.declaration.runtime?.url ?? 'unknown'));
    lines.push(row('Attestation', `NOT OBSERVED — ${reason}`));
    return lines;
  }

  lines.push(row('Endpoint', runtime.url));
  if (runtime.availability?.state === 'unavailable') {
    lines.push(
      row(
        'Attestation',
        `UNAVAILABLE — ${runtime.availability.detail ?? runtime.availability.reason ?? 'unknown'}`,
      ),
    );
    return lines;
  }

  lines.push(row('Attestation', 'AVAILABLE'));
  lines.push(row('Freshness', (runtime.freshness?.state ?? 'unknown').toUpperCase()));
  lines.push(row('Runtime SHA', shortSha(runtime.commitSha)));
  lines.push(row('Deployment SHA', shortSha(truth.observation?.deployment?.commitSha)));
  lines.push(row('Environment', runtime.environment ?? 'unknown'));
  const required = truth.declaration.requiredEnvironmentVariables;
  const present = required.filter((name) =>
    runtime.environmentVariables?.some((variable) => variable.name === name && variable.present),
  ).length;
  lines.push(row('Required env', `${present} / ${required.length} present`));

  if (truth.declaration.database !== undefined) {
    const connection = runtime.databaseConnection;
    lines.push('', '  Database connection');
    lines.push(subRow('Provider', connection?.provider ?? 'unknown'));
    lines.push(subRow('Target project', connection?.targetProjectRef ?? 'unverified'));
    lines.push(subRow('Declared project', truth.declaration.database.projectRef));
    lines.push(subRow('Probe', (connection?.status ?? 'unavailable').toUpperCase()));
  }

  const deploymentSha = truth.observation?.deployment?.commitSha;
  if (
    runtime.freshness?.state === 'verified' &&
    deploymentSha !== undefined &&
    runtime.commitSha === deploymentSha
  ) {
    lines.push(row('Runtime identity', 'VERIFIED'));
  }
  if (
    required.every((name) =>
      runtime.environmentVariables?.some((variable) => variable.name === name && variable.present),
    )
  ) {
    lines.push(row('Environment vars', 'VERIFIED'));
  }
  const deploymentTarget =
    truth.observation?.deployment?.target ?? truth.declaration.deployment?.target;
  const connection = runtime.databaseConnection;
  const databaseSatisfied =
    truth.declaration.database === undefined ||
    (connection?.identity === 'verified' &&
      connection.targetProjectRef === truth.declaration.database.projectRef &&
      connection.status === 'connected');
  if (
    runtime.freshness?.state === 'verified' &&
    deploymentTarget !== undefined &&
    runtime.environment === deploymentTarget &&
    databaseSatisfied
  ) {
    lines.push(row('Environment isolation', 'VERIFIED'));
  }
  if (truth.declaration.database !== undefined && databaseSatisfied) {
    lines.push(row('Runtime DB connection', 'VERIFIED'));
  }
  return lines;
};

const notCheckedSection = (title: string, provider: string): readonly string[] => [
  title,
  row(provider, 'NOT CHECKED (adapter not implemented)'),
];

/** Formats the human-readable check report; JSON output uses serializeTruthReport instead. */
export const formatCheckReport = (execution: CheckExecution): string => {
  const truth = execution.report.environments[0];
  if (truth === undefined) {
    return 'No environment evaluated.';
  }
  const environment = truth.declaration;
  const lines: string[] = [
    'DeployTruth',
    '',
    `Project: ${execution.report.project}`,
    `Environment: ${execution.environmentId}`,
    '',
  ];

  if (environment.source !== undefined) {
    lines.push(...formatSourceSection(truth, execution.diagnostics));
    if (environment.source.provider === 'github') {
      lines.push('', ...formatGitHubSection(truth, execution.diagnostics));
    }
    lines.push(...formatSourceTruthSummary(truth), '');
  }
  if (environment.deployment !== undefined) {
    if (environment.deployment.provider === 'vercel') {
      lines.push(
        'DEPLOYMENT',
        ...formatVercelSection(truth, execution.diagnostics),
        ...formatDeploymentTruthSummary(truth),
        '',
      );
    } else {
      lines.push(...notCheckedSection('DEPLOYMENT', environment.deployment.provider), '');
    }
  }
  if (environment.database !== undefined) {
    if (environment.database.provider === 'supabase') {
      lines.push(
        'DATABASE',
        ...formatSupabaseSection(truth, execution.diagnostics),
        ...formatDatabaseTruthSummary(truth),
        '',
      );
    } else {
      lines.push(...notCheckedSection('DATABASE', environment.database.provider), '');
    }
  }
  if (environment.runtime !== undefined) {
    lines.push(...formatRuntimeSection(truth, execution.diagnostics), '');
  }

  if (truth.findings.length > 0) {
    lines.push('FINDINGS');
    for (const finding of truth.findings) {
      lines.push(`  [${finding.status}/${finding.severity}] ${finding.code} — ${finding.title}`);
    }
    lines.push('');
  }

  lines.push('VERDICT', `  ${truth.verdict}`);
  if (truth.verdict !== 'PASS') {
    const unavailable = truth.findings
      .filter((finding) => finding.code === 'REQUIRED_OBSERVATION_UNAVAILABLE')
      .flatMap((finding) =>
        Array.isArray(finding.evidence['unavailableChecks'])
          ? finding.evidence['unavailableChecks'].map(String)
          : [],
      );
    if (unavailable.length > 0) {
      lines.push(`  Unverified evidence: ${[...new Set(unavailable)].sort().join(', ')}`);
    }
    const otherReasons = truth.findings
      .filter((finding) => finding.code !== 'REQUIRED_OBSERVATION_UNAVAILABLE')
      .map((finding) => finding.title);
    for (const reason of otherReasons) {
      lines.push(`  ${reason}`);
    }
  }

  return lines.join('\n');
};
