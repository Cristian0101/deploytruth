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
    case 'deployment_sha':
      return Boolean(environment.source && environment.deployment);
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

const sourceSha = (observation?: EnvironmentObservation): string | undefined =>
  observation?.source?.remoteHeadSha ?? observation?.source?.headSha;

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
          'The deployment provider reports a commit different from the configured source branch.',
        severity: 'HIGH',
        status: 'FAIL',
        expected,
        observed,
        evidence: { sourceSha: expected, deploymentSha: observed },
        affectedComponents: [
          component('source', environment.id),
          component('deployment', environment.id),
        ],
        remediation:
          'Confirm the target branch and redeploy the expected commit, or update the declared branch.',
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
    if (environment.requiredEnvironmentVariables.length === 0) {
      return [];
    }

    const present = new Map(
      observation?.deployment?.environmentVariables.map((variable) => [
        variable.name,
        variable.present,
      ]) ?? [],
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
  deploymentShaMismatchRule,
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
