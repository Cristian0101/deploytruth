import type { ReadOnlyRequest, ReadOnlyResponse, ReadOnlyTransport } from '../contracts.js';

export type TransportErrorCode = 'NETWORK_ERROR' | 'TIMEOUT' | 'ABORTED';

/**
 * Normalized transport failure. Messages are fixed strings: request URLs and headers (including
 * the Authorization header) are never attached to errors.
 */
export class TransportError extends Error {
  public readonly code: TransportErrorCode;

  public constructor(code: TransportErrorCode, message: string) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
  }
}

export interface GitHubTransportOptions {
  /**
   * Bearer token held inside the transport closure. It is applied to outbound requests only —
   * never exposed on the request object seen by adapters, errors, or return values.
   */
  readonly token?: string;
  /** Injectable fetch for tests; defaults to the platform fetch. */
  readonly fetchImplementation?: typeof fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const GITHUB_ACCEPT = 'application/vnd.github+json';
const GITHUB_API_VERSION = '2022-11-28';
const USER_AGENT = 'deploytruth/0.1';

const headersToRecord = (headers: Headers): Readonly<Record<string, string>> =>
  Object.fromEntries(headers.entries());

/**
 * The GitHub REST transport. It issues GET requests only — the contract type exposes no other
 * method, and no other verb appears in this implementation. Credential material lives in the
 * closure; raw `Response` objects never leave this function.
 */
export const createGitHubTransport = (options: GitHubTransportOptions = {}): ReadOnlyTransport => {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    get: async (request: ReadOnlyRequest): Promise<ReadOnlyResponse> => {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
      const headers: Record<string, string> = {
        accept: GITHUB_ACCEPT,
        'user-agent': USER_AGENT,
        'x-github-api-version': GITHUB_API_VERSION,
        ...(options.token !== undefined ? { authorization: `Bearer ${options.token}` } : {}),
        ...(request.headers ?? {}),
      };

      let response: Response;
      try {
        response = await fetchImplementation(request.url, { method: 'GET', headers, signal });
      } catch {
        if (request.signal?.aborted === true) {
          throw new TransportError('ABORTED', 'The remote request was aborted by the caller.');
        }
        if (timeout.aborted) {
          throw new TransportError('TIMEOUT', 'The remote request timed out.');
        }
        throw new TransportError('NETWORK_ERROR', 'The remote API could not be reached.');
      }

      // Body parse failure is surfaced as an undefined body; adapters normalize it as a
      // malformed response rather than trusting partial data.
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }

      return { status: response.status, headers: headersToRecord(response.headers), body };
    },
  };
};
