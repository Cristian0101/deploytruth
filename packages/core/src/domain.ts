import { z } from 'zod';

export const REPORT_SCHEMA_VERSION = '0.1' as const;

export const environmentKindSchema = z.enum([
  'production',
  'preview',
  'staging',
  'development',
  'custom',
]);
export type EnvironmentKind = z.infer<typeof environmentKindSchema>;

export const componentTypeSchema = z.enum([
  'source',
  'deployment',
  'database',
  'runtime',
  'auth',
  'environment-variable',
]);
export type ComponentType = z.infer<typeof componentTypeSchema>;

export const verdictSchema = z.enum(['PASS', 'WARN', 'FAIL']);
export type Verdict = z.infer<typeof verdictSchema>;

export const severitySchema = z.enum(['INFO', 'WARNING', 'HIGH', 'CRITICAL']);
export type Severity = z.infer<typeof severitySchema>;

export const findingStatusSchema = z.enum(['WARN', 'FAIL']);
export type FindingStatus = z.infer<typeof findingStatusSchema>;

export type SafeValue =
  string | number | boolean | null | readonly SafeValue[] | { readonly [key: string]: SafeValue };

export const safeValueSchema: z.ZodType<SafeValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(safeValueSchema),
    z.record(safeValueSchema),
  ]),
);

export const checkNameSchema = z.enum([
  'local_git',
  'remote_source',
  'deployment_sha',
  'migrations',
  'runtime_identity',
  'environment_isolation',
  'environment_variables',
]);
export type CheckName = z.infer<typeof checkNameSchema>;

export const checksSchema = z
  .object({
    local_git: z.boolean().optional(),
    remote_source: z.boolean().optional(),
    deployment_sha: z.boolean().optional(),
    migrations: z.boolean().optional(),
    runtime_identity: z.boolean().optional(),
    environment_isolation: z.boolean().optional(),
    environment_variables: z.boolean().optional(),
  })
  .strict();
export type Checks = z.infer<typeof checksSchema>;

export const declaredSourceSchema = z
  .object({
    provider: z.string().min(1),
    repository: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
  })
  .strict();
export type DeclaredSource = z.infer<typeof declaredSourceSchema>;

export const declaredDeploymentSchema = z
  .object({
    provider: z.string().min(1),
    project: z.string().min(1),
    /** Deployment target to observe. Only `production` is supported in M3. */
    target: z.literal('production').optional(),
    /** Optional provider account/team scope (for example a Vercel team slug or id). */
    scope: z.string().min(1).optional(),
    /** Optional declared stable domain as a bare hostname (for example app.example.com). */
    domain: z.string().min(1).optional(),
  })
  .strict();
export type DeclaredDeployment = z.infer<typeof declaredDeploymentSchema>;

export const declaredDatabaseSchema = z
  .object({
    provider: z.string().min(1),
    projectRef: z.string().min(1),
    migrationDirectory: z.string().min(1).optional(),
  })
  .strict();
export type DeclaredDatabase = z.infer<typeof declaredDatabaseSchema>;

export const declaredRuntimeSchema = z
  .object({
    url: z.string().url(),
    expectedEnvironment: z.string().min(1).optional(),
  })
  .strict();
export type DeclaredRuntime = z.infer<typeof declaredRuntimeSchema>;

export const declaredEnvironmentSchema = z
  .object({
    id: z.string().min(1),
    kind: environmentKindSchema,
    source: declaredSourceSchema.optional(),
    deployment: declaredDeploymentSchema.optional(),
    database: declaredDatabaseSchema.optional(),
    runtime: declaredRuntimeSchema.optional(),
    requiredEnvironmentVariables: z.array(z.string().min(1)).default([]),
    checks: checksSchema.default({}),
  })
  .strict();
export type DeclaredEnvironment = z.infer<typeof declaredEnvironmentSchema>;

export const projectDeclarationSchema = z
  .object({
    version: z.literal(1),
    project: z.string().min(1),
    environments: z.record(declaredEnvironmentSchema),
  })
  .strict();
export type ProjectDeclaration = z.infer<typeof projectDeclarationSchema>;

