import { dirname } from 'node:path';

import {
  evaluateTruth,
  redactText,
  type DeploymentObservation,
  type EnvironmentTruth,
  type ProjectDeclaration,
  type SourceObservation,
  type TruthReport,
} from '@deploytruth/core';
import { ConfigError, loadDeployTruthManifest } from '@deploytruth/config';
import {
  GitError,
  createGitHubProvider,
  createVercelProvider,
  localGitProvider,
  type GitHubSourceConfig,
  type TruthProvider,
  type LocalGitConfig,
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

/**
 * Loads the manifest, observes local Git truth, remote-authoritative source truth (GitHub when
 * declared), and deployment truth (Vercel when declared) for the selected environment, then
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

  const pending: Promise<void>[] = [];

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
    lines.push(...notCheckedSection('DATABASE', environment.database.provider), '');
  }
  if (environment.runtime !== undefined) {
    lines.push(...notCheckedSection('RUNTIME', 'runtime endpoint'), '');
  }
  if (environment.requiredEnvironmentVariables.length > 0) {
    lines.push(
      ...notCheckedSection(
        'ENVIRONMENT VARIABLES',
        `${environment.requiredEnvironmentVariables.length} required`,
      ),
      '',
    );
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
