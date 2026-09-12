import type {
  AffectedComponent,
  CheckName,
  DeclaredEnvironment,
  EnvironmentObservation,
  TruthFinding,
} from './domain.js';
import type { TruthContext } from './domain.js';

export interface EnvironmentRuleContext {
  readonly project: TruthContext;
  readonly environment: DeclaredEnvironment;
  readonly observation?: EnvironmentObservation;
  readonly allDeclarations: Readonly<Record<string, DeclaredEnvironment>>;
  readonly allObservations: Readonly<Record<string, EnvironmentObservation>>;
}

export interface TruthRule {
  readonly code: string;
  readonly check?: CheckName;
  readonly evaluate: (context: EnvironmentRuleContext) => readonly TruthFinding[];
}

const component = (
  type: AffectedComponent['type'],
  environment: string,
  identifier?: string,
): AffectedComponent => ({ type, environment, ...(identifier ? { identifier } : {}) });

const finding = (input: TruthFinding): TruthFinding => input;

const isCheckApplicable = (environment: DeclaredEnvironment, check: CheckName): boolean => {
  switch (check) {
    case 'local_git':
      return Boolean(environment.source);
    case 'remote_source':
      return Boolean(environment.source);
    case 'deployment_sha':
      // Applicable whenever a deployment is declared. Its coverage still requires both an
      // authoritative source SHA and a deployment SHA, so a declared deployment without a
      // source can never produce a false PASS — it reports a coverage gap instead.
      return Boolean(environment.deployment);
    case 'migrations':
      return Boolean(environment.database?.migrationDirectory);
    case 'runtime_identity':
      return Boolean(environment.deployment && environment.runtime);
    case 'environment_isolation':
      return Boolean(environment.deployment && environment.database);
    case 'environment_variables':
      return environment.requiredEnvironmentVariables.length > 0;
  }
};

/** Explicit true enables a check even if its declaration is incomplete, so coverage reports it. */
const activeChecks = (environment: DeclaredEnvironment): readonly CheckName[] =>
  (
    [
      'local_git',
      'remote_source',
      'deployment_sha',
      'migrations',
      'runtime_identity',
      'environment_isolation',
      'environment_variables',
    ] as const
  ).filter(
    (check) =>
      environment.checks[check] === true ||
      (environment.checks[check] !== false && isCheckApplicable(environment, check)),
  );

const checkEnabled = (environment: DeclaredEnvironment, check?: CheckName): boolean =>
  !check || activeChecks(environment).includes(check);

/**
 * The best available source SHA. When a remote-authoritative observation exists (ADR 004), only
 * its `remoteHeadSha` counts — an `unavailable` remoteSource must not silently fall back to local
 * evidence, because the declared source is the remote branch, not the local checkout. The local
 * fallbacks (legacy merged field, then HEAD) apply only when no remote observation was produced
 * at all, preserving M0-era fixture semantics (ADR 003).
 */
const sourceSha = (observation?: EnvironmentObservation): string | undefined =>
  observation?.remoteSource !== undefined
    ? observation.remoteSource.remoteHeadSha
    : (observation?.source?.remoteHeadSha ?? observation?.source?.headSha);

const databaseConnection = (observation?: EnvironmentObservation) =>
  observation?.deployment?.connectedResources.find((connection) => connection.type === 'database');

export const dirtyWorktreeRule: TruthRule = {
  code: 'DIRTY_WORKTREE',
  check: 'local_git',
  evaluate: ({ environment, observation }) =>
    observation?.source?.workingTree === 'dirty'
      ? [
          finding({
            code: 'DIRTY_WORKTREE',
            title: 'Local worktree has uncommitted changes',
            description:
              'Local Git state is dirty, so local evidence may not match the deployed commit.',
            severity: 'WARNING',
            status: 'WARN',
            expected: 'clean',
            observed: 'dirty',
            evidence: { branch: observation.source.branch ?? 'unknown' },
            affectedComponents: [component('source', environment.id)],
            remediation:
              'Commit, stash, or explicitly exclude local state before using it as deployment evidence.',
          }),
        ]
      : [],
};

/** Local-Git-only rules guard on the adapter id so remote observations never trigger them. */
const isLocalGitSource = (observation?: EnvironmentObservation): boolean =>
  observation?.source?.provider === 'git';

const sourceComponent = (environment: DeclaredEnvironment): AffectedComponent =>
  component('source', environment.id, environment.source?.repository);

export const repositoryOperationInProgressRule: TruthRule = {
  code: 'REPOSITORY_OPERATION_IN_PROGRESS',
  check: 'local_git',
  evaluate: ({ environment, observation }) => {
    const operations = observation?.source?.operationsInProgress ?? [];
    if (!isLocalGitSource(observation) || operations.length === 0) {
      return [];
    }

    return [
      finding({
        code: 'REPOSITORY_OPERATION_IN_PROGRESS',
        title: 'Repository has an unfinished operation',
        description:
          'A merge, rebase, cherry-pick, revert, or bisect is in progress, so HEAD may not represent a stable source state.',
        severity: 'WARNING',
        status: 'WARN',
        expected: 'normal',
        observed: [...operations].sort(),
        evidence: { operationsInProgress: [...operations].sort() },
        affectedComponents: [sourceComponent(environment)],
        remediation:
          'Finish or abort the in-progress Git operation before treating local state as deployment evidence.',
      }),
    ];
  },
};