export const connectionObservationSchema = z
  .object({
    type: componentTypeSchema,
    provider: z.string().min(1),
    identifier: z.string().min(1),
    environment: z.string().min(1).optional(),
  })
  .strict();
export type ConnectionObservation = z.infer<typeof connectionObservationSchema>;

export const gitTrackingRefObservationSchema = z
  .object({
    remote: z.string().min(1),
    branch: z.string().min(1),
    /** Local remote-tracking ref, e.g. refs/remotes/origin/main. Not remote-authoritative. */
    ref: z.string().min(1),
    /** SHA the local tracking ref points at; undefined when it does not exist locally. */
    sha: z.string().min(1).optional(),
  })
  .strict();
export type GitTrackingRefObservation = z.infer<typeof gitTrackingRefObservationSchema>;

export const worktreeObservationSchema = z
  .object({
    path: z.string().min(1),
    branch: z.string().min(1).optional(),
    headSha: z.string().min(1).optional(),
  })
  .strict();
export type WorktreeObservation = z.infer<typeof worktreeObservationSchema>;

export const repositoryOperationSchema = z.enum([
  'merge',
  'rebase',
  'cherry-pick',
  'revert',
  'bisect',
]);
export type RepositoryOperation = z.infer<typeof repositoryOperationSchema>;

/** Normalized remote rate-limit metadata; never raw response headers. */
export const remoteRateLimitSchema = z
  .object({
    limit: z.number().int().nonnegative().optional(),
    remaining: z.number().int().nonnegative().optional(),
    resetAt: z.string().datetime({ offset: true }).optional(),
    /** Server-supplied Retry-After hint in seconds, when the provider exposes one. */
    retryAfter: z.number().int().nonnegative().optional(),
  })
  .strict();
export type RemoteRateLimit = z.infer<typeof remoteRateLimitSchema>;

export const remoteUnavailableReasonSchema = z.enum([
  'not_found',
  'unauthorized',
  'forbidden',
  'rate_limited',
  'server_error',
  'unexpected_status',
  'malformed_response',
  'network_error',
  'timeout',
  'aborted',
]);
export type RemoteUnavailableReason = z.infer<typeof remoteUnavailableReasonSchema>;

/**
 * Whether the remote authority behind this observation was actually observed.
 * Remote-aware adapters always set it; local-only adapters leave it unset.
 */
export const sourceAvailabilitySchema = z
  .object({
    state: z.enum(['available', 'unavailable']),
    /** The remote resource that could not be observed when state is unavailable. */
    target: z.enum(['repository', 'branch']).optional(),
    reason: remoteUnavailableReasonSchema.optional(),
    /** Sanitized human detail; must never contain credentials or raw payloads. */
    detail: z.string().min(1).optional(),
    rateLimit: remoteRateLimitSchema.optional(),
  })
  .strict();
export type SourceAvailability = z.infer<typeof sourceAvailabilitySchema>;

export const sourceObservationSchema = z
  .object({
    provider: z.string().min(1),
    repository: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    headSha: z.string().min(1).optional(),
    /** Authoritative remote branch SHA. Only remote-aware adapters (M2+) may set this. */
    remoteHeadSha: z.string().min(1).optional(),
    /** Default branch reported by the remote source host. Remote-aware adapters only. */
    defaultBranch: z.string().min(1).optional(),
    /** Repository visibility reported by the remote source host, when known. */
    visibility: z.enum(['public', 'private', 'internal']).optional(),
    /** True when the remote source host reports the repository as archived. */
    archived: z.boolean().optional(),
    /** Whether remote-authoritative evidence was actually obtained. Remote-aware adapters only. */
    availability: sourceAvailabilitySchema.optional(),
    workingTree: z.enum(['clean', 'dirty', 'unknown']).default('unknown'),
    aheadBy: z.number().int().nonnegative().optional(),
    behindBy: z.number().int().nonnegative().optional(),
    detachedHead: z.boolean().default(false),
    stagedCount: z.number().int().nonnegative().default(0),
    modifiedCount: z.number().int().nonnegative().default(0),
    untrackedCount: z.number().int().nonnegative().default(0),
    unmergedCount: z.number().int().nonnegative().default(0),
    /** Repository-relative paths; counts stay authoritative when a list is capped. */
    stagedFiles: z.array(z.string().min(1)).default([]),
    modifiedFiles: z.array(z.string().min(1)).default([]),
    untrackedFiles: z.array(z.string().min(1)).default([]),
    unmergedFiles: z.array(z.string().min(1)).default([]),
    upstream: gitTrackingRefObservationSchema.optional(),
    remoteNames: z.array(z.string().min(1)).default([]),
    repositoryRoot: z.string().min(1).optional(),
    gitDirectory: z.string().min(1).optional(),
    commonGitDirectory: z.string().min(1).optional(),
    isLinkedWorktree: z.boolean().default(false),
    worktrees: z.array(worktreeObservationSchema).default([]),
    operationsInProgress: z.array(repositoryOperationSchema).default([]),
  })
  .strict();
