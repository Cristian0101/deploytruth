import type {
  AffectedComponent,
  CheckName,
  DeclaredEnvironment,
  EnvironmentObservation,
  SafeValue,
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
      return Boolean(environment.deployment && (environment.runtime || environment.database));
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
  observation?.deployment?.connectedResources?.find((connection) => connection.type === 'database');

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
): Record<string, SafeValue> => ({
  project: deployment.project ?? 'unknown',
  ...(deployment.stableDomain !== undefined ? { declaredDomain: deployment.stableDomain } : {}),
  ...(deployment.productionAssignments !== undefined && deployment.productionAssignments.length > 0
    ? {
        productionAssignments: deployment.productionAssignments.map((assignment) => ({
          domain: assignment.domain,
          deploymentId: assignment.deploymentId,
        })),
      }
    : {}),
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
      deployment.availability.target !== 'deployment' ||
      // Divergent production aliases without a declared domain are a distinct finding.
      deployment.availability.reason === 'ambiguous'
    ) {
      return [];
    }

    return [
      finding({
        code: 'VERCEL_PRODUCTION_DEPLOYMENT_UNAVAILABLE',
        title: 'Current Vercel production deployment could not be determined',
        description:
          'The project was observed, but Vercel control-plane evidence did not identify which deployment is currently serving production (for example, no production domain is assigned to a deployment, or the declared domain is not assigned to one).',
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

/**
 * Divergent production aliases with no declared authoritative domain. DeployTruth prefers
 * UNKNOWN over assumption: production is only ever resolved from an explicitly declared
 * domain or from unanimous production aliases — never by majority, recency, or tie-break
 * (ADR 005). The observation carries the normalized domain→deployment assignments as
 * evidence and no deployment id or commit SHA, so deployment SHA checks cannot evaluate
 * from a guessed deployment.
 */
export const vercelProductionRoutingAmbiguousRule: TruthRule = {
  code: 'VERCEL_PRODUCTION_ROUTING_AMBIGUOUS',
  check: 'deployment_sha',
  evaluate: ({ environment, observation }) => {
    const deployment = observation?.deployment;
    if (
      !isVercelDeployment(observation) ||
      deployment?.availability?.state !== 'unavailable' ||
      deployment.availability.reason !== 'ambiguous'
    ) {
      return [];
    }

    const assignments = deployment.productionAssignments ?? [];
    const deploymentIds = [
      ...new Set(assignments.map((assignment) => assignment.deploymentId)),
    ].sort();

    return [
      finding({
        code: 'VERCEL_PRODUCTION_ROUTING_AMBIGUOUS',
        title: 'Vercel production routing is ambiguous',
        description:
          'Observed production domains resolve to different deployments and the manifest does not declare an authoritative production domain. DeployTruth reports the ambiguity instead of guessing which deployment serves production.',
        severity: 'WARNING',
        status: 'WARN',
        expected: 'one deployment serving all production domains',
        observed: deploymentIds,
        evidence: {
          project: deployment.project ?? 'unknown',
          productionAssignments: assignments.map((assignment) => ({
            domain: assignment.domain,
            deploymentId: assignment.deploymentId,
          })),
        },
        affectedComponents: [component('deployment', environment.id)],
        remediation:
          'Declare the authoritative production domain in the manifest (deployment.domain), or reconcile the production domain assignments in the Vercel console so every production domain resolves to the same deployment.',
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

/**
 * Fires whenever any evidence source shows a definitive database-project mismatch: the
 * deployment-reported connection (environment_isolation evidence) or the observed database
 * connection identity itself (M4). It carries no check gate because it only produces a
 * finding on positive mismatch evidence — coverage is owned by the migrations and
 * environment_isolation checks.
 */
export const wrongDatabaseProjectRule: TruthRule = {
  code: 'WRONG_DATABASE_PROJECT',
  evaluate: ({ environment, observation }) => {
    const expected = environment.database?.projectRef;
    if (!expected) {
      return [];
    }

    const viaDeployment = databaseConnection(observation)?.identifier;
    const viaConnection = observation?.database?.observedProjectRef;
    const mismatches = [
      ...(viaConnection !== undefined && viaConnection !== expected
        ? ['database-connection' as const]
        : []),
      ...(viaDeployment !== undefined && viaDeployment !== expected
        ? ['deployment-connection' as const]
        : []),
    ];
    if (mismatches.length === 0) {
      return [];
    }

    const observed =
      viaConnection !== undefined && viaConnection !== expected ? viaConnection : viaDeployment;
    return [
      finding({
        code: 'WRONG_DATABASE_PROJECT',
        title: 'The observed database is not the declared project',
        description:
          'Observed database identity evidence does not match the database project declared for this environment.',
        severity: 'HIGH',
        status: 'FAIL',
        expected,
        observed,
        evidence: {
          expectedProjectRef: expected,
          observedProjectRef: observed ?? 'unknown',
          evidenceSources: mismatches,
        },
        affectedComponents: [
          component('deployment', environment.id),
          component('database', environment.id),
        ],
        remediation:
          'Correct the database connection and deployment environment configuration, then verify the intended project ref.',
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

const isSupabaseDatabase = (observation?: EnvironmentObservation): boolean =>
  observation?.database?.provider === 'supabase';

const supabaseUnavailableEvidence = (
  availability:
    | NonNullable<EnvironmentObservation['database']>['controlPlane']
    | NonNullable<EnvironmentObservation['database']>['connection']
    | NonNullable<EnvironmentObservation['database']>['migrationHistory'],
): Record<string, SafeValue> => ({
  reason: availability?.reason ?? 'unknown',
  ...(availability !== undefined && 'detail' in availability && availability.detail !== undefined
    ? { detail: availability.detail }
    : {}),
  // Endpoint-derived target evidence, clearly labeled: never an observed identity claim.
  ...(availability !== undefined &&
  'targetProjectRef' in availability &&
  availability.targetProjectRef !== undefined
    ? { connectionTargetRef: availability.targetProjectRef }
    : {}),
  ...(availability !== undefined &&
  'rateLimit' in availability &&
  availability.rateLimit?.resetAt !== undefined
    ? { rateLimitResetAt: availability.rateLimit.resetAt }
    : {}),
});

export const supabaseProjectUnavailableRule: TruthRule = {
  code: 'SUPABASE_PROJECT_UNAVAILABLE',
  check: 'migrations',
  evaluate: ({ environment, observation }) => {
    const controlPlane = observation?.database?.controlPlane;
    if (
      environment.database?.provider !== 'supabase' ||
      !isSupabaseDatabase(observation) ||
      controlPlane?.state !== 'unavailable'
    ) {
      return [];
    }

    return [
      finding({
        code: 'SUPABASE_PROJECT_UNAVAILABLE',
        title: 'Supabase project could not be authoritatively observed',
        description:
          'The Supabase Management API did not return control-plane metadata for the declared project; it may be absent, renamed, or not accessible to the configured credentials.',
        severity: 'WARNING',
        status: 'WARN',
        expected: 'project observable',
        observed: controlPlane.reason ?? 'unavailable',
        evidence: {
          projectRef: observation?.database?.projectRef ?? environment.database.projectRef,
          ...supabaseUnavailableEvidence(controlPlane),
        },
        affectedComponents: [component('database', environment.id)],
        remediation:
          'Verify the declared project_ref, configure DEPLOYTRUTH_SUPABASE_ACCESS_TOKEN or SUPABASE_ACCESS_TOKEN, and retry after any rate-limit reset.',
      }),
    ];
  },
};

export const databaseConnectionUnavailableRule: TruthRule = {
  code: 'DATABASE_CONNECTION_UNAVAILABLE',
  check: 'migrations',
  evaluate: ({ environment, observation }) => {
    const connection = observation?.database?.connection;
    if (!isSupabaseDatabase(observation) || connection?.state !== 'unavailable') {
      return [];
    }

    return [
      finding({
        code: 'DATABASE_CONNECTION_UNAVAILABLE',
        title: 'Database connection could not be established',
        description:
          'DeployTruth could not open a read-only PostgreSQL session against the configured database endpoint, so database identity and migration history are unobserved.',
        severity: 'WARNING',
        status: 'WARN',
        expected: 'database connection observable',
        observed: connection.reason ?? 'unavailable',
        evidence: supabaseUnavailableEvidence(connection),
        affectedComponents: [component('database', environment.id)],
        remediation:
          'Set DEPLOYTRUTH_SUPABASE_DATABASE_URL to a valid Supabase connection string and verify network/TLS access to the database endpoint.',
      }),
    ];
  },
};

export const databaseIdentityUnverifiedRule: TruthRule = {
  code: 'DATABASE_IDENTITY_UNVERIFIED',
  check: 'migrations',
  evaluate: ({ environment, observation }) => {
    const database = observation?.database;
    if (
      !isSupabaseDatabase(observation) ||
      database?.connection?.state !== 'available' ||
      database.identity !== 'unverified'
    ) {
      return [];
    }

    return [
      finding({
        code: 'DATABASE_IDENTITY_UNVERIFIED',
        title: 'Database identity cannot be tied to the declared project',
        description:
          'The PostgreSQL connection succeeded, but the connection endpoint does not expose a deterministic Supabase project ref. The reachable database may not be the declared project.',
        severity: 'WARNING',
        status: 'WARN',
        expected: `project ${environment.database?.projectRef ?? 'declared'}`,
        observed: 'identity unverifiable from connection endpoint',
        evidence: {
          declaredProjectRef: environment.database?.projectRef ?? 'unknown',
        },
        affectedComponents: [component('database', environment.id)],
        remediation:
          'Use an official Supabase connection string (db.<ref>.supabase.co or a *.pooler.supabase.com pooler username) so the database can be attributed to a project.',
      }),
    ];
  },
};

/**
 * Catalog reasons that mean the source exists but cannot be interpreted as a valid Supabase
 * migration set; every other unavailability degrades to MIGRATION_SOURCE_UNAVAILABLE.
 */
const INVALID_CATALOG_REASONS = new Set([
  'directory_missing',
  'not_a_directory',
  'duplicate_versions',
  'invalid_filenames',
]);

type MigrationSourceState =
  | { readonly state: 'authoritative'; readonly sourceSha?: string }
  | {
      readonly state: 'invalid';
      readonly catalog: NonNullable<EnvironmentObservation['repositoryMigrations']>;
    }
  | {
      readonly state: 'unavailable';
      readonly detail: string;
      readonly evidence: Record<string, SafeValue>;
    };

/**
 * Whether the observed migration catalog can stand in for the declared source. When a remote
 * source is declared, the local Git tree is authoritative only while its commit equals the
 * remote-authoritative head; an unobserved remote never falls back to local evidence
 * (ADR 004). Without a remote source, the committed local tree is the source authority.
 */
const migrationSourceState = (
  environment: DeclaredEnvironment,
  observation?: EnvironmentObservation,
): MigrationSourceState => {
  const catalog = observation?.repositoryMigrations;
  if (catalog === undefined) {
    return {
      state: 'unavailable',
      detail: 'The expected migration catalog was not observed.',
      evidence: {},
    };
  }

  if (catalog.availability?.state === 'unavailable') {
    if (INVALID_CATALOG_REASONS.has(catalog.availability.reason ?? '')) {
      return { state: 'invalid', catalog };
    }
    return {
      state: 'unavailable',
      detail: catalog.availability.detail ?? 'The migration catalog could not be read.',
      evidence: {
        directory: catalog.directory,
        reason: catalog.availability.reason ?? 'unknown',
      },
    };
  }

  // Pre-M4 catalog evidence carries no availability record; it is trusted as before.
  if (environment.source === undefined) {
    return {
      state: 'authoritative',
      ...(catalog.sourceSha !== undefined ? { sourceSha: catalog.sourceSha } : {}),
    };
  }

  const remote = observation?.remoteSource;
  if (remote === undefined) {
    return {
      state: 'unavailable',
      detail:
        'A remote source is declared but no remote-authoritative observation exists; the local migration tree cannot be certified.',
      evidence: { repository: environment.source.repository ?? 'unknown' },
    };
  }
  if (remote.availability?.state !== 'available' || remote.remoteHeadSha === undefined) {
    return {
      state: 'unavailable',
      detail:
        'The remote source authority could not be observed; the local migration tree cannot be certified as the declared source.',
      evidence: {
        repository: remote.repository ?? environment.source.repository ?? 'unknown',
        reason: remote.availability?.reason ?? 'unknown',
      },
    };
  }
  if (catalog.sourceSha === undefined) {
    return {
      state: 'unavailable',
      detail:
        'The migration catalog does not record the commit it was read from, so it cannot be tied to the authoritative source.',
      evidence: { remoteHeadSha: remote.remoteHeadSha },
    };
  }
  if (catalog.sourceSha !== remote.remoteHeadSha) {
    return {
      state: 'unavailable',
      detail:
        'The local repository does not represent the authoritative source commit, so its migration tree cannot stand in for it.',
      evidence: {
        localHeadSha: catalog.sourceSha,
        remoteHeadSha: remote.remoteHeadSha,
        repository: remote.repository ?? environment.source.repository ?? 'unknown',
      },
    };
  }
  return { state: 'authoritative', sourceSha: catalog.sourceSha };
};

export const migrationSourceUnavailableRule: TruthRule = {
  code: 'MIGRATION_SOURCE_UNAVAILABLE',
  check: 'migrations',
  evaluate: ({ environment, observation }) => {
    const source = migrationSourceState(environment, observation);
    if (source.state !== 'unavailable') {
      return [];
    }

    return [
      finding({
        code: 'MIGRATION_SOURCE_UNAVAILABLE',
        title: 'Expected migration source is unavailable',
        description:
          'DeployTruth cannot establish which migrations the declared source expects, so applied database history cannot be certified.',
        severity: 'WARNING',
        status: 'WARN',
        expected: 'authoritative migration catalog',
        observed: source.detail,
        evidence: source.evidence,
        affectedComponents: [
          component('source', environment.id),
          component('database', environment.id),
        ],
        remediation:
          'Fetch the declared branch locally so HEAD matches the remote-authoritative SHA, or restore Git observation of the repository.',
      }),
    ];
  },
};

export const migrationSourceInvalidRule: TruthRule = {
  code: 'MIGRATION_SOURCE_INVALID',
  check: 'migrations',
  evaluate: ({ environment, observation }) => {
    const source = migrationSourceState(environment, observation);
    if (source.state !== 'invalid') {
      return [];
    }

    const availability = source.catalog.availability;
    return [
      finding({
        code: 'MIGRATION_SOURCE_INVALID',
        title: 'Expected migration source is invalid',
        description:
          'The declared migration directory exists in the source tree but cannot be interpreted as a valid Supabase migration set.',
        severity: 'WARNING',
        status: 'WARN',
        expected: 'valid migration catalog',
        observed: availability?.reason ?? 'invalid',
        evidence: {
          directory: source.catalog.directory,
          ...(availability?.invalidFilenames !== undefined
            ? { invalidFilenames: [...availability.invalidFilenames].sort() }
            : {}),
          ...(availability?.duplicateVersions !== undefined
            ? { duplicateVersions: [...availability.duplicateVersions].sort() }
            : {}),
        },
        affectedComponents: [
          component('source', environment.id),
          component('database', environment.id),
        ],
        remediation:
          'Fix the migration directory: every .sql file must match <version>_<name>.sql or r_<name>.sql, and versions must be unique.',
      }),
    ];
  },
};

export const databaseMigrationHistoryUnavailableRule: TruthRule = {
  code: 'DATABASE_MIGRATION_HISTORY_UNAVAILABLE',
  check: 'migrations',
  evaluate: ({ environment, observation }) => {
    const database = observation?.database;
    if (
      !isSupabaseDatabase(observation) ||
      database?.connection?.state !== 'available' ||
      database?.migrationHistory?.state !== 'unavailable'
    ) {
      return [];
    }

    return [
      finding({
        code: 'DATABASE_MIGRATION_HISTORY_UNAVAILABLE',
        title: 'Applied migration history could not be read',
        description:
          'The database connection succeeded, but the Supabase migration history could not be observed; a missing history table is not the same as zero applied migrations.',
        severity: 'WARNING',
        status: 'WARN',
        expected: 'migration history readable',
        observed: database.migrationHistory.reason ?? 'unavailable',
        evidence: supabaseUnavailableEvidence(database.migrationHistory),
        affectedComponents: [component('database', environment.id)],
        remediation:
          'Verify the configured credentials can read the provider’s migration history table, or apply the declared migrations so history exists.',
      }),
    ];
  },
};

/**
 * Expected-vs-applied comparison is certified only when every link holds: the catalog is
 * authoritative for the declared source, the observed database is provably the declared
 * project, and its migration history was actually read. Legacy observations without M4
 * fields evaluate directly (pre-M4 fixture semantics).
 */
const migrationComparisonReady = (
  environment: DeclaredEnvironment,
  observation?: EnvironmentObservation,
): boolean => {
  if (migrationSourceState(environment, observation).state !== 'authoritative') {
    return false;
  }
  const database = observation?.database;
  if (database === undefined) {
    return false;
  }
  // A failed or refused connection can never back a certified comparison — even if other
  // fields claim success, inconsistent evidence is not certification material.
  if (database.connection !== undefined && database.connection.state !== 'available') {
    return false;
  }
  if (database.identity !== undefined && database.identity !== 'verified') {
    return false;
  }
  if (database.migrationHistory !== undefined && database.migrationHistory.state !== 'available') {
    return false;
  }
  return true;
};

export const databaseMigrationsBehindRule: TruthRule = {
  code: 'DATABASE_MIGRATIONS_BEHIND',
  check: 'migrations',
  evaluate: ({ environment, observation }) => {
    if (!migrationComparisonReady(environment, observation)) {
      return [];
    }
    const expected = observation?.repositoryMigrations?.migrationIds ?? [];
    const applied = new Set(observation?.database?.appliedMigrationIds ?? []);

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
        evidence: { missingMigrationIds: [...missing].sort() },
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

export const databaseMigrationDriftRule: TruthRule = {
  code: 'DATABASE_MIGRATION_DRIFT',
  check: 'migrations',
  evaluate: ({ environment, observation }) => {
    if (!migrationComparisonReady(environment, observation)) {
      return [];
    }
    const expected = new Set(observation?.repositoryMigrations?.migrationIds ?? []);
    const applied = observation?.database?.appliedMigrationIds ?? [];

    const extra = applied.filter((migrationId) => !expected.has(migrationId));
    if (extra.length === 0) {
      return [];
    }

    return [
      finding({
        code: 'DATABASE_MIGRATION_DRIFT',
        title: 'Database reports migrations absent from the source',
        description:
          'The observed database records applied migration versions that the declared source does not contain. This can be legitimate (repair, squash, out-of-band history); it is not proof of schema corruption.',
        severity: 'WARNING',
        status: 'WARN',
        expected: [...expected].sort(),
        observed: [...applied].sort(),
        evidence: { extraMigrationIds: [...extra].sort() },
        affectedComponents: [
          component('source', environment.id),
          component('database', environment.id),
        ],
        remediation:
          'Confirm whether the extra applied versions are intentional history (repair/squash/out-of-band) and reconcile the declared source if needed.',
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
    if (!runtimeAttestationUsable(observation) || !expected || !observed || expected === observed) {
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

const runtimeAttestationUsable = (observation?: EnvironmentObservation): boolean => {
  const runtime = observation?.runtime;
  if (runtime === undefined) {
    return false;
  }
  // Pre-M5 fixtures had no availability/freshness fields. Preserve their deterministic
  // semantics while requiring both fields for every M5 adapter observation.
  if (runtime.availability === undefined) {
    return runtime.reachable;
  }
  return runtime.availability.state === 'available' && runtime.freshness?.state === 'verified';
};

const expectedRuntimeEnvironment = (
  environment: DeclaredEnvironment,
  observation?: EnvironmentObservation,
): string | undefined =>
  observation?.deployment?.target ??
  environment.deployment?.target ??
  observation?.deployment?.environment;

export const runtimeAttestationUnavailableRule: TruthRule = {
  code: 'RUNTIME_ATTESTATION_UNAVAILABLE',
  evaluate: ({ environment, observation }) => {
    const runtime = observation?.runtime;
    if (
      runtime === undefined ||
      (runtime.availability?.state !== 'unavailable' && runtime.reachable !== false)
    ) {
      return [];
    }
    return [
      finding({
        code: 'RUNTIME_ATTESTATION_UNAVAILABLE',
        title: 'Runtime attestation could not be observed',
        description:
          'The running application did not provide an authoritative runtime attestation. No control-plane fallback is used.',
        severity: 'WARNING',
        status: 'WARN',
        expected: 'available runtime attestation',
        observed: runtime.availability?.reason ?? 'unavailable',
        evidence: {
          reason: runtime.availability?.reason ?? 'unavailable',
          ...(runtime.statusCode !== undefined ? { statusCode: runtime.statusCode } : {}),
        },
        affectedComponents: [component('runtime', environment.id)],
        remediation:
          'Verify the declared runtime endpoint, HTTPS reachability, response size, and strict v1 response contract.',
      }),
    ];
  },
};

export const runtimeAttestationFreshnessUnverifiedRule: TruthRule = {
  code: 'RUNTIME_ATTESTATION_FRESHNESS_UNVERIFIED',
  evaluate: ({ environment, observation }) => {
    const runtime = observation?.runtime;
    if (runtime?.availability?.state !== 'available' || runtime.freshness?.state === 'verified') {
      return [];
    }
    return [
      finding({
        code: 'RUNTIME_ATTESTATION_FRESHNESS_UNVERIFIED',
        title: 'Runtime attestation freshness could not be verified',
        description:
          'The runtime did not echo the cryptographically random request nonce exactly, so the response may be stale or replayed.',
        severity: 'WARNING',
        status: 'WARN',
        expected: 'exact nonce echo',
        observed: runtime.freshness?.reason ?? 'freshness evidence missing',
        evidence: { reason: runtime.freshness?.reason ?? 'missing' },
        affectedComponents: [component('runtime', environment.id)],
        remediation:
          'Return the exact request nonce from the runtime and keep the endpoint cache disabled.',
      }),
    ];
  },
};

export const runtimeEnvironmentMismatchRule: TruthRule = {
  code: 'RUNTIME_ENVIRONMENT_MISMATCH',
  check: 'environment_isolation',
  evaluate: ({ environment, observation }) => {
    const expected = expectedRuntimeEnvironment(environment, observation);
    const observed = observation?.runtime?.environment;
    if (!runtimeAttestationUsable(observation) || !expected || !observed || expected === observed) {
      return [];
    }

    return [
      finding({
        code: 'RUNTIME_ENVIRONMENT_MISMATCH',
        title: 'Runtime reports the wrong environment identity',
        description:
          'The runtime environment differs from the declared or observed deployment target. The logical manifest environment id is not used for this comparison.',
        severity: 'HIGH',
        status: 'FAIL',
        expected,
        observed,
        evidence: { runtimeUrl: environment.runtime?.url ?? 'not-declared' },
        affectedComponents: [component('runtime', environment.id)],
        remediation:
          'Inspect the deployed target and runtime-provided environment label, then deploy the build to the intended target.',
      }),
    ];
  },
};

export const runtimeRequiredEnvironmentMissingRule: TruthRule = {
  code: 'RUNTIME_REQUIRED_ENV_MISSING',
  check: 'environment_variables',
  evaluate: ({ environment, observation }) => {
    if (!runtimeAttestationUsable(observation)) {
      return [];
    }
    const evidence = new Map(
      (observation?.runtime?.environmentVariables ?? []).map((variable) => [
        variable.name,
        variable.present,
      ]),
    );
    const explicitlyMissing = environment.requiredEnvironmentVariables.filter(
      (name) => evidence.get(name) === false,
    );
    if (explicitlyMissing.length === 0) {
      return [];
    }
    return [
      finding({
        code: 'RUNTIME_REQUIRED_ENV_MISSING',
        title: 'Required runtime environment variable is missing',
        description:
          'The running application explicitly attested that a declared-required variable is absent. Only presence booleans were observed.',
        severity: 'HIGH',
        status: 'FAIL',
        expected: environment.requiredEnvironmentVariables,
        observed: [...evidence.entries()]
          .filter(([, present]) => present)
          .map(([name]) => name)
          .sort(),
        evidence: { missingVariableNames: explicitlyMissing.sort() },
        affectedComponents: [component('runtime', environment.id)],
        remediation:
          'Configure the required variable in the intended deployment environment and create a new deployment.',
      }),
    ];
  },
};

export const runtimeDatabaseProjectMismatchRule: TruthRule = {
  code: 'RUNTIME_DATABASE_PROJECT_MISMATCH',
  check: 'environment_isolation',
  evaluate: ({ environment, observation }) => {
    const expected = environment.database?.projectRef;
    const observed = observation?.runtime?.databaseConnection?.targetProjectRef;
    if (!runtimeAttestationUsable(observation) || !expected || !observed || expected === observed) {
      return [];
    }
    return [
      finding({
        code: 'RUNTIME_DATABASE_PROJECT_MISMATCH',
        title: 'Runtime targets the wrong database project',
        description:
          'The running application derived a different project identity from its actual connection URL than the database declared for this environment.',
        severity: 'HIGH',
        status: 'FAIL',
        expected,
        observed,
        evidence: { declaredProjectRef: expected, runtimeTargetProjectRef: observed },
        affectedComponents: [
          component('runtime', environment.id),
          component('database', environment.id),
        ],
        remediation:
          'Correct the runtime connection configuration for this deployment target and redeploy. Do not rely on a separate project-ref variable.',
      }),
    ];
  },
};

export const runtimeDatabaseIdentityUnverifiedRule: TruthRule = {
  code: 'RUNTIME_DATABASE_IDENTITY_UNVERIFIED',
  check: 'environment_isolation',
  evaluate: ({ environment, observation }) => {
    if (!environment.database || !runtimeAttestationUsable(observation)) {
      return [];
    }
    const connection = observation?.runtime?.databaseConnection;
    if (connection?.identity === 'verified' && connection.targetProjectRef !== undefined) {
      return [];
    }
    return [
      finding({
        code: 'RUNTIME_DATABASE_IDENTITY_UNVERIFIED',
        title: 'Runtime database target identity is unverified',
        description:
          'The runtime connection configuration could not be safely tied to a project ref. Connectivity alone does not establish identity.',
        severity: 'WARNING',
        status: 'WARN',
        expected: environment.database.projectRef,
        observed: connection?.targetProjectRef ?? 'unverified',
        evidence: { provider: connection?.provider ?? environment.database.provider },
        affectedComponents: [
          component('runtime', environment.id),
          component('database', environment.id),
        ],
        remediation:
          'Use a documented provider URL whose host deterministically encodes the project identity.',
      }),
    ];
  },
};

export const runtimeDatabaseConnectionUnavailableRule: TruthRule = {
  code: 'RUNTIME_DATABASE_CONNECTION_UNAVAILABLE',
  check: 'environment_isolation',
  evaluate: ({ environment, observation }) => {
    const connection = observation?.runtime?.databaseConnection;
    if (
      !environment.database ||
      !runtimeAttestationUsable(observation) ||
      connection?.identity !== 'verified' ||
      connection.targetProjectRef === undefined ||
      connection.status !== 'unavailable'
    ) {
      return [];
    }
    return [
      finding({
        code: 'RUNTIME_DATABASE_CONNECTION_UNAVAILABLE',
        title: 'Runtime database connection could not be verified',
        description:
          'The runtime target identity is established, but its harmless read-only connection probe did not succeed.',
        severity: 'WARNING',
        status: 'WARN',
        expected: 'connected',
        observed: connection.reason ?? 'unavailable',
        evidence: {
          targetProjectRef: connection.targetProjectRef,
          reason: connection.reason ?? 'unavailable',
        },
        affectedComponents: [
          component('runtime', environment.id),
          component('database', environment.id),
        ],
        remediation:
          'Verify the runtime publishable credential, provider availability, TLS, and network reachability, then redeploy if configuration changed.',
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
      observation?.runtime?.environmentVariables !== undefined ||
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
    case 'migrations': {
      const catalog = observation?.repositoryMigrations;
      const database = observation?.database;
      if (catalog === undefined || database === undefined) {
        return false;
      }
      // Migration coverage requires the full evidence chain: an authoritative expected
      // source, a connection provably tied to the declared project, and a readable
      // migration history. Pre-M4 observations carry none of these fields and keep
      // their original semantics.
      if (migrationSourceState(environment, observation).state !== 'authoritative') {
        return false;
      }
      if (database.connection !== undefined && database.connection.state !== 'available') {
        return false;
      }
      if (database.identity !== undefined && database.identity !== 'verified') {
        return false;
      }
      if (
        database.migrationHistory !== undefined &&
        database.migrationHistory.state !== 'available'
      ) {
        return false;
      }
      return true;
    }
    case 'runtime_identity':
      return Boolean(
        runtimeAttestationUsable(observation) &&
        observation?.deployment?.commitSha &&
        observation.runtime?.commitSha &&
        observation.deployment.commitSha === observation.runtime.commitSha,
      );
    case 'environment_isolation': {
      if (environment.runtime === undefined) {
        return Boolean(environment.database?.projectRef && databaseConnection(observation));
      }
      if (!runtimeAttestationUsable(observation)) {
        return false;
      }
      const expectedEnvironment = expectedRuntimeEnvironment(environment, observation);
      if (
        expectedEnvironment === undefined ||
        observation?.runtime?.environment !== expectedEnvironment
      ) {
        return false;
      }
      if (environment.database === undefined) {
        return true;
      }
      const connection = observation.runtime.databaseConnection;
      return Boolean(
        connection?.identity === 'verified' &&
        connection.targetProjectRef === environment.database.projectRef &&
        connection.status === 'connected',
      );
    }
    case 'environment_variables':
      return (
        environment.requiredEnvironmentVariables.length === 0 ||
        (runtimeAttestationUsable(observation) &&
          environment.requiredEnvironmentVariables.every((name) =>
            observation?.runtime?.environmentVariables?.some(
              (variable) => variable.name === name && variable.present,
            ),
          )) ||
        (observation?.runtime?.environmentVariables === undefined &&
          Boolean(observation?.deployment?.environmentVariables))
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
  vercelProductionRoutingAmbiguousRule,
  deploymentNotReadyRule,
  deploymentFailedRule,
  stableDomainStaleRule,
  wrongDatabaseProjectRule,
  previewUsesProductionDatabaseRule,
  supabaseProjectUnavailableRule,
  databaseConnectionUnavailableRule,
  databaseIdentityUnverifiedRule,
  migrationSourceUnavailableRule,
  migrationSourceInvalidRule,
  databaseMigrationHistoryUnavailableRule,
  databaseMigrationsBehindRule,
  databaseMigrationDriftRule,
  runtimeAttestationUnavailableRule,
  runtimeAttestationFreshnessUnverifiedRule,
  runtimeShaMismatchRule,
  runtimeEnvironmentMismatchRule,
  runtimeRequiredEnvironmentMissingRule,
  runtimeDatabaseProjectMismatchRule,
  runtimeDatabaseIdentityUnverifiedRule,
  runtimeDatabaseConnectionUnavailableRule,
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
