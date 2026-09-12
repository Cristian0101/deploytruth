import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareTruthReports,
  redactText,
  sanitizeForReport,
  type TruthReport,
} from '@deploytruth/core';
import {
  HistoryError,
  reportMatchesNamespace,
  serializeTruthReport,
  type ReportHistoryStore,
} from '@deploytruth/reporter';

const LOOPBACK_HOST = '127.0.0.1';
const MAX_REQUEST_BYTES = 1_024;

const contentTypes: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const safeErrorMessage = (error: unknown): string =>
  redactText(error instanceof Error ? error.message : 'The report could not be refreshed.');

const writeHeaders = (response: ServerResponse, status: number, contentType: string): void => {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Content-Type': contentType,
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
};

const writeJson = (response: ServerResponse, status: number, value: unknown): void => {
  writeHeaders(response, status, 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
};

const tokensEqual = (left: string | undefined, right: string): boolean => {
  if (left === undefined) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

export interface LocalReportServerOptions {
  readonly report: TruthReport;
  readonly port?: number;
  readonly staticMode?: boolean;
  readonly rerun?: () => Promise<TruthReport>;
  readonly assetsDirectory?: string;
  readonly onReport?: (report: TruthReport) => Promise<void> | void;
  readonly history?: {
    readonly store: ReportHistoryStore;
    readonly project: string;
    readonly environment: string;
  };
}

const historyErrorStatus = (error: HistoryError): number => {
  if (error.code === 'not_found' || error.code === 'invalid_id') return 404;
  if (error.code === 'unsupported' || error.code === 'corrupt') return 422;
  return 400;
};

const usableRunIds = async (
  history: NonNullable<LocalReportServerOptions['history']>,
): Promise<readonly string[]> =>
  (await history.store.list(history.project, history.environment))
    .filter((entry) => entry.status === 'ok')
    .map((entry) => entry.runId);

const getScopedReport = async (
  history: NonNullable<LocalReportServerOptions['history']>,
  runId: string,
): Promise<TruthReport> => {
  const report = await history.store.get(runId);
  if (!reportMatchesNamespace(report, history.project, history.environment)) {
    throw new HistoryError('not_found', 'Unknown run ID.');
  }
  return report;
};

const handleHistoryApi = async (
  url: URL,
  response: ServerResponse,
  history: LocalReportServerOptions['history'],
  staticMode: boolean,
): Promise<boolean> => {
  const isHistoryList = url.pathname === '/api/history';
  const historyRun = url.pathname.match(/^\/api\/history\/([^/]+)$/);
  const isCompare = url.pathname === '/api/compare';
  if (!isHistoryList && historyRun === null && !isCompare) {
    return false;
  }

  if (staticMode || history === undefined) {
    writeJson(response, 409, { error: 'Static report mode. History unavailable.' });
    return true;
  }

  try {
    if (isHistoryList) {
      writeJson(response, 200, {
        project: history.project,
        environment: history.environment,
        runs: await history.store.list(history.project, history.environment),
      });
      return true;
    }

    if (historyRun) {
      let runId: string;
      try {
        runId = decodeURIComponent(historyRun[1] ?? '');
      } catch {
        writeJson(response, 404, { error: 'Unknown run ID.' });
        return true;
      }
      if (
        runId.includes('/') ||
        runId.includes('\\') ||
        runId.includes('..') ||
        runId.includes('\0')
      ) {
        writeJson(response, 404, { error: 'Unknown run ID.' });
        return true;
      }
      const report = await getScopedReport(history, runId);
      writeHeaders(response, 200, 'application/json; charset=utf-8');
      response.end(serializeTruthReport(report));
      return true;
    }

    const requestedFrom = url.searchParams.get('from');
    const requestedTo = url.searchParams.get('to');
    if (
      (requestedFrom !== null &&
        (requestedFrom.includes('/') ||
          requestedFrom.includes('\\') ||
          requestedFrom.includes('..'))) ||
      (requestedTo !== null &&
        (requestedTo.includes('/') || requestedTo.includes('\\') || requestedTo.includes('..')))
    ) {
      writeJson(response, 400, { error: 'Run IDs must be store identifiers.' });
      return true;
    }

    const usable = await usableRunIds(history);
    const toId = requestedTo === null || requestedTo === 'latest' ? usable[0] : requestedTo;
    if (toId === undefined) {
      writeJson(response, 409, { error: 'Not enough stored runs to compare.' });
      return true;
    }
    const toReport = await getScopedReport(history, toId);
    const fromReport =
      requestedFrom === null
        ? await history.store.previous(toReport.runId)
        : await getScopedReport(history, requestedFrom);
    if (fromReport === undefined) {
      writeJson(response, 409, { error: 'Not enough stored runs to compare.' });
      return true;
    }
    if (fromReport.runId === toReport.runId) {
      writeJson(response, 400, { error: 'Comparison requires two different run IDs.' });
      return true;
    }
    const comparison = compareTruthReports(fromReport, toReport);
    writeJson(response, 200, sanitizeForReport(comparison));
    return true;
  } catch (error) {
    if (error instanceof HistoryError) {
      writeJson(response, historyErrorStatus(error), { error: error.message });
      return true;
    }
    writeJson(response, 500, { error: safeErrorMessage(error) });
    return true;
  }
};

export interface LocalReportServer {
  readonly host: typeof LOOPBACK_HOST;
  readonly port: number;
  readonly url: string;
  readonly close: () => Promise<void>;
}

export const startLocalReportServer = async (
  options: LocalReportServerOptions,
): Promise<LocalReportServer> => {
  let currentReport = options.report;
  let rerunActive = false;
  let expectedOrigin: string | undefined;
  const sessionToken = randomBytes(32).toString('base64url');
  const assetsDirectory = resolve(
    options.assetsDirectory ?? fileURLToPath(new URL('./web', import.meta.url)),
  );

  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const host = request.headers.host;
      if (
        host === undefined ||
        expectedOrigin === undefined ||
        `http://${host}` !== expectedOrigin
      ) {
        writeJson(response, 400, { error: 'Invalid local Host header.' });
        return;
      }

      const url = new URL(request.url ?? '/', expectedOrigin);

      if (request.method === 'GET' && url.pathname === '/api/report') {
        writeHeaders(response, 200, 'application/json; charset=utf-8');
        response.end(serializeTruthReport(currentReport));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/session') {
        writeJson(response, 200, {
          token: sessionToken,
          static: options.staticMode ?? false,
          rerunAvailable: options.rerun !== undefined && !(options.staticMode ?? false),
          historyAvailable: options.history !== undefined && !(options.staticMode ?? false),
        });
        return;
      }

      if (request.method === 'GET') {
        const handled = await handleHistoryApi(
          url,
          response,
          options.history,
          options.staticMode ?? false,
        );
        if (handled) return;
      }

      if (url.pathname === '/api/rerun') {
        if (request.method !== 'POST') {
          response.setHeader('Allow', 'POST');
          writeJson(response, 405, { error: 'Method not allowed.' });
          return;
        }
        if (
          request.headers.origin !== expectedOrigin ||
          !tokensEqual(request.headers['x-deploytruth-session'] as string | undefined, sessionToken)
        ) {
          writeJson(response, 403, { error: 'This local action was rejected.' });
          return;
        }
        const contentLength = Number(request.headers['content-length'] ?? 0);
        if (!Number.isFinite(contentLength) || contentLength > MAX_REQUEST_BYTES) {
          writeJson(response, 413, { error: 'Request body is too large.' });
          return;
        }
        if ((options.staticMode ?? false) || options.rerun === undefined) {
          writeJson(response, 409, { error: 'Saved reports are read-only.' });
          return;
        }
        if (rerunActive) {
          writeJson(response, 409, { error: 'A check is already running.' });
          return;
        }

        rerunActive = true;
        try {
          currentReport = await options.rerun();
          await options.onReport?.(currentReport);
          writeHeaders(response, 200, 'application/json; charset=utf-8');
          response.end(serializeTruthReport(currentReport));
        } catch (error) {
          writeJson(response, 500, { error: safeErrorMessage(error) });
        } finally {
          rerunActive = false;
        }
        return;
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        writeJson(response, 405, { error: 'Method not allowed.' });
        return;
      }

      let requestedPath: string;
      try {
        requestedPath =
          url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      } catch {
        writeJson(response, 404, { error: 'Not found.' });
        return;
      }
      const absolutePath = resolve(assetsDirectory, requestedPath);
      if (
        absolutePath !== assetsDirectory &&
        !absolutePath.startsWith(`${assetsDirectory}${sep}`)
      ) {
        writeJson(response, 404, { error: 'Not found.' });
        return;
      }

      try {
        const contents = await readFile(absolutePath);
        writeHeaders(
          response,
          200,
          contentTypes[extname(absolutePath)] ?? 'application/octet-stream',
        );
        response.end(request.method === 'HEAD' ? undefined : contents);
      } catch {
        writeJson(response, 404, { error: 'Not found.' });
      }
    } catch (error) {
      if (!response.headersSent) {
        writeJson(response, 500, { error: safeErrorMessage(error) });
      }
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => rejectListen(error);
    server.once('error', onError);
    server.listen(options.port ?? 0, LOOPBACK_HOST, () => {
      server.off('error', onError);
      resolveListen();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    throw new Error('DeployTruth could not determine the local report server address.');
  }

  const port = address.port;
  expectedOrigin = `http://${LOOPBACK_HOST}:${port}`;
  return {
    host: LOOPBACK_HOST,
    port,
    url: expectedOrigin,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        if ('closeAllConnections' in server) {
          server.closeAllConnections();
        }
      }),
  };
};
