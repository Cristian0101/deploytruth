import {
  createRuntimeProvider,
  type ReadOnlyRequest,
  type ReadOnlyResponse,
  type ReadOnlyTransport,
  type RuntimeAttestationConfig,
} from '@deploytruth/providers';

export const TEST_RUNTIME_NONCE = 'n'.repeat(43);
export const TEST_RUNTIME_SHA = 'a'.repeat(40);
export const TEST_PROJECT_REF = 'wxzqzkkuozujicoywcur';

export interface RuntimeFixtureOptions {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly bodyOverrides?: Readonly<Record<string, unknown>>;
  readonly omitNonce?: boolean;
  readonly wrongNonce?: boolean;
  readonly error?: Error;
}

export const runtimeAttestationBody = (
  nonce: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  version: 1,
  nonce,
  commit: TEST_RUNTIME_SHA,
  environment: 'production',
  environmentVariables: {
    SUPABASE_URL: true,
    SUPABASE_PUBLISHABLE_KEY: true,
  },
  connections: {
    database: {
      provider: 'supabase',
      targetProjectRef: TEST_PROJECT_REF,
      identity: 'verified',
      status: 'connected',
    },
  },
  ...overrides,
});

export const createFixtureRuntimeProvider = (
  options: RuntimeFixtureOptions = {},
  calls?: string[],
) => {
  const transport: ReadOnlyTransport = {
    get: async (request: ReadOnlyRequest): Promise<ReadOnlyResponse> => {
      calls?.push(request.url);
      if (options.error !== undefined) {
        throw options.error;
      }
      const nonce = new URL(request.url).searchParams.get('nonce') ?? '';
      const body = runtimeAttestationBody(
        options.wrongNonce ? 'w'.repeat(43) : nonce,
        options.bodyOverrides,
      );
      if (options.omitNonce) {
        delete body['nonce'];
      }
      return {
        status: options.status ?? 200,
        headers: options.headers ?? {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        },
        body,
      };
    },
  };
  return createRuntimeProvider({ transport, generateNonce: () => TEST_RUNTIME_NONCE });
};

export const runtimeConfig = (
  url = 'https://runtime.example.test/api/deploytruth/runtime',
  requiredEnvironmentVariables: readonly string[] = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY'],
): RuntimeAttestationConfig => ({
  url,
  requiredEnvironmentVariables: [...requiredEnvironmentVariables],
});