export const detachedHeadRule: TruthRule = {
  code: 'DETACHED_HEAD',
  check: 'local_git',
  evaluate: ({ environment, observation }) => {
    const source = observation?.source;
    if (!isLocalGitSource(observation) || source?.detachedHead !== true) {
      return [];
    }

    return [
      finding({
        code: 'DETACHED_HEAD',
        title: 'HEAD is detached',
        description:
          'The repository is checked out at a commit rather than a branch, so local evidence is not tied to a moving branch.',
        severity: 'WARNING',
        status: 'WARN',
        expected: environment.source?.branch ?? 'a checked-out branch',
        observed: source.headSha ?? 'detached',
        evidence: { headSha: source.headSha ?? 'unknown' },
        affectedComponents: [sourceComponent(environment)],
        remediation:
          'Check out the declared branch, or accept that detached HEAD makes branch-based truth checks inconclusive.',
      }),
    ];
  },
};

export const noUpstreamConfiguredRule: TruthRule = {
  code: 'NO_UPSTREAM_CONFIGURED',
  check: 'local_git',
  evaluate: ({ environment, observation }) => {
    const source = observation?.source;
    if (
      !isLocalGitSource(observation) ||
      source?.detachedHead === true ||
      !source?.branch ||
      !source.headSha ||
      source.upstream
    ) {
      return [];
    }

    return [
      finding({
        code: 'NO_UPSTREAM_CONFIGURED',
        title: 'Current branch has no configured upstream',
        description:
          'Without an upstream, DeployTruth cannot compare the local branch to its local remote-tracking ref.',
        severity: 'WARNING',
        status: 'WARN',
        expected: `upstream for ${source.branch}`,
        observed: 'none',
        evidence: { branch: source.branch, remoteNames: [...source.remoteNames].sort() },
        affectedComponents: [sourceComponent(environment)],
        remediation:
          'Set an upstream for the local branch (git branch --set-upstream-to) or accept that drift is unverifiable locally.',
      }),
    ];
  },
};

export const localBranchAheadOfUpstreamRule: TruthRule = {
  code: 'LOCAL_BRANCH_AHEAD_OF_UPSTREAM',
  check: 'local_git',
  evaluate: ({ environment, observation }) => {
    const source = observation?.source;
    if (
      !isLocalGitSource(observation) ||
      source?.upstream === undefined ||
      (source.aheadBy ?? 0) === 0 ||
      (source.behindBy ?? 0) > 0
    ) {
      return [];
    }

    return [
      finding({
        code: 'LOCAL_BRANCH_AHEAD_OF_UPSTREAM',
        title: 'Local branch is ahead of its tracking ref',
        description:
          'Local commits are not represented in the local remote-tracking ref, so deployed state may lag local state.',
        severity: 'INFO',
        status: 'WARN',
        expected: 'aheadBy = 0',
        observed: source.aheadBy,
        evidence: {
          branch: source.branch ?? 'unknown',
          trackingRef: source.upstream.ref,
          aheadBy: source.aheadBy ?? 0,
        },
        affectedComponents: [sourceComponent(environment)],
        remediation:
          'Push or discard the unpushed commits; note the tracking ref only reflects the last local fetch.',
      }),
    ];
  },
};

export const localBranchBehindUpstreamRule: TruthRule = {
  code: 'LOCAL_BRANCH_BEHIND_UPSTREAM',
  check: 'local_git',
  evaluate: ({ environment, observation }) => {
    const source = observation?.source;
    if (
      !isLocalGitSource(observation) ||
      source?.upstream === undefined ||
      (source.behindBy ?? 0) === 0 ||
      (source.aheadBy ?? 0) > 0
    ) {
      return [];
    }

    return [
      finding({
        code: 'LOCAL_BRANCH_BEHIND_UPSTREAM',
        title: 'Local branch is behind its tracking ref',
        description:
          'The local remote-tracking ref contains commits the checked-out branch lacks, so local evidence is stale relative to the last fetch.',
        severity: 'WARNING',
        status: 'WARN',
        expected: 'behindBy = 0',
        observed: source.behindBy,
        evidence: {
          branch: source.branch ?? 'unknown',
          trackingRef: source.upstream.ref,
          behindBy: source.behindBy ?? 0,
        },
        affectedComponents: [sourceComponent(environment)],
        remediation:
          'Integrate the tracked commits locally; the tracking ref reflects the last fetch, not live remote state.',
      }),
    ];
  },
};

