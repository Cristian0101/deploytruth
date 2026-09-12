import {
  deploymentObservationSchema,
  type DeploymentAvailability,
  type DeploymentObservation,
  type DeploymentState,
  type DeploymentUnavailableReason,
  type RemoteRateLimit,
} from '@deploytruth/core';
import { z } from 'zod';

import type {
  ObservationContext,
  ProviderDiagnostic,
  ReadOnlyTransport,
  TruthProvider,
} from '../contracts.js';
import { TransportError } from '../readonly-fetch.js';
import { resolveVercelCredential } from './credentials.js';
import { createVercelTransport } from './transport.js';

/** Vercel project name or `prj_` id — a safe URL-path segment. Same grammar as the manifest. */
export const VERCEL_PROJECT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;

/** A Vercel team slug or `team_` id — the single optional account scope. */
export const VERCEL_SCOPE_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,127})$/;

/** A bare hostname; the manifest normalizes to lowercase before validation. */
export const HOSTNAME_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const vercelDeploymentConfigSchema = z
  .object({
    project: z
      .string()
      .regex(
        VERCEL_PROJECT_PATTERN,
        'project must be a Vercel project name or id (letters, digits, . _ -)',
      ),
    /** Only the production target is observed in M3. */
    target: z.literal('production').optional(),
    scope: z
      .string()
      .regex(
        VERCEL_SCOPE_PATTERN,
        'scope must be a Vercel team slug or team_... id (letters, digits, _ -)',
      )
      .optional(),
    domain: z
      .string()
      .toLowerCase()
      .regex(HOSTNAME_PATTERN, 'domain must be a bare hostname (for example app.example.com)')
      .optional(),
  })
  .strict();
export type VercelDeploymentConfig = z.infer<typeof vercelDeploymentConfigSchema>;

export interface VercelProviderOptions {
  /** Injectable read-only transport; production uses the fetch-based Vercel transport. */
  readonly transport?: ReadOnlyTransport;
  /** Environment used to resolve credentials; defaults to process.env at call time. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Vercel REST base URL; injectable for tests. */
  readonly apiBaseUrl?: string;
  readonly timeoutMs?: number;
}

const DEFAULT_API_BASE_URL = 'https://api.vercel.com';

/**
 * Minimal Vercel payload shapes. Only the fields DeployTruth needs are picked; the rest of the
 * raw payload (including any environment-variable metadata) is discarded inside the adapter and
 * never crosses the package boundary.
 */
const projectAliasEntrySchema = z.object({
  /** The domain or *.vercel.app hostname this alias entry describes. */
  domain: z.string().min(1),
  /** `PRODUCTION` marks production domain assignments; preview/branch aliases are excluded. */
  target: z.string().nullable().optional(),
  /** Alias environment classification; used when `target` is absent. */
  environment: z.string().nullable().optional(),
  /** Redirect entries do not serve a deployment and are never production evidence. */
  redirect: z.string().nullable().optional(),
  deployment: z
    .object({
      id: z.string().min(1),
      url: z.string().min(1).optional(),
      createdAt: z.number().optional(),
    })
    .nullable()
    .optional(),
});

const projectPayloadSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  alias: z.array(projectAliasEntrySchema).optional(),
});

const deploymentPayloadSchema = z.object({
  id: z.string().min(1),
  url: z.string().min(1).optional(),
  createdAt: z.number().optional(),
  readyState: z.string().min(1).optional(),
  target: z.string().nullable().optional(),
  /** Arbitrary provider metadata; Git-connected deployments record commit facts here. */
  meta: z.record(z.string()).optional(),
  gitSource: z
    .object({
      sha: z.string().min(1).optional(),
      ref: z.string().min(1).optional(),
      org: z.string().min(1).optional(),
      repo: z.string().min(1).optional(),
    })
    .passthrough()
    .optional(),
  alias: z.array(z.string()).optional(),
});

type ProjectAliasEntry = z.infer<typeof projectAliasEntrySchema>;

type FetchSuccess = {
  readonly ok: true;
  readonly body: unknown;
  readonly rateLimit?: RemoteRateLimit;
};