export type SourceObservation = z.infer<typeof sourceObservationSchema>;

export const environmentVariableObservationSchema = z
  .object({
    name: z.string().min(1),
    present: z.boolean(),
    fingerprint: z.string().min(1).optional(),
  })
  .strict();
export type EnvironmentVariableObservation = z.infer<typeof environmentVariableObservationSchema>;

/**
 * Deployment-specific unavailability reasons: the transport-level reasons a remote call can
 * produce, plus control-plane cases only a deployment provider can hit (missing credentials,
 * a project whose current production deployment cannot be established, or divergent
 * production-domain assignments that make production routing ambiguous).
 */
export const deploymentUnavailableReasonSchema = z.enum([
  'missing_credentials',
  'deployment_unavailable',
  'ambiguous',
  'not_found',
  'unauthorized',
  'forbidden',
  'rate_limited',
  'server_error',
  'unexpected_status',
  'malformed_response',
  'network_error',
  'timeout',
  'aborted',
]);
export type DeploymentUnavailableReason = z.infer<typeof deploymentUnavailableReasonSchema>;

/**
 * Whether the deployment control plane behind this observation was actually observed.
 * Deployment adapters always set it; a failed call produces `unavailable` evidence.
 */
export const deploymentAvailabilitySchema = z
  .object({
    state: z.enum(['available', 'unavailable']),
    /** The control-plane resource that could not be observed when state is unavailable. */
    target: z.enum(['project', 'deployment']).optional(),
    reason: deploymentUnavailableReasonSchema.optional(),
    /** Sanitized human detail; must never contain credentials or raw payloads. */
    detail: z.string().min(1).optional(),
    rateLimit: remoteRateLimitSchema.optional(),
  })
  .strict();
export type DeploymentAvailability = z.infer<typeof deploymentAvailabilitySchema>;

/**
 * A normalized production-domain → deployment assignment observed at the control plane.
 * Domain names and normalized deployment ids only — never raw provider payload fields.
 */
export const productionAssignmentSchema = z
  .object({
    domain: z.string().min(1),
    deploymentId: z.string().min(1),
  })
  .strict();
export type ProductionAssignment = z.infer<typeof productionAssignmentSchema>;

/** Normalized provider-agnostic production deployment state. */
export const deploymentStateSchema = z.enum([
  'ready',
  'building',
  'queued',
  'error',
  'canceled',
  'unknown',
]);
export type DeploymentState = z.infer<typeof deploymentStateSchema>;