export const localBranchDivergedRule: TruthRule = {
  code: 'LOCAL_BRANCH_DIVERGED',
  check: 'local_git',
  evaluate: ({ environment, observation }) => {
    const source = observation?.source;
    if (
      !isLocalGitSource(observation) ||
      source?.upstream === undefined ||
      (source.aheadBy ?? 0) === 0 ||
      (source.behindBy ?? 0) === 0
    ) {
      return [];
    }

    return [
      finding({
        code: 'LOCAL_BRANCH_DIVERGED',
        title: 'Local branch has diverged from its tracking ref',
        description:
          'Both the local branch and the local remote-tracking ref contain unique commits; source identity is ambiguous until reconciled.',
        severity: 'HIGH',
        status: 'WARN',
        expected: 'aheadBy = 0, behindBy = 0',
        observed: `aheadBy = ${source.aheadBy ?? 0}, behindBy = ${source.behindBy ?? 0}`,
        evidence: {
          branch: source.branch ?? 'unknown',
          trackingRef: source.upstream.ref,
          aheadBy: source.aheadBy ?? 0,
          behindBy: source.behindBy ?? 0,
        },
        affectedComponents: [sourceComponent(environment)],
        remediation:
          'Reconcile the divergence (merge or rebase) before relying on local Git state as deployment evidence.',
      }),
    ];
  },
};

/**
 * Remote-source rules compare the local `source` observation against the `remoteSource`
 * observation; the two are never merged. A remote observation only counts as authoritative
 * when its own evidence fields are present — an `availability` failure never fabricates truth.
 */
const isGitHubRemoteSource = (observation?: EnvironmentObservation): boolean =>
  observation?.remoteSource?.provider === 'github';

export const staleTrackingRefRule: TruthRule = {
  code: 'STALE_TRACKING_REF',
  check: 'remote_source',
  evaluate: ({ environment, observation }) => {
    const local = observation?.source;
    const remote = observation?.remoteSource;
    const trackingSha = local?.upstream?.sha;
    const remoteSha = remote?.remoteHeadSha;
    if (local?.provider !== 'git' || trackingSha === undefined || remoteSha === undefined) {
      return [];
    }
    // Tracking refs and remote heads are only comparable for the same branch name; a local
    // feature branch tracking ref must never be compared against the declared remote branch.
    if (local.upstream?.branch !== remote?.branch || trackingSha === remoteSha) {
      return [];
    }

    return [
      finding({
        code: 'STALE_TRACKING_REF',
        title: 'Local remote-tracking ref is stale',
        description:
          'The local remote-tracking ref reflects an earlier fetch and does not match the branch head the remote currently reports.',
        severity: 'WARNING',
        status: 'WARN',
        expected: remoteSha,
        observed: trackingSha,
        evidence: {
          trackingRef: local.upstream?.ref ?? 'unknown',
          trackingSha,
          remoteBranch: remote?.branch ?? 'unknown',
          remoteHeadSha: remoteSha,
          repository: remote?.repository ?? environment.source?.repository ?? 'unknown',
        },
        affectedComponents: [sourceComponent(environment)],
        remediation:
          'Fetch the remote (git fetch) to refresh the local tracking ref before comparing local and remote state.',
      }),
    ];
  },
};

export const localHeadDiffersFromGitHubRule: TruthRule = {
  code: 'LOCAL_HEAD_DIFFERS_FROM_GITHUB',
  check: 'remote_source',
  evaluate: ({ environment, observation }) => {
    const local = observation?.source;
    const remote = observation?.remoteSource;
    const headSha = local?.headSha;
    const remoteSha = remote?.remoteHeadSha;
    if (
      !isGitHubRemoteSource(observation) ||
      headSha === undefined ||
      remoteSha === undefined ||
      headSha === remoteSha
    ) {
      return [];
    }

    // On a different branch (e.g. a feature branch), differing SHAs are expected — that is
    // informational context, not a defect. Same-branch differences deserve a warning.
    const onDeclaredBranch = local?.branch !== undefined && local.branch === remote?.branch;

    return [
      finding({
        code: 'LOCAL_HEAD_DIFFERS_FROM_GITHUB',
        title: onDeclaredBranch
          ? 'Local HEAD differs from the GitHub branch head'
          : 'Local checkout differs from the declared GitHub branch head',
        description: onDeclaredBranch
          ? 'The checked-out declared branch does not match the commit GitHub currently reports for it.'
          : 'The local checkout is not on the declared source branch, so differing SHAs are expected context rather than a defect.',
        severity: onDeclaredBranch ? 'WARNING' : 'INFO',
        status: 'WARN',
        expected: remoteSha,
        observed: headSha,
        evidence: {
          localBranch: local?.branch ?? 'detached',
          remoteBranch: remote?.branch ?? 'unknown',
          localHeadSha: headSha,
          remoteHeadSha: remoteSha,
          repository: remote?.repository ?? environment.source?.repository ?? 'unknown',
        },
        affectedComponents: [sourceComponent(environment)],
        remediation:
          'Confirm whether the local checkout is meant to represent the declared source branch; fetch, pull, or push to reconcile.',
      }),
    ];
  },
};

