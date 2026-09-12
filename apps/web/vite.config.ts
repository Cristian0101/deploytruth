import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import {
  compareTruthReports,
  evaluateTruth,
  projectDeclarationSchema,
  projectObservationSchema,
  type TruthContext,
  type TruthReport,
} from '../../packages/core/src/index.js';

const fixtureFiles: Readonly<Record<string, string>> = {
  healthy: 'healthy-production.json',
  'deployment-sha-mismatch': 'deployment-sha-mismatch.json',
  warning: 'dirty-worktree.json',
  unknown: 'unknown-evidence.json',
  'runtime-sha-mismatch': 'healthy-production.json',
  'database-unavailable': 'healthy-production.json',
  'multiple-findings': 'deployment-sha-mismatch.json',
};

let historyFixtures: Readonly<Record<string, readonly TruthReport[]>> | undefined;

const loadHistoryFixtures = async (): Promise<Readonly<Record<string, readonly TruthReport[]>>> => {
  if (historyFixtures) return historyFixtures;
  const { historySequences } = await import('../../tests/history-sequences.js');
  historyFixtures = {
    'history-update': historySequences.healthyUpdate,
    'history-regression': historySequences.regression,
    'history-recovery': historySequences.recovery,
    'history-persistent': historySequences.persistentWarning,
    'history-warning-fail': historySequences.warningToFail,
    'history-runtime-db': historySequences.runtimeDbWarning,
    'history-migrations': historySequences.migrationDivergence,
  };
  return historyFixtures;
};

const transformFixture = (fixture: string, context: TruthContext): TruthContext => {
  const production = context.observations.environments.production;
  if (!production) return context;

  if (fixture === 'runtime-sha-mismatch') {
    return {
      ...context,
      observations: {
        ...context.observations,
        environments: {
          ...context.observations.environments,
          production: {
            ...production,
            runtime: { ...production.runtime!, commitSha: 'def456' },
          },
        },
      },
    };
  }

  if (fixture === 'database-unavailable' || fixture === 'multiple-findings') {
    return {
      ...context,
      observations: {
        ...context.observations,
        environments: {
          ...context.observations.environments,
          production: {
            ...production,
            runtime: {
              ...production.runtime!,
              databaseConnection: {
                ...production.runtime!.databaseConnection!,
                status: 'unavailable',
                reason: 'network_error',
              },
            },
          },
        },
      },
    };
  }

  return context;
};

const summarize = (report: TruthReport) => {
  const warnings = report.findings.filter((finding) => finding.status === 'WARN').length;
  const failures = report.findings.filter((finding) => finding.status === 'FAIL').length;
  const total = report.environments.reduce(
    (sum, environment) =>
      sum + Object.values(environment.declaration.checks).filter(Boolean).length,
    0,
  );
  const sourceSha =
    report.environments[0]?.observation?.remoteSource?.remoteHeadSha ??
    report.environments[0]?.observation?.source?.headSha;
  return {
    runId: report.runId,
    timestamp: report.generatedAt,
    project: report.project,
    environment: report.environments[0]?.environment,
    verdict: report.verdict,
    reportVersion: report.schemaVersion,
    findingCount: report.findings.length,
    warningCount: warnings,
    failureCount: failures,
    verifiedCount: Math.max(0, total - warnings - failures),
    ...(sourceSha === undefined ? {} : { sourceSha }),
    status: 'ok' as const,
    schemaVersion: report.schemaVersion,
  };
};