export const deploymentObservationSchema = z
  .object({
    provider: z.string().min(1),
    /** Whether the deployment control plane was actually observed. Deployment adapters set it. */
    availability: deploymentAvailabilitySchema.optional(),
    project: z.string().min(1).optional(),
    /** The deployment target observed (for example `production`). */
    target: z.string().min(1).optional(),
    deploymentId: z.string().min(1).optional(),
    /** Provider-reported deployment URL (usually an https URL or hostname). */
    deploymentUrl: z.string().min(1).optional(),
    environment: z.string().min(1).optional(),
    /** Normalized state of the observed current production deployment. */
    state: deploymentStateSchema.optional(),
    /** The source commit SHA the provider recorded for this deployment, when safely available. */
    commitSha: z.string().min(1).optional(),
    /** The source branch the provider recorded for this deployment, when safely available. */
    sourceBranch: z.string().min(1).optional(),
    /** The source repository (owner/repo) the provider recorded, when safely available. */
    sourceRepository: z.string().min(1).optional(),
    /** Creation timestamp of the observed deployment. */
    createdAt: z.string().datetime({ offset: true }).optional(),
    /** The declared stable domain, echoed as a bare hostname when declared. */
    stableDomain: z.string().min(1).optional(),
    /**
     * Present only when a stable domain is declared: true when control-plane evidence confirms
     * the domain currently resolves to the observed production deployment, false when it
     * positively does not. Absent means verification was not possible.
     */
    stableDomainVerified: z.boolean().optional(),
    /**
     * The production-domain assignments the control plane reported, emitted only when no
     * single production deployment could be resolved (divergent aliases, or a declared
     * domain that is not assigned). Normalized evidence that lets findings explain _why_
     * production is unknown instead of guessing.
     */
    productionAssignments: z.array(productionAssignmentSchema).optional(),
    connectedResources: z.array(connectionObservationSchema).default([]),
    /**
     * Variable-presence observations. Absent means "the provider did not observe variable
     * presence" — never an empty claim. Adapters that do not fetch variable metadata leave
     * this unset so coverage stays honest.
     */
    environmentVariables: z.array(environmentVariableObservationSchema).optional(),
  })
  .strict();
export type DeploymentObservation = z.infer<typeof deploymentObservationSchema>;

/**
 * Reasons a database evidence source could not be observed. The first group covers the
 * management/control-plane API; the second covers the PostgreSQL connection. All are fixed
 * normalized strings — raw provider payloads and driver errors never reach the model.
 */
export const databaseUnavailableReasonSchema = z.enum([
  'missing_credentials',
  'unauthorized',
  'forbidden',
  'not_found_or_inaccessible',
  'rate_limited',
  'server_error',
  'unexpected_status',
  'malformed_response',
  'network_error',
  'timeout',
  'aborted',
  'invalid_url',
  'authentication_failed',
  'connection_failed',
  'tls_error',
  'insecure_tls_configuration',
  'database_unavailable',
]);
export type DatabaseUnavailableReason = z.infer<typeof databaseUnavailableReasonSchema>;

/** Normalized control-plane project state (Supabase `status` mapped to this small set). */
export const databaseProjectStateSchema = z.enum([
  'healthy',
  'degraded',
  'transitioning',
  'inactive',
  'failed',
  'removed',
  'unknown',
]);
export type DatabaseProjectState = z.infer<typeof databaseProjectStateSchema>;

/**
 * Control-plane evidence: whether the declared project could be observed through the
 * provider's management API. A successful lookup here never proves that a PostgreSQL
 * connection targets the same project — the two evidence sources stay separate.
 */
export const databaseControlPlaneSchema = z
  .object({
    state: z.enum(['available', 'unavailable']),
    reason: databaseUnavailableReasonSchema.optional(),
    /** Sanitized human detail; must never contain credentials or raw payloads. */
    detail: z.string().min(1).optional(),
    rateLimit: remoteRateLimitSchema.optional(),
    projectName: z.string().min(1).optional(),
    region: z.string().min(1).optional(),
    status: databaseProjectStateSchema.optional(),
  })
  .strict();
export type DatabaseControlPlane = z.infer<typeof databaseControlPlaneSchema>;

/**
 * Database connection evidence: whether the configured PostgreSQL endpoint accepted a
 * read-only, TLS-authenticated session. `identitySource` records _how_ an endpoint-derived
 * project ref was recovered from the connection endpoint — never the connection string
 * itself. `targetProjectRef` is connection-target configuration evidence: it may be present
 * even when the connection failed, and it is never observed database identity.
 */
export const databaseConnectionStateSchema = z
  .object({
    state: z.enum(['available', 'unavailable']),
    reason: databaseUnavailableReasonSchema.optional(),
    /** Sanitized human detail; must never contain host credentials or driver errors. */
    detail: z.string().min(1).optional(),
    identitySource: z.enum(['direct_host', 'pooler_username']).optional(),
    /**
     * The project ref the configured connection endpoint *targets*, derived deterministically
     * from the endpoint's documented encoding. Present whenever derivable — including on a
     * failed or refused connection — so findings can report where the URL points. This is
     * configuration evidence only; `observedProjectRef` is the observed identity claim and is
     * emitted solely after a TLS-authenticated session actually succeeded.
     */
    targetProjectRef: z.string().min(1).optional(),
  })
  .strict();
