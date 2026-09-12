import type { ReadOnlyTransport } from '../contracts.js';
import { createReadOnlyFetchTransport } from '../readonly-fetch.js';

export interface VercelTransportOptions {
  /**
   * Bearer token held inside the transport closure. It is applied to outbound requests only —
   * never exposed on the request object seen by adapters, errors, or return values.
   */
  readonly token?: string;
  /** Injectable fetch for tests; defaults to the platform fetch. */
  readonly fetchImplementation?: typeof fetch;
  readonly timeoutMs?: number;
}

const VERCEL_ACCEPT = 'application/json';
const USER_AGENT = 'deploytruth/0.1';

/**
 * The Vercel REST transport. It issues GET requests only — the contract type exposes no other
 * method, and no other verb appears in this implementation. Vercel mutation endpoints are
 * unreachable through it by construction. Credential material lives in the shared transport
 * closure; raw `Response` objects never leave it.
 */
export const createVercelTransport = (options: VercelTransportOptions = {}): ReadOnlyTransport =>
  createReadOnlyFetchTransport({
    ...(options.token !== undefined ? { token: options.token } : {}),
    ...(options.fetchImplementation !== undefined
      ? { fetchImplementation: options.fetchImplementation }
      : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    headers: {
      accept: VERCEL_ACCEPT,
      'user-agent': USER_AGENT,
    },
  });