const loadReport = async (fixture: string): Promise<TruthReport> => {
  if (fixture.startsWith('history-')) {
    const sequences = await loadHistoryFixtures();
    const sequence = sequences[fixture];
    const latest = sequence?.[sequence.length - 1];
    if (latest === undefined) {
      throw new Error('History fixture is empty.');
    }
    return latest;
  }
  const filename = fixtureFiles[fixture] ?? fixtureFiles.healthy;
  if (!filename) {
    throw new Error('Fixture not found.');
  }
  const fixturePath = fileURLToPath(
    new URL(`../../fixtures/scenarios/${filename}`, import.meta.url),
  );
  const raw = JSON.parse(await readFile(fixturePath, 'utf8')) as {
    declaration: unknown;
    observations: unknown;
    generatedAt: string;
    strict?: boolean;
  };
  const context = transformFixture(fixture, {
    declaration: projectDeclarationSchema.parse(raw.declaration),
    observations: projectObservationSchema.parse(raw.observations),
    generatedAt: raw.generatedAt,
    ...(raw.strict === undefined ? {} : { strict: raw.strict }),
  });
  return evaluateTruth(context);
};

const loadHistory = async (fixture: string): Promise<readonly TruthReport[]> => {
  if (fixture.startsWith('history-')) {
    const sequences = await loadHistoryFixtures();
    const sequence = sequences[fixture];
    if (sequence) return sequence;
  }
  return [await loadReport(fixture)];
};

const sendJson = (
  response: {
    statusCode: number;
    setHeader: (name: string, value: string) => void;
    end: (body: string) => void;
  },
  status: number,
  value: unknown,
): void => {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(value));
};

const fixtureApi = (): Plugin => ({
  name: 'deploytruth-fixture-api',
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const fixture = url.searchParams.get('fixture') ?? 'healthy';
      if (url.pathname === '/api/session') {
        sendJson(response, 200, {
          token: 'fixture-session',
          static: false,
          rerunAvailable: true,
          historyAvailable: true,
        });
        return;
      }

      try {
        if (url.pathname === '/api/history') {
          const runs = await loadHistory(fixture);
          sendJson(response, 200, {
            project: runs[0]?.project ?? 'unknown',
            environment: runs[0]?.environments[0]?.environment ?? 'unknown',
            runs: [...runs].reverse().map(summarize),
          });
          return;
        }

        const historyRun = url.pathname.match(/^\/api\/history\/([^/]+)$/);
        if (historyRun) {
          const runId = decodeURIComponent(historyRun[1] ?? '');
          const match = (await loadHistory(fixture)).find((report) => report.runId === runId);
          if (match === undefined) {
            sendJson(response, 404, { error: 'Unknown run ID.' });
            return;
          }
          sendJson(response, 200, match);
          return;
        }

        if (url.pathname === '/api/compare') {
          if (
            (url.searchParams.get('from') ?? '').includes('..') ||
            (url.searchParams.get('to') ?? '').includes('..') ||
            (url.searchParams.get('from') ?? '').includes('/') ||
            (url.searchParams.get('to') ?? '').includes('/')
          ) {
            sendJson(response, 400, { error: 'Run IDs must be store identifiers.' });
            return;
          }
          const runs = [...(await loadHistory(fixture))].reverse();
          const toId =
            url.searchParams.get('to') === null || url.searchParams.get('to') === 'latest'
              ? runs[0]?.runId
              : url.searchParams.get('to');
          const toIndex = runs.findIndex((report) => report.runId === toId);
          const fromId =
            url.searchParams.get('from') === null
              ? toIndex >= 0
                ? runs[toIndex + 1]?.runId
                : undefined
              : url.searchParams.get('from');
          const from = runs.find((report) => report.runId === fromId);
          const to = runs.find((report) => report.runId === toId);
          if (from === undefined || to === undefined) {
            sendJson(response, 409, { error: 'Not enough stored runs to compare.' });
            return;
          }
          sendJson(response, 200, compareTruthReports(from, to));
          return;
        }

        if (url.pathname !== '/api/report' && url.pathname !== '/api/rerun') {
          next();
          return;
        }
        sendJson(response, 200, await loadReport(fixture));
      } catch (error) {
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : 'Fixture unavailable.',
        });
      }
    });
  },
});

export default defineConfig(({ command }) => ({
  plugins: [react(), ...(command === 'serve' ? [fixtureApi()] : [])],
  resolve: {
    alias: {
      '@deploytruth/core': fileURLToPath(
        new URL('../../packages/core/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    host: '127.0.0.1',
  },
}));
