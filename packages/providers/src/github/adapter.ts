import {
  sourceObservationSchema,
  type RemoteRateLimit,
  type RemoteUnavailableReason,
  type SourceAvailability,
  type SourceObservation,
} from '@deploytruth/core';
import { z } from 'zod';

import type {
  ObservationContext,
  ProviderDiagnostic,
  ReadOnlyTransport,
  TruthProvider,
} from '../contracts.js';
import { resolveGitHubCredential } from './credentials.js';
import { createGitHubTransport, TransportError } from './transport.js';

/**
 * `owner/repo` only — identical grammar to the manifest declaration. URLs, extra path
 * segments, and bare names are rejected.
 */
export const GITHUB_REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

/** Same safe branch subset the manifest enforces; keeps the name URL-path safe unencoded. */
const GIT_BRANCH_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,254})$/;

export const gitHubSourceConfigSchema = z
  .object({
    repository: z
      .string()
      .regex(
        GITHUB_REPOSITORY_PATTERN,
        'repository must be in owner/repo form (for example acme/meridia)',
      ),
    branch: z
      .string()
      .regex(
        GIT_BRANCH_PATTERN,
        'branch may only contain letters, digits, and . _ / - and must start with an alphanumeric',
      )
      .refine(
        (value) =>
          !value.includes('..') &&
          !value.includes('//') &&
          !value.includes('@{') &&
          !value.endsWith('/') &&
          !value.endsWith('.'),
        { message: 'branch must be a valid Git ref name' },
      ),
  })
  .strict();
export type GitHubSourceConfig = z.infer<typeof gitHubSourceConfigSchema>;

export interface GitHubProviderOptions {
  /** Injectable read-only transport; production uses the fetch-based GitHub transport. */
  readonly transport?: ReadOnlyTransport;
  /** Environment used to resolve credentials; defaults to process.env at call time. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** GitHub REST base URL; injectable for tests. */
  readonly apiBaseUrl?: string;
  readonly timeoutMs?: number;
}

const DEFAULT_API_BASE_URL = 'https://api.github.com';

/**
 * Minimal GitHub payload shapes. Only the fields DeployTruth needs are picked; the rest of the
 * raw payload is discarded inside the adapter and never crosses the package boundary.
 */
const repositoryPayloadSchema = z.object({
  default_branch: z.string().min(1),
  visibility: z.enum(['public', 'private', 'internal']).optional(),
  private: z.boolean().optional(),
  archived: z.boolean().optional(),
});

const branchPayloadSchema = z.object({
  commit: z.object({ sha: z.string().min(1) }),
});

type FetchSuccess = {
  readonly ok: true;
  readonly body: unknown;
  readonly rateLimit?: RemoteRateLimit;
};

type FetchFailure = {
  readonly ok: false;
  readonly reason: RemoteUnavailableReason;
  readonly detail: string;
  readonly rateLimit?: RemoteRateLimit;
};

type FetchOutcome = FetchSuccess | FetchFailure;

const rateLimitFrom = (headers: Readonly<Record<string, string>>): RemoteRateLimit | undefined => {
  const limit = Number(headers['x-ratelimit-limit']);
  const remaining = Number(headers['x-ratelimit-remaining']);
  const reset = Number(headers['x-ratelimit-reset']);
  const parsed = {
    ...(Number.isFinite(limit) ? { limit } : {}),
    ...(Number.isFinite(remaining) ? { remaining } : {}),
    ...(Number.isFinite(reset) && reset > 0
      ? { resetAt: new Date(reset * 1000).toISOString() }
      : {}),
  };
  return Object.keys(parsed).length > 0 ? parsed : undefined;
};

const reasonForStatus = (
  status: number,
  headers: Readonly<Record<string, string>>,
): RemoteUnavailableReason => {
  if (status === 401) {
    return 'unauthorized';
  }
  if (status === 404) {
    return 'not_found';
  }
  if (status === 429) {
    return 'rate_limited';
  }
  // GitHub also answers 403 for exhausted rate limits; the remaining-count header separates
  // an exhausted quota from a real authorization denial.
  if (status === 403) {
    return headers['x-ratelimit-remaining'] === '0' ? 'rate_limited' : 'forbidden';
  }
  return status >= 500 && status <= 599 ? 'server_error' : 'unexpected_status';
};

