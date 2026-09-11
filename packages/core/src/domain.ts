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
    stableDomain: z.string().url().optional(),
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

export const sourceObservationSchema = z
  .object({
    provider: z.string().min(1),
    repository: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    headSha: z.string().min(1).optional(),
    /** Authoritative remote branch SHA. Only remote-aware adapters (M2+) may set this. */
    remoteHeadSha: z.string().min(1).optional(),
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

export const deploymentObservationSchema = z
  .object({
    provider: z.string().min(1),
    project: z.string().min(1).optional(),
    deploymentId: z.string().min(1).optional(),
    environment: z.string().min(1).optional(),
    commitSha: z.string().min(1).optional(),
    stableDomain: z.string().url().optional(),
    connectedResources: z.array(connectionObservationSchema).default([]),
    environmentVariables: z.array(environmentVariableObservationSchema).default([]),
  })
  .strict();
export type DeploymentObservation = z.infer<typeof deploymentObservationSchema>;

export const databaseObservationSchema = z
  .object({
    provider: z.string().min(1),
    projectRef: z.string().min(1).optional(),
    appliedMigrationIds: z.array(z.string().min(1)).default([]),
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

export const migrationCatalogObservationSchema = z
  .object({
    directory: z.string().min(1),
    migrationIds: z.array(z.string().min(1)),
  })
  .strict();
export type MigrationCatalogObservation = z.infer<typeof migrationCatalogObservationSchema>;

export const environmentObservationSchema = z
  .object({
    environment: z.string().min(1),
    source: sourceObservationSchema.optional(),
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
