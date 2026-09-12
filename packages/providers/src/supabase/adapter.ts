import {
  databaseObservationSchema,
  type DatabaseControlPlane,
  type DatabaseObservation,
  type DatabaseProjectState,
  type DatabaseUnavailableReason,
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
import {
  resolveSupabaseDatabaseCredential,
  resolveSupabaseManagementCredential,
} from './credentials.js';
import { createPgDatabaseReader, type SupabaseDatabaseReader } from './database-reader.js';
import { SUPABASE_PROJECT_REF_PATTERN } from './identity.js';
import { createSupabaseTransport } from './transport.js';

export const supabaseDatabaseConfigSchema = z
  .object({
    projectRef: z
      .string()
      .regex(
        SUPABASE_PROJECT_REF_PATTERN,
        'projectRef must be a Supabase project ref (lowercase letters and digits)',
      ),
  })
  .strict();
export type SupabaseDatabaseConfig = z.infer<typeof supabaseDatabaseConfigSchema>;

export interface SupabaseProviderOptions {
  /** Injectable read-only transport; production uses the fetch-based Supabase transport. */
  readonly transport?: ReadOnlyTransport;
  /** Environment used to resolve credentials; defaults to process.env at call time. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Supabase Management API base URL; injectable for tests. */
  readonly apiBaseUrl?: string;
  /**
   * Injectable database reader factory. Production creates a `pg`-backed reader over the
   * resolved DEPLOYTRUTH_SUPABASE_DATABASE_URL; tests inject a fake — no live database is
   * ever required.
   */
  readonly databaseReaderFactory?: (databaseUrl: string) => SupabaseDatabaseReader;
  readonly timeoutMs?: number;
}

const DEFAULT_API_BASE_URL = 'https://api.supabase.com';

/**
 * Minimal Management API project shape. Only the fields DeployTruth needs are picked; the
 * rest of the payload (organization, billing, internal configuration, connection strings)
 * is discarded inside the adapter and never crosses the package boundary.
 */
const projectPayloadSchema = z.object({
  ref: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
});

type FetchSuccess = {
  readonly ok: true;
  readonly body: unknown;
  readonly rateLimit?: RemoteRateLimit;
};

type FetchFailure = {
  readonly ok: false;
  readonly reason: DatabaseUnavailableReason;
  readonly detail: string;
  readonly rateLimit?: RemoteRateLimit;
};

type FetchOutcome = FetchSuccess | FetchFailure;

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
): DatabaseUnavailableReason => {
  if (status === 401) {
    return 'unauthorized';
  }
  if (status === 403) {
    return headers['x-ratelimit-remaining'] === '0' ? 'rate_limited' : 'forbidden';
  }
  // The Management API answers 404 both for absent projects and for projects the token
  // cannot see; DeployTruth never claims the project does not exist on ambiguous evidence.
  if (status === 404) {
    return 'not_found_or_inaccessible';
  }
  if (status === 429) {
    return 'rate_limited';
  }
  return status >= 500 && status <= 599 ? 'server_error' : 'unexpected_status';
};

const detailFor = (reason: DatabaseUnavailableReason, status?: number): string => {
  switch (reason) {
    case 'missing_credentials':
      return 'No Supabase Management token is configured; set DEPLOYTRUTH_SUPABASE_ACCESS_TOKEN or SUPABASE_ACCESS_TOKEN.';
    case 'unauthorized':
      return 'Supabase rejected the configured credentials (HTTP 401).';
    case 'forbidden':
      return 'Supabase denied access to the project (HTTP 403).';
    case 'not_found_or_inaccessible':
      return 'Supabase returned not found; the project is absent, renamed, or not visible to the configured credentials.';
    case 'rate_limited':
      return 'Supabase Management API rate limit exceeded.';
    case 'server_error':
      return 'Supabase Management API returned a server error.';
    case 'malformed_response':
      return 'Supabase returned a response that did not match the expected shape.';
    case 'network_error':
      return 'The Supabase Management API could not be reached.';
    case 'timeout':
      return 'The Supabase Management API request timed out.';
    case 'aborted':
      return 'The Supabase Management API request was aborted.';
    case 'unexpected_status':
      return `Supabase returned HTTP ${status ?? 'unknown'}.`;
    default:
      return 'The Supabase Management API request failed.';
  }
};

