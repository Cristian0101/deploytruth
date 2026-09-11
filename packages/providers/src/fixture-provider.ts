import type { ProviderObservation } from './contracts.js';
import type {
  ObservationContext,
  ProviderCapability,
  ProviderDiagnostic,
  TruthProvider,
} from './contracts.js';

export interface FixtureProviderOptions<TConfig, TObservation extends ProviderObservation> {
  readonly id: string;
  readonly capabilities: readonly ProviderCapability[];
  readonly validateConfig: (config: unknown) => TConfig;
  readonly observationFor: (context: ObservationContext<TConfig>) => TObservation;
  readonly diagnosticsFor?: (context: ObservationContext<TConfig>) => readonly ProviderDiagnostic[];
}

/** A deterministic in-memory adapter for unit tests and documented fixtures. */
export const createFixtureProvider = <TConfig, TObservation extends ProviderObservation>(
  options: FixtureProviderOptions<TConfig, TObservation>,
): TruthProvider<TConfig, TObservation> => ({
  id: options.id,
  capabilities: options.capabilities,
  validateConfig: options.validateConfig,
  observe: async (context) => structuredClone(options.observationFor(context)),
  ...(options.diagnosticsFor
    ? {
        diagnose: async (context) => structuredClone(options.diagnosticsFor?.(context) ?? []),
      }
    : {}),
});