const detailFor = (
  reason: RemoteUnavailableReason,
  target: 'repository' | 'branch',
  status?: number,
): string => {
  switch (reason) {
    case 'not_found':
      return target === 'repository'
        ? 'GitHub returned not found; the repository is absent, renamed, or private without access.'
        : 'GitHub returned not found for the declared branch; it is absent or access is restricted.';
    case 'unauthorized':
      return 'GitHub rejected the configured credentials (HTTP 401).';
    case 'forbidden':
      return 'GitHub denied access to the resource (HTTP 403).';
    case 'rate_limited':
      return 'GitHub API rate limit exceeded.';
    case 'server_error':
      return 'GitHub API returned a server error.';
    case 'malformed_response':
      return 'GitHub returned a response that did not match the expected shape.';
    case 'network_error':
      return 'The GitHub API could not be reached.';
    case 'timeout':
      return 'The GitHub API request timed out.';
    case 'aborted':
      return 'The GitHub API request was aborted.';
    case 'unexpected_status':
      return `GitHub returned HTTP ${status ?? 'unknown'}.`;
  }
};

const transportReason = (error: unknown): RemoteUnavailableReason => {
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
  target: 'repository' | 'branch',
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
  target: 'repository' | 'branch',
): SourceAvailability => ({
  state: 'unavailable',
  target,
  reason: failure.reason,
  detail: failure.detail,
  ...(failure.rateLimit !== undefined ? { rateLimit: failure.rateLimit } : {}),
});

const observeSource = async (
  context: ObservationContext<GitHubSourceConfig>,
  transport: ReadOnlyTransport,
  apiBaseUrl: string,
): Promise<SourceObservation> => {
  const { repository, branch } = context.config;
  const repositoryResult = await fetchJson(
    transport,
    `${apiBaseUrl}/repos/${repository}`,
    'repository',
    context.signal,
  );

  if (!repositoryResult.ok) {
    return sourceObservationSchema.parse({
      provider: 'github',
      repository,
      branch,
      availability: unavailableAvailability(repositoryResult, 'repository'),
    });
  }

  const repositoryPayload = repositoryPayloadSchema.safeParse(repositoryResult.body);
  if (!repositoryPayload.success) {
    return sourceObservationSchema.parse({
      provider: 'github',
      repository,
      branch,
      availability: {
        state: 'unavailable',
        target: 'repository',
        reason: 'malformed_response',
        detail: detailFor('malformed_response', 'repository'),
        ...(repositoryResult.rateLimit !== undefined
          ? { rateLimit: repositoryResult.rateLimit }
          : {}),
      },
    });
  }

  const visibility =
    repositoryPayload.data.visibility ??
    (repositoryPayload.data.private === true
      ? 'private'
      : repositoryPayload.data.private === false
        ? 'public'
        : undefined);
  const repositoryFacts = {
    defaultBranch: repositoryPayload.data.default_branch,
    ...(visibility !== undefined ? { visibility } : {}),
    ...(repositoryPayload.data.archived !== undefined
      ? { archived: repositoryPayload.data.archived }
      : {}),
  };

  // `branch` is inserted raw: the config grammar restricts it to URL-path-safe characters,
  // which keeps `feature/x` style names intact for the GitHub API.
  const branchResult = await fetchJson(
    transport,
    `${apiBaseUrl}/repos/${repository}/branches/${branch}`,
    'branch',
    context.signal,
  );

  if (!branchResult.ok) {
    return sourceObservationSchema.parse({
      provider: 'github',
      repository,
      branch,
      ...repositoryFacts,
      availability: unavailableAvailability(branchResult, 'branch'),
    });
  }

  const branchPayload = branchPayloadSchema.safeParse(branchResult.body);
  if (!branchPayload.success) {
    return sourceObservationSchema.parse({
      provider: 'github',
      repository,
      branch,
      ...repositoryFacts,
      availability: {
        state: 'unavailable',
        target: 'branch',
        reason: 'malformed_response',
        detail: detailFor('malformed_response', 'branch'),
        ...(branchResult.rateLimit !== undefined ? { rateLimit: branchResult.rateLimit } : {}),
      },
    });
  }

  return sourceObservationSchema.parse({
    provider: 'github',
    repository,
    branch,
    remoteHeadSha: branchPayload.data.commit.sha,
    ...repositoryFacts,
    availability: {
      state: 'available',
      ...(branchResult.rateLimit !== undefined
        ? { rateLimit: branchResult.rateLimit }
        : repositoryResult.rateLimit !== undefined
          ? { rateLimit: repositoryResult.rateLimit }
          : {}),
    },
  });
};

const diagnostic = (
  code: string,
  title: string,
  status: ProviderDiagnostic['status'],
  message: string,
): ProviderDiagnostic => ({ code, title, status, message });