const transportReason = (error: unknown): DatabaseUnavailableReason => {
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
    return { ok: false, reason, detail: detailFor(reason) };
  }

  const rateLimit = rateLimitFrom(response.headers);
  if (response.status !== 200) {
    const reason = reasonForStatus(response.status, response.headers);
    return {
      ok: false,
      reason,
      detail: detailFor(reason, response.status),
      ...(rateLimit !== undefined ? { rateLimit } : {}),
    };
  }
  return {
    ok: true,
    body: response.body,
    ...(rateLimit !== undefined ? { rateLimit } : {}),
  };
};

const normalizeProjectState = (status: string | undefined): DatabaseProjectState => {
  switch (status) {
    case 'ACTIVE_HEALTHY':
      return 'healthy';
    case 'ACTIVE_UNHEALTHY':
      return 'degraded';
    case 'COMING_UP':
    case 'GOING_DOWN':
    case 'UPGRADING':
    case 'PAUSING':
    case 'RESTARTING':
    case 'RESIZING':
    case 'RESTORING':
      return 'transitioning';
    case 'INACTIVE':
      return 'inactive';
    case 'INIT_FAILED':
    case 'RESTORE_FAILED':
    case 'PAUSE_FAILED':
      return 'failed';
    case 'REMOVED':
      return 'removed';
    default:
      return 'unknown';
  }
};

const unavailableControlPlane = (failure: FetchFailure): DatabaseControlPlane => ({
  state: 'unavailable',
  reason: failure.reason,
  detail: failure.detail,
  ...(failure.rateLimit !== undefined ? { rateLimit: failure.rateLimit } : {}),
});

const projectUrl = (apiBaseUrl: string, projectRef: string): string =>
  `${apiBaseUrl}/v1/projects/${encodeURIComponent(projectRef)}`;

const observeControlPlane = async (
  projectRef: string,
  transport: ReadOnlyTransport,
  apiBaseUrl: string,
  signal: AbortSignal | undefined,
): Promise<DatabaseControlPlane> => {
  const result = await fetchJson(transport, projectUrl(apiBaseUrl, projectRef), signal);
  if (!result.ok) {
    return unavailableControlPlane(result);
  }

  const payload = projectPayloadSchema.safeParse(result.body);
  if (!payload.success || payload.data.ref !== projectRef) {
    return {
      state: 'unavailable',
      reason: 'malformed_response',
      detail: detailFor('malformed_response'),
      ...(result.rateLimit !== undefined ? { rateLimit: result.rateLimit } : {}),
    };
  }

  return {
    state: 'available',
    ...(result.rateLimit !== undefined ? { rateLimit: result.rateLimit } : {}),
    ...(payload.data.name !== undefined ? { projectName: payload.data.name } : {}),
    ...(payload.data.region !== undefined ? { region: payload.data.region } : {}),
    status: normalizeProjectState(payload.data.status),
  };
};

const MISSING_DATABASE_URL_DETAIL =
  'DEPLOYTRUTH_SUPABASE_DATABASE_URL is not configured; DeployTruth never falls back to a generic DATABASE_URL.';
const HISTORY_NEEDS_CONNECTION_DETAIL =
  'No database connection was established; applied migration history is unobserved.';