export const declaredBranchDiffersFromGitHubDefaultRule: TruthRule = {
  code: 'DECLARED_BRANCH_DIFFERS_FROM_GITHUB_DEFAULT',
  check: 'remote_source',
  evaluate: ({ environment, observation }) => {
    const remote = observation?.remoteSource;
    const declaredBranch = environment.source?.branch;
    const defaultBranch = remote?.defaultBranch;
    if (
      !isGitHubRemoteSource(observation) ||
      declaredBranch === undefined ||
      defaultBranch === undefined ||
      declaredBranch === defaultBranch
    ) {
      return [];
    }

    return [
      finding({
        code: 'DECLARED_BRANCH_DIFFERS_FROM_GITHUB_DEFAULT',
        title: 'Declared branch is not the GitHub default branch',
        description:
          'The manifest declares a source branch that differs from the repository default branch; this is often intentional.',
        severity: 'INFO',
        status: 'WARN',
        expected: defaultBranch,
        observed: declaredBranch,
        evidence: {
          declaredBranch,
          defaultBranch,
          repository: remote?.repository ?? environment.source?.repository ?? 'unknown',
        },
        affectedComponents: [sourceComponent(environment)],
        remediation:
          'No action required unless the declared branch was meant to be the repository default.',
      }),
    ];
  },
};

const githubUnavailableEvidence = (
  remote: NonNullable<EnvironmentObservation['remoteSource']>,
): Record<string, string | number> => ({
  repository: remote.repository ?? 'unknown',
  reason: remote.availability?.reason ?? 'unknown',
  ...(remote.availability?.detail ? { detail: remote.availability.detail } : {}),
  ...(remote.availability?.rateLimit?.resetAt
    ? { rateLimitResetAt: remote.availability.rateLimit.resetAt }
    : {}),
  ...(remote.availability?.rateLimit?.remaining !== undefined
    ? { rateLimitRemaining: remote.availability.rateLimit.remaining }
    : {}),
});

export const githubRepositoryUnavailableRule: TruthRule = {
  code: 'GITHUB_REPOSITORY_UNAVAILABLE',
  check: 'remote_source',
  evaluate: ({ environment, observation }) => {
    const remote = observation?.remoteSource;
    if (
      !isGitHubRemoteSource(observation) ||
      remote?.availability?.state !== 'unavailable' ||
      remote.availability.target === 'branch'
    ) {
      return [];
    }

    return [
      finding({
        code: 'GITHUB_REPOSITORY_UNAVAILABLE',
        title: 'GitHub repository could not be authoritatively observed',
        description:
          'GitHub did not return repository metadata; the repository may be absent, renamed, or private without sufficient permission.',
        severity: 'WARNING',
        status: 'WARN',
        expected: 'repository observable',
        observed: remote.availability.reason ?? 'unavailable',
        evidence: githubUnavailableEvidence(remote),
        affectedComponents: [sourceComponent(environment)],
        remediation:
          'Verify the declared owner/repository, configure DEPLOYTRUTH_GITHUB_TOKEN or GITHUB_TOKEN for private repositories, and retry after any rate-limit reset.',
      }),
    ];
  },
};

export const githubBranchUnavailableRule: TruthRule = {
  code: 'GITHUB_BRANCH_UNAVAILABLE',
  check: 'remote_source',
  evaluate: ({ environment, observation }) => {
    const remote = observation?.remoteSource;
    if (
      !isGitHubRemoteSource(observation) ||
      remote?.availability?.state !== 'unavailable' ||
      remote.availability.target !== 'branch'
    ) {
      return [];
    }

    return [
      finding({
        code: 'GITHUB_BRANCH_UNAVAILABLE',
        title: 'GitHub branch could not be authoritatively observed',
        description:
          'GitHub did not return branch metadata for the declared branch; the branch may be absent or access may be restricted.',
        severity: 'WARNING',
        status: 'WARN',
        expected: `branch ${remote?.branch ?? environment.source?.branch ?? 'unknown'} observable`,
        observed: remote.availability.reason ?? 'unavailable',
        evidence: {
          ...githubUnavailableEvidence(remote),
          branch: remote?.branch ?? environment.source?.branch ?? 'unknown',
        },
        affectedComponents: [sourceComponent(environment)],
        remediation:
          'Verify the declared branch exists on the remote and that the configured credentials can read it.',
      }),
    ];
  },
};