export type DatabaseConnectionState = z.infer<typeof databaseConnectionStateSchema>;

/** Reasons applied migration history could not be read from the database. */
export const migrationHistoryUnavailableReasonSchema = z.enum([
  'connection_unavailable',
  'history_table_missing',
  'history_query_failed',
  'malformed_rows',
]);
export type MigrationHistoryUnavailableReason = z.infer<
  typeof migrationHistoryUnavailableReasonSchema
>;

export const databaseMigrationHistorySchema = z
  .object({
    state: z.enum(['available', 'unavailable']),
    reason: migrationHistoryUnavailableReasonSchema.optional(),
    /** Sanitized human detail; must never contain driver errors or SQL payloads. */
    detail: z.string().min(1).optional(),
  })
  .strict();
export type DatabaseMigrationHistory = z.infer<typeof databaseMigrationHistorySchema>;

/**
 * Database truth separates three evidence sources: the management control plane (does the
 * declared project exist), the PostgreSQL connection (can we reach a database), and the
 * identity claim tying them together (`observedProjectRef` derived deterministically from
 * the connection endpoint, never asserted by connectivity alone).
 */
export const databaseObservationSchema = z
  .object({
    provider: z.string().min(1),
    /** The declared project ref, echoed for correlation — never the observed identity. */
    projectRef: z.string().min(1).optional(),
    controlPlane: databaseControlPlaneSchema.optional(),
    connection: databaseConnectionStateSchema.optional(),
    /**
     * The connected database's project identity: the endpoint-derived ref, emitted only
     * after a TLS-authenticated session actually succeeded. Never populated from a failed
     * or refused connection — `connection.targetProjectRef` carries endpoint-derived
     * target evidence, which is not observed identity.
     */
    observedProjectRef: z.string().min(1).optional(),
    /**
     * Whether the observed connection is provably the declared project. Set only when a
     * connection was established; `unverified` means reachable-but-unattributable.
     */
    identity: z.enum(['verified', 'mismatch', 'unverified']).optional(),
    /** Applied migration versions reported by the provider's migration history table. */
    appliedMigrationIds: z.array(z.string().min(1)).default([]),
    migrationHistory: databaseMigrationHistorySchema.optional(),
  })
  .strict();
export type DatabaseObservation = z.infer<typeof databaseObservationSchema>;