const observeDatabase = async (
  context: ObservationContext<SupabaseDatabaseConfig>,
  transport: ReadOnlyTransport | undefined,
  env: Readonly<Record<string, string | undefined>>,
  apiBaseUrl: string,
  readerFactory: (databaseUrl: string) => SupabaseDatabaseReader,
): Promise<DatabaseObservation> => {
  const { config } = context;

  const controlPlane =
    transport === undefined
      ? {
          state: 'unavailable' as const,
          reason: 'missing_credentials' as const,
          detail: detailFor('missing_credentials'),
        }
      : await observeControlPlane(config.projectRef, transport, apiBaseUrl, context.signal);

  const databaseCredential = resolveSupabaseDatabaseCredential(env);
  if (databaseCredential === undefined) {
    return databaseObservationSchema.parse({
      provider: 'supabase',
      projectRef: config.projectRef,
      controlPlane,
      connection: {
        state: 'unavailable',
        reason: 'missing_credentials',
        detail: MISSING_DATABASE_URL_DETAIL,
      },
      appliedMigrationIds: [],
      migrationHistory: {
        state: 'unavailable',
        reason: 'connection_unavailable',
        detail: HISTORY_NEEDS_CONNECTION_DETAIL,
      },
    });
  }

  const reader = readerFactory(databaseCredential.url);
  const identityResult = await reader.inspectIdentity();
  if (identityResult.state === 'unavailable') {
    return databaseObservationSchema.parse({
      provider: 'supabase',
      projectRef: config.projectRef,
      controlPlane,
      connection: {
        state: 'unavailable',
        reason: identityResult.reason ?? 'connection_failed',
        ...(identityResult.detail !== undefined ? { detail: identityResult.detail } : {}),
      },
      appliedMigrationIds: [],
      migrationHistory: {
        state: 'unavailable',
        reason: 'connection_unavailable',
        detail: HISTORY_NEEDS_CONNECTION_DETAIL,
      },
    });
  }

  const observedProjectRef = identityResult.observedProjectRef;
  const identity =
    observedProjectRef === undefined
      ? ('unverified' as const)
      : observedProjectRef === config.projectRef
        ? ('verified' as const)
        : ('mismatch' as const);

  const history = await reader.readMigrationHistory();

  return databaseObservationSchema.parse({
    provider: 'supabase',
    projectRef: config.projectRef,
    controlPlane,
    connection: {
      state: 'available',
      ...(identityResult.identitySource !== undefined
        ? { identitySource: identityResult.identitySource }
        : {}),
    },
    ...(observedProjectRef !== undefined ? { observedProjectRef } : {}),
    identity,
    appliedMigrationIds: [...history.appliedVersions],
    migrationHistory:
      history.state === 'available'
        ? { state: 'available' }
        : {
            state: 'unavailable',
            ...(history.reason !== undefined ? { reason: history.reason } : {}),
            ...(history.detail !== undefined ? { detail: history.detail } : {}),
          },
  });
};

const diagnostic = (
  code: string,
  title: string,
  status: ProviderDiagnostic['status'],
  message: string,
): ProviderDiagnostic => ({ code, title, status, message });