export const deploymentShaMismatchRule: TruthRule = {
  code: 'DEPLOYMENT_SHA_MISMATCH',
  check: 'deployment_sha',
  evaluate: ({ environment, observation }) => {
    const expected = sourceSha(observation);
    const observed = observation?.deployment?.commitSha;
    if (!expected || !observed || expected === observed) {
      return [];
    }

    return [
      finding({
        code: 'DEPLOYMENT_SHA_MISMATCH',
        title: 'Deployment SHA does not match source SHA',
        description:
          'The active production deployment was built from a different source commit than the declared source branch. An intentional rollback still produces this finding; the declaration describes the expected source.',
        severity: 'HIGH',
        status: 'FAIL',
        expected,
        observed,
        evidence: {
          sourceSha: expected,
          deploymentSha: observed,
          ...(observation?.deployment?.deploymentId !== undefined
            ? { deploymentId: observation.deployment.deploymentId }
            : {}),
          ...(observation?.deployment?.state !== undefined
            ? { deploymentState: observation.deployment.state }
            : {}),
        },
        affectedComponents: [
          component('source', environment.id),
          component('deployment', environment.id),
        ],
        remediation:
          'Confirm the target branch and redeploy the expected commit, or update the declared branch if the rollback is intentional.',
      }),
    ];
  },
};

/**
 * True when deployment evidence exists and the control plane was actually observed — either
 * explicitly `available`, or a pre-M3 legacy observation with no availability record.
 */
const deploymentObserved = (observation?: EnvironmentObservation): boolean =>
  observation?.deployment !== undefined &&
  observation.deployment.availability?.state !== 'unavailable';

export const deploymentSourceUnverifiedRule: TruthRule = {
  code: 'DEPLOYMENT_SOURCE_UNVERIFIED',
  check: 'deployment_sha',
  evaluate: ({ environment, observation }) => {
    const deployment = observation?.deployment;
    if (!deploymentObserved(observation) || deployment?.commitSha !== undefined) {
      return [];
    }

    return [
      finding({
        code: 'DEPLOYMENT_SOURCE_UNVERIFIED',
        title: 'Deployment source commit could not be verified',
        description:
          'The deployment provider did not report a trustworthy source commit for the active production deployment, so deployment SHA truth cannot be established.',
        severity: 'WARNING',
        status: 'WARN',
        expected: 'deployment source commit SHA observable',
        observed: 'source metadata unavailable',
        evidence: {
          deploymentId: deployment?.deploymentId ?? 'unknown',
          provider: deployment?.provider ?? 'unknown',
        },
        affectedComponents: [component('deployment', environment.id)],
        remediation:
          'Confirm the production deployment was created from a connected Git repository so its source commit is recorded by the provider.',
      }),
    ];
  },
};

const isVercelDeployment = (observation?: EnvironmentObservation): boolean =>
  observation?.deployment?.provider === 'vercel';

const vercelUnavailableEvidence = (
  deployment: NonNullable<EnvironmentObservation['deployment']>,
): Record<string, string | number> => ({
  project: deployment.project ?? 'unknown',
  reason: deployment.availability?.reason ?? 'unknown',
  ...(deployment.availability?.detail ? { detail: deployment.availability.detail } : {}),
  ...(deployment.availability?.rateLimit?.resetAt
    ? { rateLimitResetAt: deployment.availability.rateLimit.resetAt }
    : {}),
  ...(deployment.availability?.rateLimit?.remaining !== undefined
    ? { rateLimitRemaining: deployment.availability.rateLimit.remaining }
    : {}),
  ...(deployment.availability?.rateLimit?.retryAfter !== undefined
    ? { retryAfterSeconds: deployment.availability.rateLimit.retryAfter }
    : {}),
});

export const vercelProjectUnavailableRule: TruthRule = {
  code: 'VERCEL_PROJECT_UNAVAILABLE',
  check: 'deployment_sha',
  evaluate: ({ environment, observation }) => {
    const deployment = observation?.deployment;
    if (
      !isVercelDeployment(observation) ||
      deployment?.availability?.state !== 'unavailable' ||
      deployment.availability.target === 'deployment'
    ) {
      return [];
    }

    return [
      finding({
        code: 'VERCEL_PROJECT_UNAVAILABLE',
        title: 'Vercel project could not be observed',
        description:
          'Vercel did not return project metadata; the project may be renamed, the scope may be wrong, credentials may be missing or insufficient, or the API may be unavailable.',
        severity: 'WARNING',
        status: 'WARN',
        expected: 'project observable',
        observed: deployment.availability.reason ?? 'unavailable',
        evidence: vercelUnavailableEvidence(deployment),
        affectedComponents: [component('deployment', environment.id)],
        remediation:
          'Verify the declared project and optional scope, configure DEPLOYTRUTH_VERCEL_TOKEN or VERCEL_TOKEN, and retry after any rate-limit reset.',
      }),
    ];
  },
};

