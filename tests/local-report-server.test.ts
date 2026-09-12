import { mkdtemp, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { evaluateTruth, type TruthReport } from '@deploytruth/core';
import { createReportHistoryStore, type ReportHistoryStore } from '@deploytruth/reporter';
import { afterEach, describe, expect, it } from 'vitest';

import { startLocalReportServer, type LocalReportServer } from '../packages/cli/src/open.js';
import { cleanupTempDirs, tempDir } from './git-test-utils.js';
import { historySequences } from './history-sequences.js';
import { loadScenario } from './scenario-loader.js';

const servers: LocalReportServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  cleanupTempDirs();
});

const start = async (
  options: {
    report?: TruthReport;
    staticMode?: boolean;
    rerun?: () => Promise<TruthReport>;
    history?: { store: ReportHistoryStore; project: string; environment: string };
  } = {},
) => {
  const assetsDirectory = await mkdtemp(join(tmpdir(), 'deploytruth-web-'));
  await writeFile(
    join(assetsDirectory, 'index.html'),
    '<!doctype html><title>DeployTruth</title>',
    'utf8',
  );
  const server = await startLocalReportServer({
    report: options.report ?? evaluateTruth(loadScenario('healthy-production')),
    assetsDirectory,
    ...(options.staticMode === undefined ? {} : { staticMode: options.staticMode }),
    ...(options.rerun === undefined ? {} : { rerun: options.rerun }),
    ...(options.history === undefined ? {} : { history: options.history }),
  });
  servers.push(server);
  return server;
};

const seededHistory = async () => {
  const store = createReportHistoryStore(tempDir('dt-server-history-'));
  const from = historySequences.regression[0]!;
  const to = historySequences.regression[1]!;
  await store.save(from);
  await store.save(to);
  return {
    store,
    from,
    to,
    history: { store, project: to.project, environment: to.environments[0]!.environment },
  };
};

