export const VERCEL_TOKEN_VARIABLES = ['DEPLOYTRUTH_VERCEL_TOKEN', 'VERCEL_TOKEN'] as const;

export type VercelTokenVariable = (typeof VERCEL_TOKEN_VARIABLES)[number];

export interface VercelCredential {
  /** The token value. Never serialized, logged, or placed on an observation. */
  readonly token: string;
  /** Which environment variable supplied it — safe to display (a name, never a value). */
  readonly variable: VercelTokenVariable;
}

/**
 * Resolves the Vercel credential from runtime environment. `DEPLOYTRUTH_VERCEL_TOKEN` wins over
 * `VERCEL_TOKEN`; absent both means the project cannot be observed — Vercel exposes no
 * unauthenticated project truth, so adapters report `missing_credentials` instead of guessing.
 * Callers may report the variable name but never the token value.
 */
export const resolveVercelCredential = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): VercelCredential | undefined => {
  for (const variable of VERCEL_TOKEN_VARIABLES) {
    const token = env[variable]?.trim();
    if (token !== undefined && token.length > 0) {
      return { token, variable };
    }
  }
  return undefined;
};