export const vercelProductionDeploymentUnavailableRule: TruthRule = {
  code: 'VERCEL_PRODUCTION_DEPLOYMENT_UNAVAILABLE',
  check: 'deployment_sha',
  evaluate: ({ environment, observation }) => {
    const deployment = observation?.deployment;
    if (
      !isVercelDeployment(observation) ||
      deployment?.availability?.state !== 'unavailable' ||
      deployment.availability.target !== 'deployment'
    ) {
      return [];
    }

    return [
      finding({
        code: 'VERCEL_PRODUCTION_DEPLOYMENT_UNAVAILABLE',
        title: 'Current Vercel production deployment could not be determined',
        description:
          'The project was observed, but Vercel control-plane evidence did not identify which deployment is currently serving production (for example, no production domain is assigned to a deployment).',
        severity: 'WARNING',
        status: 'WARN',
        expected: 'current production deployment identifiable',
        observed: deployment.availability.reason ?? 'unavailable',
        evidence: vercelUnavailableEvidence(deployment),
        affectedComponents: [component('deployment', environment.id)],
        remediation:
          'Confirm the project has a production domain assigned to a deployment, then retry the observation.',
      }),
    ];
  },
};

export const deploymentNotReadyRule: TruthRule = {
  code: 'DEPLOYMENT_NOT_READY',
  check: 'deployment_sha',
  evaluate: ({ environment, observation }) => {
    const state = observation?.deployment?.state;
    if (
      !deploymentObserved(observation) ||
      state === undefined ||
      !['building', 'queued', 'unknown'].includes(state)
    ) {
      return [];
    }

    return [
      finding({
        code: 'DEPLOYMENT_NOT_READY',
        title: 'Production deployment is not in a ready state',
        description:
          'The deployment currently assigned to production is still building, queued, or in a state the provider did not clearly report as ready.',
        severity: 'WARNING',
        status: 'WARN',
        expected: 'ready',
        observed: state,
        evidence: {
          deploymentId: observation?.deployment?.deploymentId ?? 'unknown',
          state,
        },
        affectedComponents: [component('deployment', environment.id)],
        remediation:
          'Wait for the deployment to finish or investigate why the production deployment has not reached a ready state.',
      }),
    ];
  },
};

export const deploymentFailedRule: TruthRule = {
  code: 'DEPLOYMENT_FAILED',
  check: 'deployment_sha',
  evaluate: ({ environment, observation }) => {
    const state = observation?.deployment?.state;
    if (!deploymentObserved(observation) || !['error', 'canceled'].includes(state ?? '')) {
      return [];
    }

    return [
      finding({
        code: 'DEPLOYMENT_FAILED',
        title: 'Production deployment is in a failed state',
        description:
          'The deployment currently assigned to production reports an error or canceled state; production may not be serving the expected build.',
        severity: 'HIGH',
        status: 'FAIL',
        expected: 'ready',
        observed: state,
        evidence: {
          deploymentId: observation?.deployment?.deploymentId ?? 'unknown',
          state: state ?? 'unknown',
        },
        affectedComponents: [component('deployment', environment.id)],
        remediation:
          'Investigate the failed production deployment and promote a healthy build through the provider console.',
      }),
    ];
  },
};

export const stableDomainStaleRule: TruthRule = {
  code: 'STABLE_DOMAIN_STALE',
  check: 'deployment_sha',
  evaluate: ({ environment, observation }) => {
    const declaredDomain = environment.deployment?.domain;
    const deployment = observation?.deployment;
    if (declaredDomain === undefined || !deploymentObserved(observation)) {
      return [];
    }
    const verified = deployment?.stableDomainVerified;
    if (verified === true) {
      return [];
    }

    if (verified === false) {
      return [
        finding({
          code: 'STABLE_DOMAIN_STALE',
          title: 'Declared stable domain does not resolve to the production deployment',
          description:
            'Provider control-plane evidence shows the declared stable domain is not assigned to the deployment currently serving production.',
          severity: 'HIGH',
          status: 'FAIL',
          expected: `${declaredDomain} -> ${deployment?.deploymentId ?? 'current production deployment'}`,
          observed: 'domain resolves elsewhere or is not assigned',
          evidence: {
            domain: declaredDomain,
            deploymentId: deployment?.deploymentId ?? 'unknown',
          },
          affectedComponents: [component('deployment', environment.id)],
          remediation:
            'Verify the domain assignment in the deployment provider console so the stable domain serves the current production deployment.',
        }),
      ];
    }

    return [
      finding({
        code: 'STABLE_DOMAIN_STALE',
        title: 'Declared stable domain could not be verified',
        description:
          'The declared stable domain is configured, but provider evidence could not confirm it resolves to the current production deployment.',
        severity: 'WARNING',
        status: 'WARN',
        expected: `${declaredDomain} verifiable`,
        observed: 'verification inconclusive',
        evidence: { domain: declaredDomain },
        affectedComponents: [component('deployment', environment.id)],
        remediation:
          'Confirm the domain is assigned to this project and points at the current production deployment.',
      }),
    ];
  },
};

