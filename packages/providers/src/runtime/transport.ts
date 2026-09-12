import type { ReadOnlyResponse, ReadOnlyTransport } from '../contracts.js';

export type RuntimeTransportErrorCode =
  | 'INSECURE_URL'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'REDIRECT_REJECTED'
  | 'WRONG_CONTENT_TYPE'
  | 'MALFORMED_RESPONSE'
  | 'OVERSIZED_RESPONSE';

/** Fixed-message transport failure. Raw bodies, headers, URLs, and fetch errors never enter it. */
export class RuntimeTransportError extends Error {
  public constructor(public readonly code: RuntimeTransportErrorCode) {
    super(
      {
        INSECURE_URL: 'The runtime attestation URL is not an allowed secure origin.',
        NETWORK_ERROR: 'The runtime attestation endpoint could not be reached.',
        TIMEOUT: 'The runtime attestation request timed out.',
        ABORTED: 'The runtime attestation request was aborted.',
        REDIRECT_REJECTED: 'The runtime attestation endpoint returned a redirect.',
        WRONG_CONTENT_TYPE: 'The runtime attestation endpoint did not return JSON.',
        MALFORMED_RESPONSE: 'The runtime attestation endpoint returned malformed JSON.',
        OVERSIZED_RESPONSE: 'The runtime attestation response exceeded the size limit.',
      }[code],
    );
    this.name = 'RuntimeTransportError';
  }
}

export interface RuntimeTransportOptions {
  readonly fetchImplementation?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_RUNTIME_RESPONSE_LIMIT_BYTES = 16 * 1024;

const isAllowedRuntimeUrl = (value: string): boolean => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '') {
    return false;
  }
  if (url.protocol === 'https:') {
    return true;
  }
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
};

const safeHeaders = (headers: Headers): Readonly<Record<string, string>> => {
  const result: Record<string, string> = {};
  for (const name of ['cache-control', 'content-type', 'pragma'] as const) {
    const value = headers.get(name);
    if (value !== null) {
      result[name] = value;
    }
  }
  return result;
};

const discardBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // A discarded error body is deliberately not inspected or propagated.
  }
};

const readBoundedBody = async (response: Response, maximumBytes: number): Promise<Uint8Array> => {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await discardBody(response);
    throw new RuntimeTransportError('OVERSIZED_RESPONSE');
  }

  if (response.body === null) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new RuntimeTransportError('OVERSIZED_RESPONSE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

/**
 * Runtime attestation transport: GET-only, fail-closed redirects, bounded JSON, and HTTPS except
 * for explicit local development origins. Only three public-safe response headers cross it.
 */
export const createRuntimeTransport = (
  options: RuntimeTransportOptions = {},
): ReadOnlyTransport => {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_RUNTIME_RESPONSE_LIMIT_BYTES;

  return {
    get: async (request): Promise<ReadOnlyResponse> => {
      if (!isAllowedRuntimeUrl(request.url)) {
        throw new RuntimeTransportError('INSECURE_URL');
      }

      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await fetchImplementation(request.url, {
          method: 'GET',
          redirect: 'manual',
          headers: { accept: 'application/json', ...(request.headers ?? {}) },
          signal,
        });
      } catch {
        if (request.signal?.aborted === true) {
          throw new RuntimeTransportError('ABORTED');
        }
        if (timeout.aborted) {
          throw new RuntimeTransportError('TIMEOUT');
        }
        throw new RuntimeTransportError('NETWORK_ERROR');
      }

      if (response.status >= 300 && response.status <= 399) {
        await discardBody(response);
        throw new RuntimeTransportError('REDIRECT_REJECTED');
      }

      const headers = safeHeaders(response.headers);
      if (response.status !== 200) {
        await discardBody(response);
        return { status: response.status, headers, body: undefined };
      }

      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.startsWith('application/json')) {
        await discardBody(response);
        throw new RuntimeTransportError('WRONG_CONTENT_TYPE');
      }

      const bytes = await readBoundedBody(response, maxResponseBytes);
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        throw new RuntimeTransportError('MALFORMED_RESPONSE');
      }
      return { status: response.status, headers, body };
    },
  };
};
