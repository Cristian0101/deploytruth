import { mkdtemp, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { evaluateTruth, type TruthReport } from '@deploytruth/core';
import { afterEach, describe, expect, it } from 'vitest';

import { startLocalReportServer, type LocalReportServer } from '../packages/cli/src/open.js';
import { loadScenario } from './scenario-loader.js';

const servers: LocalReportServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const start = async (
  options: { report?: TruthReport; staticMode?: boolean; rerun?: () => Promise<TruthReport> } = {},
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
  });
  servers.push(server);
  return server;
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
});
