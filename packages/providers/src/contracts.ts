import type {
  DatabaseObservation,
  DeploymentObservation,
  RuntimeObservation,
  SourceObservation,
} from '@deploytruth/core';

export type ProviderObservation =
  SourceObservation | DeploymentObservation | DatabaseObservation | RuntimeObservation;

export type ProviderCapability =
  | 'source'
  | 'deployment'
  | 'database'
  | 'runtime-identity'
  | 'environment-variable-presence'
  | 'migration-status';

export interface ReadOnlyRequest {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface ReadOnlyResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Raw data is intentionally confined to provider adapter implementation. */
  readonly body: unknown;
}

/** A provider transport exposes GET only, preventing mutation by construction. */
export interface ReadOnlyTransport {
  readonly get: (request: ReadOnlyRequest) => Promise<ReadOnlyResponse>;
}

export interface ObservationContext<TConfig> {
  readonly project: string;
  readonly environment: string;
  readonly config: TConfig;
  readonly transport?: ReadOnlyTransport;
  readonly signal?: AbortSignal;
}

export interface ProviderDiagnostic {
  readonly code: string;
  readonly title: string;
  readonly status: 'ok' | 'warning' | 'error';
  readonly message: string;
}

/**
 * Every live adapter validates its own narrow config and returns normalized truth only.
 * It must not return SDK response objects or persist raw payloads.
 */
export interface TruthProvider<TConfig, TObservation extends ProviderObservation> {
  readonly id: string;
  readonly capabilities: readonly ProviderCapability[];
  readonly validateConfig: (config: unknown) => TConfig;
  readonly observe: (context: ObservationContext<TConfig>) => Promise<TObservation>;
  readonly diagnose?: (
    context: ObservationContext<TConfig>,
  ) => Promise<readonly ProviderDiagnostic[]>;
}
