/**
 * Supabase project refs are lowercase alphanumeric identifiers (hosted projects use 20
 * characters). The grammar stays deliberately permissive inside the safe identifier space —
 * over-restricting a length Supabase does not publish as fixed would reject legitimate refs.
 */
export const SUPABASE_PROJECT_REF_PATTERN = /^[a-z0-9]{6,64}$/;

export type SupabaseIdentitySource = 'direct_host' | 'pooler_username';

export interface DerivedDatabaseIdentity {
  readonly projectRef: string;
  readonly source: SupabaseIdentitySource;
}

/**
 * Direct and dedicated-pooler endpoints embed the project ref in the hostname:
 * `db.<ref>.supabase.co` (direct on :5432, dedicated PgBouncer pooler on :6543).
 */
const DIRECT_HOST_PATTERN = /^db\.([a-z0-9]{6,64})\.supabase\.co$/;

/**
 * The shared Supavisor pooler is multi-tenant: every `*.pooler.supabase.com` endpoint routes
 * by the project-ref suffix in the username (`postgres.<ref>`).
 */
const POOLER_HOST_SUFFIX = '.pooler.supabase.com';

/**
 * Derives which Supabase project a PostgreSQL connection string targets — when it can be
 * established deterministically from the endpoint itself. Returns `undefined` for any other
 * shape (custom hosts, proxies, self-hosted endpoints): a successful connection alone never
 * proves the database belongs to the declared project.
 *
 * Only the project ref is returned. The URL, its credentials, and its host are never stored
 * or serialized anywhere.
 */
export const deriveProjectIdentity = (databaseUrl: string): DerivedDatabaseIdentity | undefined => {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    return undefined;
  }

  const host = url.hostname.toLowerCase();
  const direct = DIRECT_HOST_PATTERN.exec(host);
  if (direct?.[1] !== undefined) {
    return { projectRef: direct[1], source: 'direct_host' };
  }

  if (host.endsWith(POOLER_HOST_SUFFIX) && host.length > POOLER_HOST_SUFFIX.length) {
    const username = decodeURIComponent(url.username);
    const separator = username.lastIndexOf('.');
    const candidate = separator > 0 ? username.slice(separator + 1) : '';
    if (SUPABASE_PROJECT_REF_PATTERN.test(candidate)) {
      return { projectRef: candidate, source: 'pooler_username' };
    }
  }

  return undefined;
};