type FetchFailure = {
  readonly ok: false;
  readonly reason: DeploymentUnavailableReason;
  readonly detail: string;
  readonly rateLimit?: RemoteRateLimit;
};

type FetchOutcome = FetchSuccess | FetchFailure;

type AvailabilityTarget = 'project' | 'deployment';

const rateLimitFrom = (headers: Readonly<Record<string, string>>): RemoteRateLimit | undefined => {
  const limit = Number(headers['x-ratelimit-limit']);
  const remaining = Number(headers['x-ratelimit-remaining']);
  const reset = Number(headers['x-ratelimit-reset']);
  const retryAfter = Number(headers['retry-after']);
  const parsed = {
    ...(Number.isFinite(limit) ? { limit } : {}),
    ...(Number.isFinite(remaining) ? { remaining } : {}),
    ...(Number.isFinite(reset) && reset > 0
      ? { resetAt: new Date(reset * 1000).toISOString() }
      : {}),
    ...(Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfter } : {}),
  };
  return Object.keys(parsed).length > 0 ? parsed : undefined;
};

const reasonForStatus = (
  status: number,
  headers: Readonly<Record<string, string>>,
): DeploymentUnavailableReason => {
  if (status === 401) {
    return 'unauthorized';
  }
  if (status === 404) {
    return 'not_found';
  }
  if (status === 429) {
    return 'rate_limited';
  }
  // An exhausted quota can surface as 403; the remaining-count header separates it from a real
  // authorization denial.
  if (status === 403) {
    return headers['x-ratelimit-remaining'] === '0' ? 'rate_limited' : 'forbidden';
  }
  return status >= 500 && status <= 599 ? 'server_error' : 'unexpected_status';
};

const detailFor = (
  reason: DeploymentUnavailableReason,
  target: AvailabilityTarget,
  status?: number,
): string => {
  switch (reason) {
    case 'missing_credentials':
      return 'No Vercel token is configured; set DEPLOYTRUTH_VERCEL_TOKEN or VERCEL_TOKEN.';
    case 'deployment_unavailable':
      return 'Vercel did not identify a current production deployment for this project.';
    case 'ambiguous':
      return 'Vercel production domains resolve to different deployments; which deployment serves production is ambiguous.';
    case 'not_found':
      return target === 'project'
        ? 'Vercel returned not found; the project is absent, renamed, or not visible to the configured credentials and scope.'
        : 'Vercel returned not found for the deployment the production domain points to.';
    case 'unauthorized':
      return 'Vercel rejected the configured credentials (HTTP 401).';
    case 'forbidden':
      return 'Vercel denied access to the resource (HTTP 403); check the token scope and optional team scope.';
    case 'rate_limited':
      return 'Vercel API rate limit exceeded.';
    case 'server_error':
      return 'Vercel API returned a server error.';
    case 'malformed_response':
      return 'Vercel returned a response that did not match the expected shape.';
    case 'network_error':
      return 'The Vercel API could not be reached.';
    case 'timeout':
      return 'The Vercel API request timed out.';
    case 'aborted':
      return 'The Vercel API request was aborted.';
    case 'unexpected_status':
      return `Vercel returned HTTP ${status ?? 'unknown'}.`;
  }
};

const transportReason = (error: unknown): DeploymentUnavailableReason => {
  if (error instanceof TransportError) {
    if (error.code === 'TIMEOUT') {
      return 'timeout';
    }
    if (error.code === 'ABORTED') {
      return 'aborted';
    }
  }
  return 'network_error';
};