const diagnoseSource = async (
  context: ObservationContext<GitHubSourceConfig>,
  transport: ReadOnlyTransport,
  apiBaseUrl: string,
): Promise<readonly ProviderDiagnostic[]> => {
  const { repository, branch } = context.config;
  const diagnostics: ProviderDiagnostic[] = [];

  const repositoryResult = await fetchJson(
    transport,
    `${apiBaseUrl}/repos/${repository}`,
    'repository',
    context.signal,
  );

  if (!repositoryResult.ok) {
    const networkLevel = ['network_error', 'timeout', 'aborted'].includes(repositoryResult.reason);
    diagnostics.push(
      diagnostic(
        'GITHUB_API',
        'GitHub API',
        networkLevel ? 'error' : 'ok',
        networkLevel ? repositoryResult.detail : 'reachable',
      ),
      diagnostic('GITHUB_REPOSITORY', 'GitHub repository', 'error', repositoryResult.detail),
    );
    return diagnostics;
  }

  diagnostics.push(diagnostic('GITHUB_API', 'GitHub API', 'ok', 'reachable'));

  const repositoryPayload = repositoryPayloadSchema.safeParse(repositoryResult.body);
  if (!repositoryPayload.success) {
    diagnostics.push(
      diagnostic(
        'GITHUB_REPOSITORY',
        'GitHub repository',
        'error',
        detailFor('malformed_response', 'repository'),
      ),
    );
    return diagnostics;
  }

  diagnostics.push(
    diagnostic(
      'GITHUB_REPOSITORY',
      'GitHub repository',
      'ok',
      `${repository} accessible; default branch ${repositoryPayload.data.default_branch}`,
    ),
  );

  const branchResult = await fetchJson(
    transport,
    `${apiBaseUrl}/repos/${repository}/branches/${branch}`,
    'branch',
    context.signal,
  );

  if (!branchResult.ok) {
    diagnostics.push(diagnostic('GITHUB_BRANCH', `Branch ${branch}`, 'error', branchResult.detail));
  } else {
    const branchPayload = branchPayloadSchema.safeParse(branchResult.body);
    diagnostics.push(
      branchPayload.success
        ? diagnostic(
            'GITHUB_BRANCH',
            `Branch ${branch}`,
            'ok',
            `accessible; authoritative SHA ${branchPayload.data.commit.sha.slice(0, 7)}`,
          )
        : diagnostic(
            'GITHUB_BRANCH',
            `Branch ${branch}`,
            'error',
            detailFor('malformed_response', 'branch'),
          ),
    );
  }

  const rateLimit = branchResult.rateLimit ?? repositoryResult.rateLimit;
  if (rateLimit !== undefined) {
    const exhausted = rateLimit.remaining === 0;
    diagnostics.push(
      diagnostic(
        'GITHUB_RATE_LIMIT',
        'GitHub rate limit',
        exhausted ? 'warning' : 'ok',
        [
          rateLimit.remaining !== undefined && rateLimit.limit !== undefined
            ? `${rateLimit.remaining}/${rateLimit.limit} requests remaining`
            : undefined,
          rateLimit.resetAt !== undefined ? `resets at ${rateLimit.resetAt}` : undefined,
        ]
          .filter((part): part is string => part !== undefined)
          .join('; ') || 'rate limit metadata observed',
      ),
    );
  }

  return diagnostics;
};

/**
 * GitHub authoritative source-truth adapter. It performs exactly two read-only REST calls —
 * repository metadata and branch metadata — and returns a normalized `SourceObservation`
 * whose `remoteHeadSha`, `defaultBranch`, and `availability` describe what GitHub actually
 * reports. All API failure modes produce an `unavailable` observation instead of fabricated
 * truth; credentials never enter the adapter.
 */
export const createGitHubProvider = (
  options: GitHubProviderOptions = {},
): TruthProvider<GitHubSourceConfig, SourceObservation> => {
  const apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  // Built lazily so credentials resolve at observation time, not module import time.
  let transport = options.transport;
  const resolvedTransport = (): ReadOnlyTransport => {
    if (transport === undefined) {
      const credential = resolveGitHubCredential(options.env ?? process.env);
      transport = createGitHubTransport({
        ...(credential !== undefined ? { token: credential.token } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
    }
    return transport;
  };

  return {
    id: 'github',
    capabilities: ['source'],
    validateConfig: (config: unknown) => gitHubSourceConfigSchema.parse(config),
    observe: (context: ObservationContext<GitHubSourceConfig>) =>
      observeSource(context, context.transport ?? resolvedTransport(), apiBaseUrl),
    diagnose: (context: ObservationContext<GitHubSourceConfig>) =>
      diagnoseSource(context, context.transport ?? resolvedTransport(), apiBaseUrl),
  };
};
