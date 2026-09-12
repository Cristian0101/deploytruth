import type { ReadOnlyRequest, ReadOnlyResponse, ReadOnlyTransport } from './contracts.js';

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

export interface ReadOnlyFetchTransportOptions {
  /**
   * Bearer token held inside the transport closure. It is applied to outbound requests only —
   * never exposed on the request object seen by adapters, errors, or return values.
   */
  readonly token?: string;
  /** Static provider headers merged into every request (Accept, User-Agent, API versions). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Injectable fetch for tests; defaults to the platform fetch. */
  readonly fetchImplementation?: typeof fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

const headersToRecord = (headers: Headers): Readonly<Record<string, string>> =>
  Object.fromEntries(headers.entries());

/**
 * Shared fetch-based read-only transport. It issues GET requests only — the contract type
 * exposes no other method, and no other verb appears in this implementation. Credential
 * material lives in the closure; raw `Response` objects never leave this function.
 */
export const createReadOnlyFetchTransport = (
  options: ReadOnlyFetchTransportOptions = {},
): ReadOnlyTransport => {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    get: async (request: ReadOnlyRequest): Promise<ReadOnlyResponse> => {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
      const headers: Record<string, string> = {
        ...(options.headers ?? {}),
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