describe('local report server', () => {
  it('binds loopback, serves only the normalized report, and sets defensive headers', async () => {
    const server = await start();
    expect(server.host).toBe('127.0.0.1');
    const response = await fetch(`${server.url}/api/report`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    const report = (await response.json()) as TruthReport;
    expect(report.verdict).toBe('PASS');
    expect(JSON.stringify(report)).not.toMatch(/Bearer\s|postgres(?:ql)?:\/\/|ghp_/i);
  });

  it('rejects traversal and all unsupported control methods', async () => {
    const server = await start();
    expect((await fetch(`${server.url}/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
    expect((await fetch(`${server.url}/%E0%A4%A`)).status).toBe(404);
    expect((await fetch(`${server.url}/api/report`, { method: 'POST' })).status).toBe(405);
  });

  it('requires the same origin and ephemeral session token for reruns', async () => {
    const next = evaluateTruth(loadScenario('dirty-worktree'));
    const server = await start({ rerun: async () => next });
    const session = (await (await fetch(`${server.url}/api/session`)).json()) as { token: string };
    expect((await fetch(`${server.url}/api/rerun`, { method: 'POST' })).status).toBe(403);
    expect(
      (
        await fetch(`${server.url}/api/rerun`, {
          method: 'POST',
          headers: { Origin: 'https://example.com', 'X-DeployTruth-Session': session.token },
        })
      ).status,
    ).toBe(403);
    const response = await fetch(`${server.url}/api/rerun`, {
      method: 'POST',
      headers: { Origin: server.url, 'X-DeployTruth-Session': session.token },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as TruthReport).verdict).toBe('WARN');
  });

  it('rejects DNS-rebinding-style Host and Origin substitution', async () => {
    const server = await start({
      rerun: async () => evaluateTruth(loadScenario('dirty-worktree')),
    });
    const status = await new Promise<number>((resolveStatus, rejectRequest) => {
      const pending = request(
        `${server.url}/api/rerun`,
        {
          method: 'POST',
          headers: {
            Host: 'attacker.example',
            Origin: 'http://attacker.example',
            'X-DeployTruth-Session': 'untrusted',
          },
        },
        (response) => {
          response.resume();
          response.once('end', () => resolveStatus(response.statusCode ?? 0));
        },
      );
      pending.once('error', rejectRequest);
      pending.end();
    });
    expect(status).toBe(400);
  });

  it('disables reruns for a validated saved report', async () => {
    const server = await start({
      staticMode: true,
      rerun: async () => evaluateTruth(loadScenario('dirty-worktree')),
    });
    const session = (await (await fetch(`${server.url}/api/session`)).json()) as { token: string };
    const response = await fetch(`${server.url}/api/rerun`, {
      method: 'POST',
      headers: { Origin: server.url, 'X-DeployTruth-Session': session.token },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Saved reports are read-only.' });
  });

  it('serves history and comparison through store IDs only', async () => {
    const seeded = await seededHistory();
    const server = await start({ report: seeded.to, history: seeded.history });
    const session = (await (await fetch(`${server.url}/api/session`)).json()) as {
      historyAvailable: boolean;
    };
    expect(session.historyAvailable).toBe(true);

    const list = await fetch(`${server.url}/api/history`);
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { runs: Array<{ runId: string }> };
    expect(listed.runs.map((run) => run.runId)).toEqual([seeded.to.runId, seeded.from.runId]);

    const run = await fetch(`${server.url}/api/history/${seeded.from.runId}`);
    expect(run.status).toBe(200);
    expect(((await run.json()) as TruthReport).runId).toBe(seeded.from.runId);

    const compared = await fetch(`${server.url}/api/compare`);
    expect(compared.status).toBe(200);
    const body = (await compared.json()) as {
      verdictChange: { from: string; to: string };
      findingChanges: Array<{ lifecycle: string; code: string }>;
    };
    expect(body.verdictChange).toMatchObject({ from: 'PASS', to: 'FAIL' });
    expect(body.findingChanges.some((change) => change.lifecycle === 'NEW')).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/ghp_|Bearer\s|postgres(?:ql)?:\/\//i);
  });

  it('does not resolve run IDs from another environment namespace', async () => {
    const seeded = await seededHistory();
    const other = {
      ...historySequences.healthyUpdate[0]!,
      project: seeded.to.project,
      environments: historySequences.healthyUpdate[0]!.environments.map((environment) => ({
        ...environment,
        environment: 'acceptance',
        declaration: { ...environment.declaration, id: 'acceptance' },
      })),
    };
    await seeded.store.save(other);
    const server = await start({ report: seeded.to, history: seeded.history });
    expect((await fetch(`${server.url}/api/history/${other.runId}`)).status).toBe(404);
    expect(
      (await fetch(`${server.url}/api/compare?from=${other.runId}&to=${seeded.to.runId}`)).status,
    ).toBe(404);
  });

  it('rejects traversal, unknown IDs, and static-mode history access', async () => {
    const seeded = await seededHistory();
    const live = await start({ report: seeded.to, history: seeded.history });
    const get = async (path: string): Promise<number> => {
      const response = await fetch(`${live.url}${path}`, { signal: AbortSignal.timeout(1000) });
      return response.status;
    };
    expect(await get('/api/history/not-a-run-id')).toBe(404);
    expect(await get('/api/compare?from=not-a-run-id&to=latest')).toBe(404);
    expect(await get('/api/compare?from=..%2Fetc%2Fpasswd&to=latest')).toBe(400);

    const staticServer = await start({
      report: seeded.to,
      staticMode: true,
      history: seeded.history,
    });
    const blocked = await fetch(`${staticServer.url}/api/history`, {
      signal: AbortSignal.timeout(1000),
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({
      error: 'Static report mode. History unavailable.',
    });
    const session = (await (
      await fetch(`${staticServer.url}/api/session`, { signal: AbortSignal.timeout(1000) })
    ).json()) as {
      historyAvailable: boolean;
      rerunAvailable: boolean;
    };
    expect(session.historyAvailable).toBe(false);
    expect(session.rerunAvailable).toBe(false);
  });
});