export const wrongDatabaseProjectRule: TruthRule = {
  code: 'WRONG_DATABASE_PROJECT',
  check: 'environment_isolation',
  evaluate: ({ environment, observation }) => {
    const expected = environment.database?.projectRef;
    const observed = databaseConnection(observation)?.identifier;
    if (!expected || !observed || expected === observed) {
      return [];
    }

    return [
      finding({
        code: 'WRONG_DATABASE_PROJECT',
        title: 'Deployment is connected to the wrong database project',
        description:
          'The observed database connection does not match the database declared for this environment.',
        severity: 'HIGH',
        status: 'FAIL',
        expected,
        observed,
        evidence: { expectedProjectRef: expected, observedProjectRef: observed },
        affectedComponents: [
          component('deployment', environment.id),
          component('database', environment.id),
        ],
        remediation:
          'Correct the deployment environment configuration and redeploy after verifying the intended project ref.',
      }),
    ];
  },
};

export const previewUsesProductionDatabaseRule: TruthRule = {
  code: 'PREVIEW_USES_PRODUCTION_DATABASE',
  check: 'environment_isolation',
  evaluate: ({ environment, observation, allDeclarations }) => {
    if (environment.kind !== 'preview') {
      return [];
    }

    const productionDatabase = Object.values(allDeclarations).find(
      (candidate) => candidate.kind === 'production',
    )?.database?.projectRef;
    const observed = databaseConnection(observation)?.identifier;
    if (!productionDatabase || !observed || productionDatabase !== observed) {
      return [];
    }

    return [
      finding({
        code: 'PREVIEW_USES_PRODUCTION_DATABASE',
        title: 'Preview deployment is connected to the production database',
        description: 'A preview environment must not use the database declared for production.',
        severity: 'CRITICAL',
        status: 'FAIL',
        expected: environment.database?.projectRef ?? 'non-production database',
        observed,
        evidence: { productionProjectRef: productionDatabase, previewEnvironment: environment.id },
        affectedComponents: [
          component('deployment', environment.id),
          component('database', environment.id),
        ],
        remediation:
          'Assign an isolated preview database project and redeploy the preview environment.',
      }),
    ];
  },
};

export const databaseMigrationsBehindRule: TruthRule = {
  code: 'DATABASE_MIGRATIONS_BEHIND',
  check: 'migrations',
  evaluate: ({ environment, observation }) => {
    const expected = observation?.repositoryMigrations?.migrationIds;
    const applied = new Set(observation?.database?.appliedMigrationIds ?? []);
    if (!expected || !observation?.database) {
      return [];
    }

    const missing = expected.filter((migrationId) => !applied.has(migrationId));
    if (missing.length === 0) {
      return [];
    }

    return [
      finding({
        code: 'DATABASE_MIGRATIONS_BEHIND',
        title: 'Database migrations are behind the repository',
        description:
          'One or more repository migrations are not reported as applied to the observed database.',
        severity: 'HIGH',
        status: 'FAIL',
        expected,
        observed: [...applied].sort(),
        evidence: { missingMigrationIds: missing.sort() },
        affectedComponents: [
          component('source', environment.id),
          component('database', environment.id),
        ],
        remediation:
          'Review the missing migrations and apply them through the project’s approved migration workflow.',
      }),
    ];
  },
};

export const runtimeShaMismatchRule: TruthRule = {
  code: 'RUNTIME_SHA_MISMATCH',
  check: 'runtime_identity',
  evaluate: ({ environment, observation }) => {
    const expected = observation?.deployment?.commitSha;
    const observed = observation?.runtime?.commitSha;
    if (!expected || !observed || expected === observed) {
      return [];
    }

    return [
      finding({
        code: 'RUNTIME_SHA_MISMATCH',
        title: 'Runtime SHA does not match deployment SHA',
        description:
          'The runtime identity endpoint reports a different commit than the deployment control plane.',
        severity: 'HIGH',
        status: 'FAIL',
        expected,
        observed,
        evidence: { deploymentSha: expected, runtimeSha: observed },
        affectedComponents: [
          component('deployment', environment.id),
          component('runtime', environment.id),
        ],
        remediation:
          'Verify routing and caching, then redeploy the expected build or correct the runtime identity endpoint.',
      }),
    ];
  },
};

export const environmentIdentityMismatchRule: TruthRule = {
  code: 'ENVIRONMENT_IDENTITY_MISMATCH',
  check: 'runtime_identity',
  evaluate: ({ environment, observation }) => {
    const expected = environment.runtime?.expectedEnvironment ?? environment.id;
    const observed = observation?.runtime?.environment;
    if (!observed || expected === observed) {
      return [];
    }

    return [
      finding({
        code: 'ENVIRONMENT_IDENTITY_MISMATCH',
        title: 'Runtime reports the wrong environment identity',
        description:
          'The runtime identity endpoint does not identify itself as the declared environment.',
        severity: 'HIGH',
        status: 'FAIL',
        expected,
        observed,
        evidence: { runtimeUrl: environment.runtime?.url ?? 'not-declared' },
        affectedComponents: [component('runtime', environment.id)],
        remediation:
          'Correct the build-time environment identity and verify the deployed runtime endpoint.',
      }),
    ];
  },
};

