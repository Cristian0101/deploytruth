import { dirname } from 'node:path';

import {
  evaluateTruth,
  redactText,
  type EnvironmentTruth,
  type ProjectDeclaration,
  type SourceObservation,
  type TruthReport,
} from '@deploytruth/core';
import { ConfigError, loadDeployTruthManifest } from '@deploytruth/config';
import {
  GitError,
  localGitProvider,
  type TruthProvider,
  type LocalGitConfig,
} from '@deploytruth/providers';

export interface CheckOptions {
  readonly configPath: string;
  readonly environmentName?: string;
  readonly strict?: boolean;
  /** Injectable for tests; defaults to the execFile-based local Git adapter. */
  readonly gitProvider?: TruthProvider<LocalGitConfig, SourceObservation>;
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

/**
 * Loads the manifest, observes local Git truth for the selected environment when a source is
 * declared, and evaluates the deterministic rule set. Missing provider evidence remains an
 * explicit UNKNOWN/WARN signal; it never produces a false PASS.
 */
export const runEnvironmentCheck = async (options: CheckOptions): Promise<CheckExecution> => {
  const manifest = await loadDeployTruthManifest(options.configPath);
  const { id: environmentId } = selectEnvironment(manifest, options.environmentName);
  const environment = manifest.environments[environmentId];
  const diagnostics: string[] = [];

  let source: SourceObservation | undefined;
  if (environment?.source !== undefined) {
    const provider = options.gitProvider ?? localGitProvider;
    const result = await observeLocalGit(provider, {
      project: manifest.project,
      environment: environmentId,
      directory: dirname(options.configPath),
    });
    source = result.observation;
    if (result.diagnostic !== undefined) {
      diagnostics.push(`local-git: ${result.diagnostic}`);
    }
  }

  const report = evaluateTruth(
    {
      declaration: manifest,
      observations: {
        project: manifest.project,
        environments: {
          [environmentId]: {
            environment: environmentId,
            ...(source !== undefined ? { source } : {}),
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
    lines.push(...formatSourceSection(truth, execution.diagnostics), '');
  }
  if (environment.deployment !== undefined) {
    lines.push(...notCheckedSection('DEPLOYMENT', environment.deployment.provider), '');
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
