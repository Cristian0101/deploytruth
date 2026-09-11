import {
  createGitHubProvider,
  type GitHubSourceConfig,
  type ReadOnlyRequest,
  type ReadOnlyResponse,
  type ReadOnlyTransport,
  type SourceObservation,
  type TruthProvider,
} from '@deploytruth/providers';

export const TEST_REPOSITORY = 'example/example-app';
export const TEST_BRANCH = 'main';

export type StaticResponse =
  | {
      readonly status: number;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: unknown;
    }
  | { readonly error: Error };

/**
 * Fabricated minimal API payloads — deliberately not full GitHub responses (fixtures must never
 * contain real payload dumps). `rawOnlySentinel` proves adapter normalization drops every field
 * DeployTruth does not consume.
 */
export const githubRepositoryPayload = (
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  full_name: TEST_REPOSITORY,
  default_branch: TEST_BRANCH,
  visibility: 'public',
  private: false,
  archived: false,
  rawOnlySentinel: 'ghp_fixture_never_real_00000000',
  owner: { login: 'example', type: 'Organization' },
  permissions: { admin: false, push: false },
  ...overrides,
});

export const githubBranchPayload = (
  sha: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  name: TEST_BRANCH,
  commit: {
    sha,
    url: `https://api.github.com/repos/${TEST_REPOSITORY}/commits/${sha}`,
    rawOnlySentinel: 'raw-payload-value-must-not-escape',
  },
  protected: false,
  ...overrides,
});

/** Deterministic transport: maps request path to a canned response; unknown paths get 404. */
export const createStaticTransport = (
  responses: Readonly<Record<string, StaticResponse>>,
  calls?: string[],
): ReadOnlyTransport => ({
  get: async (request: ReadOnlyRequest): Promise<ReadOnlyResponse> => {
    const path = new URL(request.url).pathname;
    calls?.push(path);
    const entry = responses[path];
    if (entry === undefined) {
      return { status: 404, headers: {}, body: { message: 'Not Found' } };
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

export interface GitHubFixtureOptions {
  readonly remoteSha?: string;
  readonly repository?: string;
  readonly branch?: string;
  readonly repositoryStatus?: number;
  readonly branchStatus?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly repositoryOverrides?: Readonly<Record<string, unknown>>;
  readonly error?: Error;
}

/** A GitHub provider backed by the static transport — the real adapter, no network. */
export const createFixtureGitHubProvider = (
  options: GitHubFixtureOptions = {},
  calls?: string[],
): TruthProvider<GitHubSourceConfig, SourceObservation> => {
  const repository = options.repository ?? TEST_REPOSITORY;
  const branch = options.branch ?? TEST_BRANCH;
  const baseUrl = 'https://api.github.test';

  const responses: Record<string, StaticResponse> = {};
  if (options.error !== undefined) {
    responses[`/repos/${repository}`] = { error: options.error };
  } else {
    const status = options.repositoryStatus ?? 200;
    responses[`/repos/${repository}`] = {
      status,
      headers: options.headers ?? {},
      body:
        status === 200
          ? githubRepositoryPayload(options.repositoryOverrides ?? {})
          : { message: 'error' },
    };
    responses[`/repos/${repository}/branches/${branch}`] = {
      status: options.branchStatus ?? 200,
      headers: options.headers ?? {},
      body:
        (options.branchStatus ?? 200) === 200
          ? githubBranchPayload(options.remoteSha ?? 'a'.repeat(40))
          : { message: 'error' },
    };
  }

  return createGitHubProvider({
    transport: createStaticTransport(responses, calls),
    apiBaseUrl: baseUrl,
  });
};

export const gitHubConfig = (
  repository: string = TEST_REPOSITORY,
  branch: string = TEST_BRANCH,
): GitHubSourceConfig => ({ repository, branch });
