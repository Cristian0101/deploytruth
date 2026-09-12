import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import {
  evaluateTruth,
  projectDeclarationSchema,
  projectObservationSchema,
  type TruthContext,
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

const fixtureApi = (): Plugin => ({
  name: 'deploytruth-fixture-api',
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/api/session') {
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({ token: 'fixture-session', static: false, rerunAvailable: true }),
        );
        return;
      }
      if (url.pathname !== '/api/report' && url.pathname !== '/api/rerun') {
        next();
        return;
      }
      const fixture = url.searchParams.get('fixture') ?? 'healthy';
      const filename = fixtureFiles[fixture] ?? fixtureFiles.healthy;
      if (!filename) {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'Fixture not found.' }));
        return;
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
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Cache-Control', 'no-store');
      response.end(JSON.stringify(evaluateTruth(context)));
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
