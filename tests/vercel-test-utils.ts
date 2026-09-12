import {
  createVercelProvider,
  type ReadOnlyRequest,
  type ReadOnlyResponse,
  type ReadOnlyTransport,
  type DeploymentObservation,
  type TruthProvider,
  type VercelDeploymentConfig,
} from '@deploytruth/providers';

export const TEST_PROJECT = 'example-app';
export const TEST_PROJECT_ID = 'prj_exampleapp0001';
export const PRODUCTION_DEPLOYMENT_ID = 'dpl_prod_abc123';
export const TEST_SHA = 'a'.repeat(40);

export type StaticResponse =
  | {
      readonly status: number;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: unknown;
    }
  | { readonly error: Error };

/**
 * Fabricated minimal API payloads — deliberately not full Vercel responses (fixtures must never
 * contain real payload dumps). `rawOnlySentinel` and `env` prove adapter normalization drops
 * every field DeployTruth does not consume, including environment-variable material.
 */
export const vercelProjectPayload = (
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  id: TEST_PROJECT_ID,
  name: TEST_PROJECT,
  accountId: 'team_fixture0001',
  alias: [
    {
      domain: `${TEST_PROJECT}.vercel.app`,
      target: 'PRODUCTION',
      environment: 'production',
      deployment: { id: PRODUCTION_DEPLOYMENT_ID, url: `${TEST_PROJECT}-abc123.vercel.app` },
    },
    {
      domain: 'app.example.com',
      target: 'PRODUCTION',
      environment: 'production',
      deployment: { id: PRODUCTION_DEPLOYMENT_ID, url: `${TEST_PROJECT}-abc123.vercel.app` },
    },
  ],
  latestDeployments: [
    { id: 'dpl_preview_newest', target: null, readyState: 'READY' },
    { id: PRODUCTION_DEPLOYMENT_ID, target: 'production', readyState: 'READY' },
  ],
  env: [{ key: 'SUPABASE_URL', value: 'secret-value-must-not-escape' }],
  rawOnlySentinel: 'vercel_fixture_never_real_00000000',
  ...overrides,
});

export const vercelDeploymentPayload = (
  sha: string | undefined = TEST_SHA,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  id: PRODUCTION_DEPLOYMENT_ID,
  url: `${TEST_PROJECT}-abc123.vercel.app`,
  createdAt: 1789000000000,
  readyState: 'READY',
  target: 'production',
  meta: {
    ...(sha !== undefined ? { githubCommitSha: sha } : {}),
    githubCommitRef: 'main',
    githubOrg: 'example',
    githubRepo: 'example-app',
  },
  alias: [`${TEST_PROJECT}.vercel.app`, 'app.example.com'],
  env: { SECRET_VAR: 'secret-value-must-not-escape' },
  builds: [{ use: '@vercel/next' }],
  rawOnlySentinel: 'vercel_fixture_never_real_00000000',
  ...overrides,
});

/** Deterministic transport: maps request path to a canned response; unknown paths get 404. */
export const createStaticVercelTransport = (
  responses: Readonly<Record<string, StaticResponse>>,
  calls?: string[],
): ReadOnlyTransport => ({
  get: async (request: ReadOnlyRequest): Promise<ReadOnlyResponse> => {
    const url = new URL(request.url);
    calls?.push(`${url.pathname}${url.search}`);
    const entry = responses[url.pathname];
    if (entry === undefined) {
      return { status: 404, headers: {}, body: { error: { code: 'not_found' } } };
    }
    if ('error' in entry) {
      throw entry.error;
    }
    return {
      status: entry.status,
      headers: entry.headers ?? {},
      body: entry.body,
    };
  },
});

export interface VercelFixtureOptions {
  readonly project?: string;
  readonly scope?: string;
  readonly domain?: string;
  readonly sourceSha?: string | undefined;
  readonly projectStatus?: number;
  readonly deploymentStatus?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly projectOverrides?: Readonly<Record<string, unknown>>;
  readonly deploymentOverrides?: Readonly<Record<string, unknown>>;
  readonly error?: Error;
  readonly deploymentError?: Error;
}

/**
 * A Vercel provider backed by a static transport — the real adapter, no network. The deployment
 * endpoint serves `/v13/deployments/{anyId}` so scenarios resolving non-default deployment ids
 * (rollbacks, divergent aliases) behave like the real API.
 */
export const createFixtureVercelProvider = (
  options: VercelFixtureOptions = {},
  calls?: string[],
): TruthProvider<VercelDeploymentConfig, DeploymentObservation> => {
  const project = options.project ?? TEST_PROJECT;
  const baseUrl = 'https://api.vercel.test';

  const projectEntry: StaticResponse =
    options.error !== undefined
      ? { error: options.error }
      : {
          status: options.projectStatus ?? 200,
          headers: options.headers ?? {},
          body:
            (options.projectStatus ?? 200) === 200
              ? vercelProjectPayload(options.projectOverrides ?? {})
              : { error: { code: 'error' } },
        };
  const deploymentStatus = options.deploymentStatus ?? 200;

  const transport: ReadOnlyTransport = {
    get: async (request: ReadOnlyRequest): Promise<ReadOnlyResponse> => {
      const url = new URL(request.url);
      calls?.push(`${url.pathname}${url.search}`);
      if (url.pathname === `/v9/projects/${project}`) {
        if ('error' in projectEntry) {
          throw projectEntry.error;
        }
        return {
          status: projectEntry.status,
          headers: projectEntry.headers ?? {},
          body: projectEntry.body,
        };
      }
      const deploymentMatch = /^\/v13\/deployments\/([^/?]+)$/.exec(url.pathname);
      if (deploymentMatch !== null) {
        if (options.deploymentError !== undefined) {
          throw options.deploymentError;
        }
        if (deploymentStatus !== 200) {
          return {
            status: deploymentStatus,
            headers: options.headers ?? {},
            body: { error: { code: 'error' } },
          };
        }
        return {
          status: 200,
          headers: options.headers ?? {},
          body: vercelDeploymentPayload(options.sourceSha, {
            id: decodeURIComponent(deploymentMatch[1] ?? ''),
            ...options.deploymentOverrides,
          }),
        };
      }
      return { status: 404, headers: {}, body: { error: { code: 'not_found' } } };
    },
  };

  return createVercelProvider({ transport, apiBaseUrl: baseUrl });
};

export const vercelConfig = (
  project: string = TEST_PROJECT,
  extras: Partial<VercelDeploymentConfig> = {},
): VercelDeploymentConfig => ({ project, target: 'production', ...extras });
