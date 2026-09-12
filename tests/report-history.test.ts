import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createReportHistoryStore,
  HistoryError,
  parseStoredReport,
  serializeTruthReport,
} from '@deploytruth/reporter';

import { cleanupTempDirs, tempDir } from './git-test-utils.js';
import { historySequences, reportFromScenario, fixedRunId } from './history-sequences.js';

afterEach(cleanupTempDirs);

describe('report history store', () => {
  it('saves, lists newest-first by report timestamp, and returns latest/previous', async () => {
    const root = tempDir('dt-history-order-');
    const store = createReportHistoryStore(root);
    const [older, newer] = historySequences.healthyUpdate;
    if (!older || !newer) throw new Error('sequence');
    await store.save(older);
    await store.save(newer);

    const listed = await store.list(newer.project, 'production');
    expect(listed.map((entry) => entry.runId)).toEqual([newer.runId, older.runId]);
    expect(listed[0]?.timestamp).toBe(newer.generatedAt);
    expect((await store.latest(newer.project, 'production'))?.runId).toBe(newer.runId);
    expect((await store.previous(newer.runId))?.runId).toBe(older.runId);
    expect(await store.get(older.runId)).toMatchObject({ runId: older.runId, verdict: 'PASS' });
  });

  it('isolates projects and environments', async () => {
    const root = tempDir('dt-history-isolate-');
    const store = createReportHistoryStore(root);
    const production = historySequences.healthyUpdate[0]!;
    const otherEnv = reportFromScenario('healthy-production', {
      runId: fixedRunId(Date.parse('2026-09-12T19:00:00Z'), 21),
      generatedAt: '2026-09-12T19:00:00.000Z',
      transform: (context) => ({
        ...context,
        declaration: {
          ...context.declaration,
          environments: {
            acceptance: {
              ...context.declaration.environments.production!,
              id: 'acceptance',
            },
          },
        },
        observations: {
          ...context.observations,
          environments: {
            acceptance: {
              ...context.observations.environments.production!,
              environment: 'acceptance',
            },
          },
        },
      }),
    });
    const otherProject = {
      ...production,
      runId: fixedRunId(Date.parse('2026-09-12T20:00:00Z'), 22),
      project: 'other-app',
    };

    await store.save(production);
    await store.save(otherEnv);
    await store.save(otherProject);

    expect(
      (await store.list(production.project, 'production')).map((entry) => entry.runId),
    ).toEqual([production.runId]);
    expect(
      (await store.list(production.project, 'acceptance')).map((entry) => entry.runId),
    ).toEqual([otherEnv.runId]);
    expect((await store.list('other-app', 'production')).map((entry) => entry.runId)).toEqual([
      otherProject.runId,
    ]);
  });

  it('rejects path-traversal project and environment names', async () => {
    const store = createReportHistoryStore(tempDir('dt-history-path-'));
    await expect(store.list('../etc', 'production')).rejects.toMatchObject({
      code: 'invalid_path',
    });
    await expect(store.list('acme', '../../passwd')).rejects.toMatchObject({
      code: 'invalid_path',
    });
    await expect(store.list('/tmp', 'production')).rejects.toMatchObject({ code: 'invalid_path' });
    await expect(store.list('acme', 'prod\0uction')).rejects.toMatchObject({
      code: 'invalid_path',
    });
  });

  it('fails safely for unknown, corrupt, and unsupported reports', async () => {
    const root = tempDir('dt-history-corrupt-');
    const store = createReportHistoryStore(root);
    const report = historySequences.healthyUpdate[0]!;
    await store.save(report);
    const directory = join(root, '.deploytruth', 'reports', report.project, 'production');
    await writeFile(join(directory, `${fixedRunId(1, 30)}.json`), '{not-json', 'utf8');
    await writeFile(
      join(directory, `${fixedRunId(2, 31)}.json`),
      `${JSON.stringify({ schemaVersion: '9.9', generatedAt: report.generatedAt, project: report.project })}\n`,
      'utf8',
    );

    const listed = await store.list(report.project, 'production');
    expect(listed.some((entry) => entry.status === 'corrupt')).toBe(true);
    expect(listed.some((entry) => entry.status === 'unsupported')).toBe(true);
    expect(listed.some((entry) => entry.status === 'ok' && entry.runId === report.runId)).toBe(
      true,
    );

    await expect(store.get('../secrets')).rejects.toMatchObject({ code: 'invalid_id' });
    await expect(store.get(fixedRunId(9, 99))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('writes atomically and overwrites a duplicate run identity', async () => {
    const root = tempDir('dt-history-atomic-');
    const store = createReportHistoryStore(root);
    const first = historySequences.healthyUpdate[0]!;
    await store.save(first);
    const updated = { ...first, verdict: 'WARN' as const };
    await store.save(updated);
    const listed = await store.list(first.project, 'production');
    expect(listed.filter((entry) => entry.runId === first.runId)).toHaveLength(1);
    expect((await store.get(first.runId)).verdict).toBe('WARN');
    const files = await readdir(join(root, '.deploytruth', 'reports', first.project, 'production'));
    expect(files.some((name) => name.endsWith('.tmp'))).toBe(false);
    const persisted = await readFile(
      join(root, '.deploytruth', 'reports', first.project, 'production', `${first.runId}.json`),
      'utf8',
    );
    expect(persisted).toContain('"verdict": "WARN"');
    expect(JSON.parse(persisted).runId).toBe(first.runId);
  });

  it('does not treat leftover temp files as truth and removes them on list', async () => {
    const root = tempDir('dt-history-tmp-');
    const store = createReportHistoryStore(root);
    const report = historySequences.healthyUpdate[0]!;
    await store.save(report);
    const directory = join(root, '.deploytruth', 'reports', report.project, 'production');
    await writeFile(
      join(directory, `${report.runId}.json.deadbeef.tmp`),
      '{"schemaVersion":"0.2"}',
      'utf8',
    );
    const listed = await store.list(report.project, 'production');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.runId).toBe(report.runId);
    expect((await readdir(directory)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('migrates known 0.1 reports additively without inventing findings', async () => {
    const current = historySequences.healthyUpdate[0]!;
    const serialized = JSON.parse(serializeTruthReport(current)) as Record<string, unknown>;
    delete serialized.runId;
    serialized.schemaVersion = '0.1';
    const parsed = parseStoredReport(`${JSON.stringify(serialized)}\n`);
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') return;
    expect(parsed.migrated).toBe(true);
    expect(parsed.report.verdict).toBe(current.verdict);
    expect(parsed.report.findings).toEqual(current.findings);
    expect(parsed.report.runId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe('history path isolation', () => {
  it('never creates directories outside the report store', async () => {
    const root = tempDir('dt-history-escape-');
    const store = createReportHistoryStore(root);
    await expect(
      store.save({
        ...historySequences.healthyUpdate[0]!,
        project: '../outside',
      }),
    ).rejects.toBeInstanceOf(HistoryError);
    await expect(mkdir(join(root, 'outside'), { recursive: true })).resolves.toBeDefined();
    const outside = await readdir(root);
    expect(outside).not.toContain('outside-report');
  });
});
