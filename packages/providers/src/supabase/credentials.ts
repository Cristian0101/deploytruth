export const SUPABASE_MANAGEMENT_TOKEN_VARIABLES = [
  'DEPLOYTRUTH_SUPABASE_ACCESS_TOKEN',
  'SUPABASE_ACCESS_TOKEN',
] as const;

export type SupabaseManagementTokenVariable = (typeof SUPABASE_MANAGEMENT_TOKEN_VARIABLES)[number];

export interface SupabaseManagementCredential {
  /** The access token value. Never serialized, logged, or placed on an observation. */
  readonly token: string;
  /** Which environment variable supplied it — safe to display (a name, never a value). */
  readonly variable: SupabaseManagementTokenVariable;
}

/**
 * Resolves the Supabase Management API credential. `DEPLOYTRUTH_SUPABASE_ACCESS_TOKEN` wins
 * over `SUPABASE_ACCESS_TOKEN`. This is a personal access token for the control-plane API —
 * project service-role keys and anon keys are NOT accepted here: they are data-plane
 * credentials, not Management API credentials.
 */
export const resolveSupabaseManagementCredential = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): SupabaseManagementCredential | undefined => {
  for (const variable of SUPABASE_MANAGEMENT_TOKEN_VARIABLES) {
    const token = env[variable]?.trim();
    if (token !== undefined && token.length > 0) {
      return { token, variable };
    }
  }
  return undefined;
};

export const SUPABASE_DATABASE_URL_VARIABLES = ['DEPLOYTRUTH_SUPABASE_DATABASE_URL'] as const;

export type SupabaseDatabaseUrlVariable = (typeof SUPABASE_DATABASE_URL_VARIABLES)[number];

export interface SupabaseDatabaseCredential {
  /** The connection string value. Never serialized, logged, or placed on an observation. */
  readonly url: string;
  /** Which environment variable supplied it — safe to display (a name, never a value). */
  readonly variable: SupabaseDatabaseUrlVariable;
}

/**
 * Resolves the database connection string. Only the explicit DeployTruth variable is
 * consulted — a generic `DATABASE_URL` is deliberately NOT a fallback, because it could
 * silently point DeployTruth at an unrelated production database. The URL must carry
 * credentials for whatever role the operator chooses; a read-only role is sufficient for
 * the migration metadata DeployTruth reads.
 */
export const resolveSupabaseDatabaseCredential = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): SupabaseDatabaseCredential | undefined => {
  for (const variable of SUPABASE_DATABASE_URL_VARIABLES) {
    const url = env[variable]?.trim();
    if (url !== undefined && url.length > 0) {
      return { url, variable };
    }
  }
  return undefined;
};