export const runtimeObservationSchema = z
  .object({
    url: z.string().url(),
    reachable: z.boolean(),
    statusCode: z.number().int().min(100).max(599).optional(),
    commitSha: z.string().min(1).optional(),
    environment: z.string().min(1).optional(),
    buildTime: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type RuntimeObservation = z.infer<typeof runtimeObservationSchema>;

/** Reasons the expected migration catalog could not be read from the source tree. */
export const migrationCatalogUnavailableReasonSchema = z.enum([
  'git_unavailable',
  'not_a_repository',
  'head_unavailable',
  'directory_missing',
  'not_a_directory',
  'duplicate_versions',
  'invalid_filenames',
]);
export type MigrationCatalogUnavailableReason = z.infer<
  typeof migrationCatalogUnavailableReasonSchema
>;

export const migrationCatalogAvailabilitySchema = z
  .object({
    state: z.enum(['available', 'unavailable']),
    reason: migrationCatalogUnavailableReasonSchema.optional(),
    /** Sanitized human detail; must never contain raw Git stderr. */
    detail: z.string().min(1).optional(),
    /** `.sql` entries that cannot be interpreted under the provider's migration grammar. */
    invalidFilenames: z.array(z.string().min(1)).optional(),
    /** Migration versions claimed by more than one file. */
    duplicateVersions: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type MigrationCatalogAvailability = z.infer<typeof migrationCatalogAvailabilitySchema>;

/**
 * The expected migration set. `origin: 'git-tree'` means the catalog was read from the
 * committed object tree at `sourceSha` — never the mutable working-tree filesystem, so
 * dirty or untracked files cannot contaminate expected truth.
 */
export const migrationCatalogObservationSchema = z
  .object({
    directory: z.string().min(1),
    migrationIds: z.array(z.string().min(1)),
    /** The immutable commit SHA the catalog was read from. */
    sourceSha: z.string().min(1).optional(),
    origin: z.enum(['git-tree']).optional(),
    availability: migrationCatalogAvailabilitySchema.optional(),
  })
  .strict();
export type MigrationCatalogObservation = z.infer<typeof migrationCatalogObservationSchema>;

export const environmentObservationSchema = z
  .object({
    environment: z.string().min(1),
    /** Local source evidence (the `git` adapter). Never remote-authoritative. */
    source: sourceObservationSchema.optional(),
    /**
     * Remote-authoritative source evidence (the `github` adapter in M2). Kept separate from
     * `source` so local and remote claims are compared, never merged (ADR 004).
     */
    remoteSource: sourceObservationSchema.optional(),
    deployment: deploymentObservationSchema.optional(),
    database: databaseObservationSchema.optional(),
    runtime: runtimeObservationSchema.optional(),
    repositoryMigrations: migrationCatalogObservationSchema.optional(),
  })
  .strict();
export type EnvironmentObservation = z.infer<typeof environmentObservationSchema>;

export const projectObservationSchema = z
  .object({
    project: z.string().min(1),
    environments: z.record(environmentObservationSchema),
  })
  .strict();
export type ProjectObservation = z.infer<typeof projectObservationSchema>;

export const affectedComponentSchema = z
  .object({
    type: componentTypeSchema,
    environment: z.string().min(1),
    identifier: z.string().min(1).optional(),
  })
  .strict();
export type AffectedComponent = z.infer<typeof affectedComponentSchema>;

export const truthFindingSchema = z
  .object({
    code: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    severity: severitySchema,
    status: findingStatusSchema,
    expected: safeValueSchema.optional(),
    observed: safeValueSchema.optional(),
    evidence: z.record(safeValueSchema).default({}),
    affectedComponents: z.array(affectedComponentSchema).min(1),
    remediation: z.string().min(1),
  })
  .strict();
export type TruthFinding = z.infer<typeof truthFindingSchema>;

export const topologyHealthSchema = z.enum(['healthy', 'warning', 'failed', 'unknown']);
export type TopologyHealth = z.infer<typeof topologyHealthSchema>;

export const topologyNodeSchema = z
  .object({
    id: z.string().min(1),
    provider: z.string().min(1),
    type: componentTypeSchema,
    environment: z.string().min(1),
    label: z.string().min(1),
    health: topologyHealthSchema,
    metadata: z.record(safeValueSchema).default({}),
  })
  .strict();
export type TopologyNode = z.infer<typeof topologyNodeSchema>;

export const topologyEdgeSchema = z
  .object({
    id: z.string().min(1),
    source: z.string().min(1),
    target: z.string().min(1),
    expected: z.boolean(),
    observed: z.boolean(),
    health: topologyHealthSchema,
    findings: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type TopologyEdge = z.infer<typeof topologyEdgeSchema>;

export const topologySchema = z
  .object({
    nodes: z.array(topologyNodeSchema),
    edges: z.array(topologyEdgeSchema),
  })
  .strict();
export type Topology = z.infer<typeof topologySchema>;

export const environmentTruthSchema = z
  .object({
    environment: z.string().min(1),
    declaration: declaredEnvironmentSchema,
    observation: environmentObservationSchema.optional(),
    findings: z.array(truthFindingSchema),
    verdict: verdictSchema,
  })
  .strict();
export type EnvironmentTruth = z.infer<typeof environmentTruthSchema>;

export const truthReportSchema = z
  .object({
    schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
    generatedAt: z.string().datetime({ offset: true }),
    project: z.string().min(1),
    strict: z.boolean(),
    verdict: verdictSchema,
    environments: z.array(environmentTruthSchema),
    findings: z.array(truthFindingSchema),
    topology: topologySchema,
    metadata: z.record(safeValueSchema).default({}),
  })
  .strict();
export type TruthReport = z.infer<typeof truthReportSchema>;

export interface TruthContext {
  readonly declaration: ProjectDeclaration;
  readonly observations: ProjectObservation;
  readonly generatedAt: string;
  readonly strict?: boolean;
}
