import type { ReadOnlyTransport } from '../contracts.js';
import { createReadOnlyFetchTransport } from '../readonly-fetch.js';

export interface SupabaseTransportOptions {
  /**
   * Management API access token held inside the transport closure. It is applied to outbound
   * requests only — never exposed on the request object seen by adapters, errors, or return
   * values.
   */
  readonly token?: string;
  /** Injectable fetch for tests; defaults to the platform fetch. */
  readonly fetchImplementation?: typeof fetch;
  readonly timeoutMs?: number;
}

const SUPABASE_ACCEPT = 'application/json';
const USER_AGENT = 'deploytruth/0.1';

/**
 * The Supabase Management API transport. It issues GET requests only — the contract type
 * exposes no other method, and no other verb appears in this implementation. Supabase
 * mutation and SQL-over-HTTP endpoints are unreachable through it by construction.
 */
export const createSupabaseTransport = (
  options: SupabaseTransportOptions = {},
): ReadOnlyTransport =>
  createReadOnlyFetchTransport({
    ...(options.token !== undefined ? { token: options.token } : {}),
    ...(options.fetchImplementation !== undefined
      ? { fetchImplementation: options.fetchImplementation }
      : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    headers: {
      accept: SUPABASE_ACCEPT,
      'user-agent': USER_AGENT,
    },
  });