export const environmentVariableMissingRule: TruthRule = {
  code: 'ENVIRONMENT_VARIABLE_MISSING',
  check: 'environment_variables',
  evaluate: ({ environment, observation }) => {
    if (
      environment.requiredEnvironmentVariables.length === 0 ||
      observation?.deployment?.environmentVariables === undefined
    ) {
      return [];
    }

    const present = new Map(
      observation.deployment.environmentVariables.map((variable) => [
        variable.name,
        variable.present,
      ]),
    );
    const missing = environment.requiredEnvironmentVariables.filter(
      (name) => present.get(name) !== true,
    );
    if (missing.length === 0) {
      return [];
    }

    return [
      finding({
        code: 'ENVIRONMENT_VARIABLE_MISSING',
        title: 'Required environment variable is missing',
        description:
          'The deployment provider did not report all variables declared as required for this environment.',
        severity: 'HIGH',
        status: 'FAIL',
        expected: environment.requiredEnvironmentVariables,
        observed: [...present.entries()]
          .filter(([, isPresent]) => isPresent)
          .map(([name]) => name)
          .sort(),
        evidence: { missingVariableNames: missing.sort() },
        affectedComponents: [component('deployment', environment.id)],
        remediation:
          'Add the missing variable through the provider console or approved configuration workflow, then redeploy.',
      }),
    ];
  },
};

const checkCoverage = (
  check: CheckName,
  environment: DeclaredEnvironment,
  observation?: EnvironmentObservation,
): boolean => {
  switch (check) {
    case 'local_git':
      return Boolean(observation?.source);
    case 'remote_source':
      return observation?.remoteSource?.availability?.state === 'available';
    case 'deployment_sha':
      return Boolean(sourceSha(observation) && observation?.deployment?.commitSha);
    case 'migrations':
      return Boolean(observation?.repositoryMigrations && observation.database);
    case 'runtime_identity':
      return Boolean(observation?.deployment?.commitSha && observation.runtime?.commitSha);
    case 'environment_isolation':
      return Boolean(environment.database?.projectRef && databaseConnection(observation));
    case 'environment_variables':
      return (
        environment.requiredEnvironmentVariables.length === 0 ||
        Boolean(observation?.deployment?.environmentVariables)
      );
  }
};

export const requiredObservationAvailableRule: TruthRule = {
  code: 'REQUIRED_OBSERVATION_UNAVAILABLE',
  evaluate: ({ environment, observation }) => {
    const enabledChecks = activeChecks(environment);
    const unavailableChecks = enabledChecks.filter(
      (check) => !checkCoverage(check, environment, observation),
    );
    if (unavailableChecks.length === 0) {
      return [];
    }

    return [
      finding({
        code: 'REQUIRED_OBSERVATION_UNAVAILABLE',
        title: 'A required observation was unavailable',
        description:
          'DeployTruth cannot claim a fully verified PASS while an enabled check lacks evidence.',
        severity: 'WARNING',
        status: 'WARN',
        expected: [...enabledChecks].sort(),
        observed: enabledChecks.filter((check) => !unavailableChecks.includes(check)).sort(),
        evidence: { unavailableChecks: unavailableChecks.sort() },
        affectedComponents: [component('deployment', environment.id)],
        remediation:
          'Supply the required read-only provider access or disable only checks that are intentionally out of scope.',
      }),
    ];
  },
};

export const defaultRules: readonly TruthRule[] = [
  requiredObservationAvailableRule,
  dirtyWorktreeRule,
  repositoryOperationInProgressRule,
  detachedHeadRule,
  noUpstreamConfiguredRule,
  localBranchAheadOfUpstreamRule,
  localBranchBehindUpstreamRule,
  localBranchDivergedRule,
  staleTrackingRefRule,
  localHeadDiffersFromGitHubRule,
  declaredBranchDiffersFromGitHubDefaultRule,
  githubRepositoryUnavailableRule,
  githubBranchUnavailableRule,
  deploymentShaMismatchRule,
  deploymentSourceUnverifiedRule,
  vercelProjectUnavailableRule,
  vercelProductionDeploymentUnavailableRule,
  deploymentNotReadyRule,
  deploymentFailedRule,
  stableDomainStaleRule,
  wrongDatabaseProjectRule,
  previewUsesProductionDatabaseRule,
  databaseMigrationsBehindRule,
  runtimeShaMismatchRule,
  environmentIdentityMismatchRule,
  environmentVariableMissingRule,
];

export const evaluateRules = (
  context: EnvironmentRuleContext,
  rules: readonly TruthRule[] = defaultRules,
): readonly TruthFinding[] =>
  rules
    .filter((rule) => checkEnabled(context.environment, rule.check))
    .flatMap((rule) => rule.evaluate(context))
    .sort((left, right) => left.code.localeCompare(right.code));