const diagnoseDatabase = async (
  context: ObservationContext<SupabaseDatabaseConfig>,
  transport: ReadOnlyTransport | undefined,
  env: Readonly<Record<string, string | undefined>>,
  apiBaseUrl: string,
  readerFactory: (databaseUrl: string) => SupabaseDatabaseReader,
): Promise<readonly ProviderDiagnostic[]> => {
  const { config } = context;
  const diagnostics: ProviderDiagnostic[] = [];

  const managementCredential = resolveSupabaseManagementCredential(env);
  diagnostics.push(
    diagnostic(
      'SUPABASE_CREDENTIALS',
      'Management token',
      managementCredential === undefined ? 'warning' : 'ok',
      managementCredential === undefined
        ? 'none — set DEPLOYTRUTH_SUPABASE_ACCESS_TOKEN or SUPABASE_ACCESS_TOKEN'
        : `available (${managementCredential.variable})`,
    ),
  );

  if (transport !== undefined) {
    const controlPlane = await observeControlPlane(
      config.projectRef,
      transport,
      apiBaseUrl,
      context.signal,
    );
    if (controlPlane.state === 'available') {
      diagnostics.push(
        diagnostic('SUPABASE_API', 'Management API', 'ok', 'reachable'),
        diagnostic(
          'SUPABASE_PROJECT',
          `Project ${config.projectRef}`,
          'ok',
          `accessible${controlPlane.projectName !== undefined ? ` (${controlPlane.projectName})` : ''}${
            controlPlane.region !== undefined ? ` in ${controlPlane.region}` : ''
          }${controlPlane.status !== undefined ? ` — ${controlPlane.status}` : ''}`,
        ),
      );
    } else {
      const networkLevel = ['network_error', 'timeout', 'aborted'].includes(
        controlPlane.reason ?? '',
      );
      diagnostics.push(
        diagnostic(
          'SUPABASE_API',
          'Management API',
          networkLevel ? 'error' : 'ok',
          networkLevel ? (controlPlane.detail ?? 'unreachable') : 'reachable',
        ),
        diagnostic(
          'SUPABASE_PROJECT',
          `Project ${config.projectRef}`,
          'error',
          controlPlane.detail ?? 'unavailable',
        ),
      );
    }
  } else {
    diagnostics.push(
      diagnostic('SUPABASE_API', 'Management API', 'warning', 'not queried — no credentials'),
    );
  }

  const databaseCredential = resolveSupabaseDatabaseCredential(env);
  if (databaseCredential === undefined) {
    diagnostics.push(
      diagnostic(
        'SUPABASE_DATABASE_URL',
        'Database URL',
        'warning',
        'none — set DEPLOYTRUTH_SUPABASE_DATABASE_URL',
      ),
    );
    return diagnostics;
  }
  diagnostics.push(
    diagnostic(
      'SUPABASE_DATABASE_URL',
      'Database URL',
      'ok',
      `available (${databaseCredential.variable})`,
    ),
  );

  const reader = readerFactory(databaseCredential.url);
  const identity = await reader.inspectIdentity();
  if (identity.state === 'unavailable') {
    diagnostics.push(
      diagnostic(
        'SUPABASE_DATABASE_CONNECTION',
        'Database connection',
        'error',
        identity.detail ?? 'unreachable',
      ),
    );
    return diagnostics;
  }
  diagnostics.push(
    diagnostic(
      'SUPABASE_DATABASE_CONNECTION',
      'Database connection',
      'ok',
      'reachable (read-only session)',
    ),
    diagnostic(
      'SUPABASE_DATABASE_IDENTITY',
      'Database identity',
      identity.observedProjectRef === undefined
        ? 'warning'
        : identity.observedProjectRef === config.projectRef
          ? 'ok'
          : 'error',
      identity.observedProjectRef === undefined
        ? 'unverifiable from this connection endpoint'
        : identity.observedProjectRef === config.projectRef
          ? `verified as ${identity.observedProjectRef} via ${identity.identitySource ?? 'connection'}`
          : `resolves to ${identity.observedProjectRef}, not ${config.projectRef}`,
    ),
  );

  const history = await reader.readMigrationHistory();
  diagnostics.push(
    diagnostic(
      'SUPABASE_MIGRATION_HISTORY',
      'Migration history',
      history.state === 'available' ? 'ok' : 'warning',
      history.state === 'available'
        ? `readable — ${history.appliedVersions.length} applied migration(s)`
        : (history.detail ?? 'unavailable'),
    ),
  );

  return diagnostics;
};

/**
 * Supabase database-truth adapter. It observes three independent evidence sources: the
 * Management API project record (control plane), the PostgreSQL connection itself, and the
 * deterministic project identity derived from the connection endpoint. A reachable database
 * is never assumed to be the declared project — identity comes only from the endpoint's
 * documented ref encoding. All failure modes produce `unavailable` evidence instead of
 * fabricated truth; credentials never leave the transport/reader closures.
 */
export const createSupabaseProvider = (
  options: SupabaseProviderOptions = {},
): TruthProvider<SupabaseDatabaseConfig, DatabaseObservation> => {
  const apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const readerFactory =
    options.databaseReaderFactory ?? ((databaseUrl: string) => createPgDatabaseReader(databaseUrl));
  // Built lazily so credentials resolve at observation time, not module import time.
  let transport = options.transport;
  const resolvedTransport = (): ReadOnlyTransport | undefined => {
    if (transport === undefined) {
      const credential = resolveSupabaseManagementCredential(options.env ?? process.env);
      if (credential === undefined) {
        return undefined;
      }
      transport = createSupabaseTransport({
        token: credential.token,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
    }
    return transport;
  };

  return {
    id: 'supabase',
    capabilities: ['database', 'migration-status'],
    validateConfig: (config: unknown) => supabaseDatabaseConfigSchema.parse(config),
    observe: (context: ObservationContext<SupabaseDatabaseConfig>) =>
      observeDatabase(
        context,
        context.transport ?? resolvedTransport(),
        options.env ?? process.env,
        apiBaseUrl,
        readerFactory,
      ),
    diagnose: (context: ObservationContext<SupabaseDatabaseConfig>) =>
      diagnoseDatabase(
        context,
        context.transport ?? resolvedTransport(),
        options.env ?? process.env,
        apiBaseUrl,
        readerFactory,
      ),
  };
};
