import { randomBytes } from 'node:crypto';

import { runtimeObservationSchema, type RuntimeObservation } from '@deploytruth/core';
import { z } from 'zod';

import type {
  ObservationContext,
  ProviderDiagnostic,
  ReadOnlyTransport,
  TruthProvider,
} from '../contracts.js';
import {
  createRuntimeTransport,
  RuntimeTransportError,
  type RuntimeTransportErrorCode,
} from './transport.js';

const ENVIRONMENT_VARIABLE_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/i;
const PROJECT_REF_PATTERN = /^[a-z0-9]{6,64}$/;

export const runtimeAttestationConfigSchema = z
  .object({
    url: z.string().url(),
    requiredEnvironmentVariables: z
      .array(z.string().regex(ENVIRONMENT_VARIABLE_NAME))
      .max(64)
      .default([]),
  })
  .strict();
export type RuntimeAttestationConfig = z.infer<typeof runtimeAttestationConfigSchema>;

const runtimeConnectionReasonSchema = z.enum([
  'missing_configuration',
  'credentials_rejected',
  'network_error',
  'timeout',
  'tls_error',
  'unexpected_status',
  'identity_unverified',
]);

/** Strict public protocol. Unknown fields at every object layer reject the whole response. */
export const runtimeAttestationV1Schema = z
  .object({
    version: z.literal(1),
    nonce: z.string().regex(NONCE_PATTERN).optional(),
    commit: z.string().regex(COMMIT_SHA_PATTERN).optional(),
    environment: z.string().min(1).max(64),
    environmentVariables: z.record(z.boolean()),
    connections: z
      .object({
        database: z
          .object({
            provider: z.string().min(1).max(64),
            targetProjectRef: z.string().regex(PROJECT_REF_PATTERN).optional(),
            identity: z.enum(['verified', 'unverified']),
            status: z.enum(['connected', 'unavailable']),
            reason: runtimeConnectionReasonSchema.optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();
export type RuntimeAttestationV1 = z.infer<typeof runtimeAttestationV1Schema>;

export interface RuntimeProviderOptions {
  readonly transport?: ReadOnlyTransport;
  readonly fetchImplementation?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly generateNonce?: () => string;
}

type RuntimeUnavailableReason = Exclude<
  NonNullable<RuntimeObservation['availability']>['reason'],
  undefined
>;

const TRANSPORT_REASONS = {
  INSECURE_URL: 'insecure_url',
  NETWORK_ERROR: 'network_error',
  TIMEOUT: 'timeout',
  ABORTED: 'aborted',
  REDIRECT_REJECTED: 'redirect_rejected',
  WRONG_CONTENT_TYPE: 'wrong_content_type',
  MALFORMED_RESPONSE: 'malformed_response',
  OVERSIZED_RESPONSE: 'oversized_response',
} as const satisfies Readonly<Record<RuntimeTransportErrorCode, RuntimeUnavailableReason>>;

const transportReason = (code: RuntimeTransportErrorCode): RuntimeUnavailableReason =>
  TRANSPORT_REASONS[code];

const detailFor = (reason: RuntimeUnavailableReason): string =>
  ({
    insecure_url: 'Runtime attestation requires HTTPS except on localhost or 127.0.0.1.',
    network_error: 'The runtime attestation endpoint could not be reached.',
    timeout: 'The runtime attestation request timed out.',
    aborted: 'The runtime attestation request was aborted.',
    redirect_rejected: 'The runtime attestation request was redirected and was not followed.',
    http_error: 'The runtime attestation endpoint did not return HTTP 200.',
    wrong_content_type: 'The runtime attestation endpoint did not return JSON.',
    malformed_response: 'The runtime attestation response did not match the strict v1 schema.',
    oversized_response: 'The runtime attestation response exceeded the 16 KiB safety limit.',
    unsupported_version: 'The runtime attestation version is not supported.',
  })[reason];

const unavailable = (
  url: string,
  reason: RuntimeUnavailableReason,
  statusCode?: number,
): RuntimeObservation =>
  runtimeObservationSchema.parse({
    url,
    reachable: false,
    ...(statusCode !== undefined ? { statusCode } : {}),
    availability: { state: 'unavailable', reason, detail: detailFor(reason) },
  });

const attestationUrl = (configuredUrl: string, nonce: string): string => {
  const url = new URL(configuredUrl);
  url.searchParams.set('nonce', nonce);
  return url.toString();
};

const cacheIsNoStore = (headers: Readonly<Record<string, string>>): boolean =>
  (headers['cache-control'] ?? '')
    .toLowerCase()
    .split(',')
    .some((directive) => directive.trim() === 'no-store');

const observeRuntime = async (
  context: ObservationContext<RuntimeAttestationConfig>,
  transport: ReadOnlyTransport,
  nonceFactory: () => string,
): Promise<RuntimeObservation> => {
  const nonce = nonceFactory();
  if (!NONCE_PATTERN.test(nonce)) {
    throw new Error('Runtime nonce factory returned an invalid nonce.');
  }

  let response;
  try {
    response = await transport.get({
      url: attestationUrl(context.config.url, nonce),
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
    });
  } catch (error) {
    const reason =
      error instanceof RuntimeTransportError ? transportReason(error.code) : 'network_error';
    return unavailable(context.config.url, reason);
  }

  if (response.status !== 200) {
    return unavailable(context.config.url, 'http_error', response.status);
  }

  if (
    typeof response.body === 'object' &&
    response.body !== null &&
    'version' in response.body &&
    (response.body as { readonly version?: unknown }).version !== 1
  ) {
    return unavailable(context.config.url, 'unsupported_version', response.status);
  }

  const parsed = runtimeAttestationV1Schema.safeParse(response.body);
  if (!parsed.success) {
    return unavailable(context.config.url, 'malformed_response', response.status);
  }

  const freshness =
    parsed.data.nonce === undefined
      ? ({ state: 'unverified', reason: 'missing_nonce' } as const)
      : parsed.data.nonce === nonce
        ? ({ state: 'verified' } as const)
        : ({ state: 'unverified', reason: 'nonce_mismatch' } as const);

  const requiredNames = new Set(context.config.requiredEnvironmentVariables);
  const environmentVariables = Object.entries(parsed.data.environmentVariables)
    .filter(([name]) => requiredNames.has(name))
    .map(([name, present]) => ({ name, present }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return runtimeObservationSchema.parse({
    url: context.config.url,
    reachable: true,
    statusCode: response.status,
    availability: { state: 'available' },
    attestationVersion: 1,
    freshness,
    cacheControlNoStore: cacheIsNoStore(response.headers),
    ...(parsed.data.commit !== undefined ? { commitSha: parsed.data.commit } : {}),
    environment: parsed.data.environment,
    environmentVariables,
    ...(parsed.data.connections.database !== undefined
      ? { databaseConnection: parsed.data.connections.database }
      : {}),
  });
};

export const createRuntimeProvider = (
  options: RuntimeProviderOptions = {},
): TruthProvider<RuntimeAttestationConfig, RuntimeObservation> => {
  const transport =
    options.transport ??
    createRuntimeTransport({
      ...(options.fetchImplementation !== undefined
        ? { fetchImplementation: options.fetchImplementation }
        : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxResponseBytes !== undefined
        ? { maxResponseBytes: options.maxResponseBytes }
        : {}),
    });
  const nonceFactory = options.generateNonce ?? (() => randomBytes(32).toString('base64url'));

  return {
    id: 'runtime-attestation',
    capabilities: ['runtime-identity', 'environment-variable-presence'],
    validateConfig: (config) => runtimeAttestationConfigSchema.parse(config),
    observe: (context) => observeRuntime(context, transport, nonceFactory),
    diagnose: async (context): Promise<readonly ProviderDiagnostic[]> => {
      const observation = await observeRuntime(context, transport, nonceFactory);
      if (observation.availability?.state === 'available') {
        return [
          {
            code: 'RUNTIME_ATTESTATION',
            title: 'Runtime attestation',
            status: observation.freshness?.state === 'verified' ? 'ok' : 'warning',
            message:
              observation.freshness?.state === 'verified'
                ? 'reachable with verified nonce freshness'
                : 'reachable, but nonce freshness was not verified',
          },
        ];
      }
      return [
        {
          code: 'RUNTIME_ATTESTATION',
          title: 'Runtime attestation',
          status: 'warning',
          message: observation.availability?.detail ?? 'unavailable',
        },
      ];
    },
  };
};