/** Issues one GET through the read-only transport and normalizes every failure mode. */
const fetchJson = async (
  transport: ReadOnlyTransport,
  url: string,
  target: AvailabilityTarget,
  signal: AbortSignal | undefined,
): Promise<FetchOutcome> => {
  let response;
  try {
    response = await transport.get({
      url,
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch (error) {
    const reason = transportReason(error);
    return { ok: false, reason, detail: detailFor(reason, target) };
  }

  const rateLimit = rateLimitFrom(response.headers);
  if (response.status !== 200) {
    const reason = reasonForStatus(response.status, response.headers);
    return {
      ok: false,
      reason,
      detail: detailFor(reason, target, response.status),
      ...(rateLimit !== undefined ? { rateLimit } : {}),
    };
  }
  return {
    ok: true,
    body: response.body,
    ...(rateLimit !== undefined ? { rateLimit } : {}),
  };
};

const unavailableAvailability = (
  failure: FetchFailure,
  target: AvailabilityTarget,
): DeploymentAvailability => ({
  state: 'unavailable',
  target,
  reason: failure.reason,
  detail: failure.detail,
  ...(failure.rateLimit !== undefined ? { rateLimit: failure.rateLimit } : {}),
});

/** `team_...` ids map to the teamId parameter; anything else is a team slug. */
const scopeQuery = (scope: string | undefined): string | undefined => {
  if (scope === undefined) {
    return undefined;
  }
  const parameter = scope.startsWith('team_') ? 'teamId' : 'slug';
  return `${parameter}=${encodeURIComponent(scope)}`;
};

const projectUrl = (apiBaseUrl: string, project: string, scope?: string): string => {
  const query = scopeQuery(scope);
  return `${apiBaseUrl}/v9/projects/${encodeURIComponent(project)}${query ? `?${query}` : ''}`;
};

const deploymentUrl = (apiBaseUrl: string, deploymentId: string, scope?: string): string => {
  const query = ['withGitRepoInfo=true', scopeQuery(scope)]
    .filter((part): part is string => part !== undefined)
    .join('&');
  return `${apiBaseUrl}/v13/deployments/${encodeURIComponent(deploymentId)}?${query}`;
};

/**
 * Whether an alias entry is a production domain assignment: `target` wins over `environment`
 * when both are present, redirects never count, and an assigned deployment id is required.
 */
const isProductionAlias = (entry: ProjectAliasEntry): boolean => {
  if (entry.redirect !== undefined && entry.redirect !== null) {
    return false;
  }
  const classification = entry.target ?? entry.environment;
  return classification?.toLowerCase() === 'production' && entry.deployment?.id !== undefined;
};

interface ProductionAssignmentEvidence {
  readonly domain: string;
  readonly deploymentId: string;
}

type ProductionResolution =
  | {
      readonly kind: 'resolved';
      readonly deploymentId: string;
      readonly productionDomains: readonly string[];
    }
  | {
      readonly kind: 'ambiguous';
      readonly assignments: readonly ProductionAssignmentEvidence[];
    }
  | {
      readonly kind: 'unassigned';
      readonly assignments: readonly ProductionAssignmentEvidence[];
    };

/**
 * Resolves the deployment currently serving production. Production domain aliases are the
 * routing-layer assignment: instant rollbacks re-point them to an existing deployment without
 * creating a new one, so "newest production deployment" is not authoritative (ADR 005).
 *
 * Resolution never picks a deployment by majority, recency, or tie-break — that would
 * fabricate certainty:
 *
 * - A declared `domain` is the authoritative routing identity. Production is exactly the
 *   deployment its production alias points at; if the declared domain has no production
 *   assignment the result is `unassigned` — other aliases are never used as a fallback.
 * - Without a declared domain, production resolves only when every production alias agrees
 *   on a single deployment. Zero assignments are `unassigned`; divergent aliases are
 *   `ambiguous` and carry the normalized domain→deployment evidence.
 */
const resolveProduction = (
  aliases: readonly ProjectAliasEntry[],
  declaredDomain: string | undefined,
): ProductionResolution => {
  const assignments = aliases
    .filter(isProductionAlias)
    .flatMap((entry) => {
      const deploymentId = entry.deployment?.id;
      return deploymentId === undefined ? [] : [{ domain: entry.domain, deploymentId }];
    })
    .sort(
      (left, right) =>
        left.domain.localeCompare(right.domain) ||
        left.deploymentId.localeCompare(right.deploymentId),
    );

  if (declaredDomain !== undefined) {
    const declared = assignments.filter((assignment) => assignment.domain === declaredDomain);
    const declaredIds = new Set(declared.map((assignment) => assignment.deploymentId));
    if (declaredIds.size === 0) {
      return { kind: 'unassigned', assignments };
    }
    if (declaredIds.size > 1) {
      // Contradictory duplicate assignments for the declared domain are ambiguous, not a
      // first-match guess.
      return { kind: 'ambiguous', assignments };
    }
    const declaredId = declared[0]?.deploymentId;
    if (declaredId === undefined) {
      return { kind: 'unassigned', assignments };
    }
    return {
      kind: 'resolved',
      deploymentId: declaredId,
      productionDomains: [
        ...new Set(
          assignments
            .filter((assignment) => assignment.deploymentId === declaredId)
            .map((assignment) => assignment.domain),
        ),
      ],
    };
  }

  const deploymentIds = new Set(assignments.map((assignment) => assignment.deploymentId));
  if (deploymentIds.size > 1) {
    return { kind: 'ambiguous', assignments };
  }
  const only = assignments[0];
  if (only === undefined) {
    return { kind: 'unassigned', assignments };
  }
  return {
    kind: 'resolved',
    deploymentId: only.deploymentId,
    productionDomains: [...new Set(assignments.map((assignment) => assignment.domain))],
  };
};

const normalizeState = (readyState: string | undefined): DeploymentState => {
  switch (readyState) {
    case 'READY':
      return 'ready';
    case 'BUILDING':
    case 'INITIALIZING':
      return 'building';
    case 'QUEUED':
      return 'queued';
    case 'ERROR':
      return 'error';
    case 'CANCELED':
      return 'canceled';
    default:
      // BLOCKED or an unrecognized state: honestly unknown rather than assumed ready.
      return 'unknown';
  }
};

const firstMetaValue = (
  meta: Readonly<Record<string, string>> | undefined,
  keys: readonly string[],
): string | undefined => {
  for (const key of keys) {
    const value = meta?.[key]?.trim();
    if (value !== undefined && value.length > 0) {
      return value;
    }
  }
  return undefined;
};

/**
 * The source commit SHA comes only from Vercel's own deployment metadata — never inferred from
 * deployment ids, URLs, timestamps, or GitHub state (ADR 005).
 */
const extractSourceSha = (
  deployment: z.infer<typeof deploymentPayloadSchema>,
): string | undefined =>
  firstMetaValue(deployment.meta, ['githubCommitSha', 'gitlabCommitSha', 'bitbucketCommitSha']) ??
  deployment.gitSource?.sha;

const extractSourceBranch = (
  deployment: z.infer<typeof deploymentPayloadSchema>,
): string | undefined =>
  firstMetaValue(deployment.meta, ['githubCommitRef', 'gitlabCommitRef', 'bitbucketCommitRef']) ??
  deployment.gitSource?.ref;

const extractSourceRepository = (
  deployment: z.infer<typeof deploymentPayloadSchema>,
): string | undefined => {
  const org = firstMetaValue(deployment.meta, ['githubOrg', 'gitlabOrg', 'bitbucketOrg']);
  const repo = firstMetaValue(deployment.meta, ['githubRepo', 'gitlabRepo', 'bitbucketRepo']);
  if (org !== undefined && repo !== undefined) {
    return `${org}/${repo}`;
  }
  const gitSource = deployment.gitSource;
  if (gitSource?.org !== undefined && gitSource.repo !== undefined) {
    return `${gitSource.org}/${gitSource.repo}`;
  }
  return undefined;
};

const missingCredentialsObservation = (config: VercelDeploymentConfig): DeploymentObservation =>
  deploymentObservationSchema.parse({
    provider: 'vercel',
    project: config.project,
    target: 'production',
    environment: 'production',
    availability: {
      state: 'unavailable',
      target: 'project',
      reason: 'missing_credentials',
      detail: detailFor('missing_credentials', 'project'),
    },
    ...(config.domain !== undefined ? { stableDomain: config.domain } : {}),
  });

const unavailableObservation = (
  config: VercelDeploymentConfig,
  failure: FetchFailure,
  target: AvailabilityTarget,
  extras: Readonly<Record<string, unknown>> = {},
): DeploymentObservation =>
  deploymentObservationSchema.parse({
    provider: 'vercel',
    project: config.project,
    target: 'production',
    environment: 'production',
    availability: unavailableAvailability(failure, target),
    ...(config.domain !== undefined ? { stableDomain: config.domain } : {}),
    ...extras,
  });

const observeDeployment = async (
  context: ObservationContext<VercelDeploymentConfig>,
  transport: ReadOnlyTransport,
  apiBaseUrl: string,
): Promise<DeploymentObservation> => {
  const { config } = context;

  const projectResult = await fetchJson(
    transport,
    projectUrl(apiBaseUrl, config.project, config.scope),
    'project',
    context.signal,
  );
  if (!projectResult.ok) {
    return unavailableObservation(config, projectResult, 'project');
  }

  const projectPayload = projectPayloadSchema.safeParse(projectResult.body);
  if (!projectPayload.success) {
    return unavailableObservation(
      config,
      {
        ok: false,
        reason: 'malformed_response',
        detail: detailFor('malformed_response', 'project'),
        ...(projectResult.rateLimit !== undefined ? { rateLimit: projectResult.rateLimit } : {}),
      },
      'project',
    );
  }

  const aliases = projectPayload.data.alias ?? [];
  const production = resolveProduction(aliases, config.domain);
  if (production.kind !== 'resolved') {
    const ambiguous = production.kind === 'ambiguous';
    const detail = ambiguous
      ? `Production domains resolve to different deployments (${production.assignments
          .map((assignment) => `${assignment.domain} -> ${assignment.deploymentId}`)
          .join(', ')}); DeployTruth does not guess which deployment serves production.`
      : config.domain !== undefined
        ? `The declared domain ${config.domain} is not assigned to a production deployment; other production aliases are not used as a fallback.`
        : 'No production domain is assigned to a deployment; Vercel cannot identify a current production deployment.';
    return unavailableObservation(
      config,
      {
        ok: false,
        reason: ambiguous ? 'ambiguous' : 'deployment_unavailable',
        detail,
        ...(projectResult.rateLimit !== undefined ? { rateLimit: projectResult.rateLimit } : {}),
      },
      'deployment',
      production.assignments.length > 0 ? { productionAssignments: production.assignments } : {},
    );
  }

  const deploymentResult = await fetchJson(
    transport,
    deploymentUrl(apiBaseUrl, production.deploymentId, config.scope),
    'deployment',
    context.signal,
  );
  if (!deploymentResult.ok) {
    return unavailableObservation(config, deploymentResult, 'deployment');
  }

  const deploymentPayload = deploymentPayloadSchema.safeParse(deploymentResult.body);
  if (!deploymentPayload.success) {
    return unavailableObservation(
      config,
      {
        ok: false,
        reason: 'malformed_response',
        detail: detailFor('malformed_response', 'deployment'),
        ...(deploymentResult.rateLimit !== undefined
          ? { rateLimit: deploymentResult.rateLimit }
          : {}),
      },
      'deployment',
    );
  }

  const deployment = deploymentPayload.data;
  // A declared domain is the authoritative routing identity: when it resolves, the observed
  // production deployment is the domain's own assignment by construction, so the domain is
  // verified. When it does not resolve, the observation is unavailable and never reaches
  // here — there is no fallback that could make verification inconclusive.
  const stableDomainVerified = config.domain !== undefined ? true : undefined;

  return deploymentObservationSchema.parse({
    provider: 'vercel',
    availability: {
      state: 'available',
      ...(deploymentResult.rateLimit !== undefined
        ? { rateLimit: deploymentResult.rateLimit }
        : projectResult.rateLimit !== undefined
          ? { rateLimit: projectResult.rateLimit }
          : {}),
    },
    project: config.project,
    target: 'production',
    environment: 'production',
    deploymentId: deployment.id,
    ...(deployment.url !== undefined ? { deploymentUrl: `https://${deployment.url}` } : {}),
    state: normalizeState(deployment.readyState),
    ...(deployment.createdAt !== undefined
      ? { createdAt: new Date(deployment.createdAt).toISOString() }
      : {}),
    ...(extractSourceSha(deployment) !== undefined
      ? { commitSha: extractSourceSha(deployment) }
      : {}),
    ...(extractSourceBranch(deployment) !== undefined
      ? { sourceBranch: extractSourceBranch(deployment) }
      : {}),
    ...(extractSourceRepository(deployment) !== undefined
      ? { sourceRepository: extractSourceRepository(deployment) }
      : {}),
    ...(config.domain !== undefined ? { stableDomain: config.domain } : {}),
    ...(stableDomainVerified !== undefined ? { stableDomainVerified } : {}),
  });
};

const diagnostic = (
  code: string,
  title: string,
  status: ProviderDiagnostic['status'],
  message: string,
): ProviderDiagnostic => ({ code, title, status, message });

const diagnoseDeployment = async (
  context: ObservationContext<VercelDeploymentConfig>,
  transport: ReadOnlyTransport | undefined,
  apiBaseUrl: string,
): Promise<readonly ProviderDiagnostic[]> => {
  const { config } = context;
  const diagnostics: ProviderDiagnostic[] = [];

  if (transport === undefined) {
    diagnostics.push(
      diagnostic('VERCEL_API', 'Vercel API', 'warning', 'not queried — no credentials resolved'),
      diagnostic(
        'VERCEL_PROJECT',
        `Project ${config.project}`,
        'error',
        detailFor('missing_credentials', 'project'),
      ),
    );
    return diagnostics;
  }

  const projectResult = await fetchJson(
    transport,
    projectUrl(apiBaseUrl, config.project, config.scope),
    'project',
    context.signal,
  );
  if (!projectResult.ok) {
    const networkLevel = ['network_error', 'timeout', 'aborted'].includes(projectResult.reason);
    diagnostics.push(
      diagnostic(
        'VERCEL_API',
        'Vercel API',
        networkLevel ? 'error' : 'ok',
        networkLevel ? projectResult.detail : 'reachable',
      ),
      diagnostic('VERCEL_PROJECT', `Project ${config.project}`, 'error', projectResult.detail),
    );
    return diagnostics;
  }

  diagnostics.push(diagnostic('VERCEL_API', 'Vercel API', 'ok', 'reachable'));

  const projectPayload = projectPayloadSchema.safeParse(projectResult.body);
  if (!projectPayload.success) {
    diagnostics.push(
      diagnostic(
        'VERCEL_PROJECT',
        `Project ${config.project}`,
        'error',
        detailFor('malformed_response', 'project'),
      ),
    );
    return diagnostics;
  }

  diagnostics.push(
    diagnostic(
      'VERCEL_PROJECT',
      `Project ${config.project}`,
      'ok',
      `accessible (id ${projectPayload.data.id})`,
    ),
  );

  const aliases = projectPayload.data.alias ?? [];
  const production = resolveProduction(aliases, config.domain);
  if (production.kind === 'unassigned') {
    diagnostics.push(
      diagnostic(
        'VERCEL_PRODUCTION',
        'Production deployment',
        'error',
        config.domain !== undefined
          ? `declared domain ${config.domain} is not assigned to a production deployment`
          : 'no production domain is assigned to a deployment',
      ),
    );
    return diagnostics;
  }
  if (production.kind === 'ambiguous') {
    diagnostics.push(
      diagnostic(
        'VERCEL_PRODUCTION',
        'Production deployment',
        'error',
        `ambiguous — ${production.assignments
          .map((assignment) => `${assignment.domain} -> ${assignment.deploymentId}`)
          .join(', ')}`,
      ),
    );
    return diagnostics;
  }

  const deploymentResult = await fetchJson(
    transport,
    deploymentUrl(apiBaseUrl, production.deploymentId, config.scope),
    'deployment',
    context.signal,
  );
  if (!deploymentResult.ok) {
    diagnostics.push(
      diagnostic('VERCEL_PRODUCTION', 'Production deployment', 'error', deploymentResult.detail),
    );
    return diagnostics;
  }

  const deploymentPayload = deploymentPayloadSchema.safeParse(deploymentResult.body);
  if (!deploymentPayload.success) {
    diagnostics.push(
      diagnostic(
        'VERCEL_PRODUCTION',
        'Production deployment',
        'error',
        detailFor('malformed_response', 'deployment'),
      ),
    );
    return diagnostics;
  }

  const deployment = deploymentPayload.data;
  const state = normalizeState(deployment.readyState);
  diagnostics.push(
    diagnostic(
      'VERCEL_PRODUCTION',
      'Production deployment',
      state === 'ready' ? 'ok' : 'warning',
      `${deployment.id} ${state.toUpperCase()} via ${production.productionDomains.join(', ')}`,
    ),
  );

  const sha = extractSourceSha(deployment);
  diagnostics.push(
    diagnostic(
      'VERCEL_SOURCE_METADATA',
      'Deployment source metadata',
      sha !== undefined ? 'ok' : 'warning',
      sha !== undefined
        ? `source commit ${sha.slice(0, 7)}${extractSourceBranch(deployment) ? ` on ${extractSourceBranch(deployment)}` : ''}`
        : 'no source commit recorded by Vercel for this deployment',
    ),
  );

  if (config.domain !== undefined) {
    // Reaching here means the declared domain's own production assignment resolved
    // production — the domain is verified by construction.
    diagnostics.push(
      diagnostic(
        'VERCEL_DOMAIN',
        `Domain ${config.domain}`,
        'ok',
        'resolves to the current production deployment',
      ),
    );
  }

  const rateLimit = deploymentResult.rateLimit ?? projectResult.rateLimit;
  if (rateLimit !== undefined) {
    const exhausted = rateLimit.remaining === 0;
    diagnostics.push(
      diagnostic(
        'VERCEL_RATE_LIMIT',
        'Vercel rate limit',
        exhausted ? 'warning' : 'ok',
        [
          rateLimit.remaining !== undefined && rateLimit.limit !== undefined
            ? `${rateLimit.remaining}/${rateLimit.limit} requests remaining`
            : undefined,
          rateLimit.resetAt !== undefined ? `resets at ${rateLimit.resetAt}` : undefined,
          rateLimit.retryAfter !== undefined ? `retry after ${rateLimit.retryAfter}s` : undefined,
        ]
          .filter((part): part is string => part !== undefined)
          .join('; ') || 'rate limit metadata observed',
      ),
    );
  }

  return diagnostics;
};

/**
 * Vercel production deployment-truth adapter. It performs read-only REST calls — project
 * metadata for identity and domain→deployment assignments, then the current production
 * deployment for state and source metadata — and returns a normalized `DeploymentObservation`.
 * All failure modes produce an `unavailable` observation instead of fabricated truth, and the
 * token never leaves the transport closure.
 */
export const createVercelProvider = (
  options: VercelProviderOptions = {},
): TruthProvider<VercelDeploymentConfig, DeploymentObservation> => {
  const apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  // Built lazily so credentials resolve at observation time, not module import time.
  let transport = options.transport;
  const resolvedTransport = (): ReadOnlyTransport | undefined => {
    if (transport === undefined) {
      const credential = resolveVercelCredential(options.env ?? process.env);
      if (credential === undefined) {
        return undefined;
      }
      transport = createVercelTransport({
        token: credential.token,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
    }
    return transport;
  };

  return {
    id: 'vercel',
    capabilities: ['deployment'],
    validateConfig: (config: unknown) => vercelDeploymentConfigSchema.parse(config),
    observe: (context: ObservationContext<VercelDeploymentConfig>) => {
      const resolved = context.transport ?? resolvedTransport();
      return resolved === undefined
        ? Promise.resolve(missingCredentialsObservation(context.config))
        : observeDeployment(context, resolved, apiBaseUrl);
    },
    diagnose: (context: ObservationContext<VercelDeploymentConfig>) =>
      diagnoseDeployment(context, context.transport ?? resolvedTransport(), apiBaseUrl),
  };
};
