import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createReportHistoryStore } from '@deploytruth/reporter';

import { createCli } from '../packages/cli/src/index.js';
import { cleanupTempDirs, tempDir } from './git-test-utils.js';
import { historySequences } from './history-sequences.js';

const manifestFor = (directory: string, environment = 'acceptance'): string => {
  const path = join(directory, 'deploytruth.yml');
  writeFileSync(
    path,
    `version: 1
project: meridia
environments:
  ${environment}:
    kind: production
    source: { provider: github, repository: acme/meridia, branch: main }
`,
  );
  return path;
};

afterEach(cleanupTempDirs);

const capture = async (argv: string[]): Promise<{ output: string; exit: number | undefined }> => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const previous = process.exitCode;
  process.exitCode = 0;
  try {
    await createCli().parseAsync(['node', 'deploytruth', ...argv]);
    return {
      output: [...log.mock.calls, ...error.mock.calls].map((call) => String(call[0])).join('\n'),
      exit: process.exitCode,
    };
  } finally {
    log.mockRestore();
    error.mockRestore();
    process.exitCode = previous;
  }
};

describe('deploytruth history and diff', () => {
  it('lists environment-scoped history with a limit', async () => {
    const directory = tempDir('dt-cli-history-');
    const config = manifestFor(directory);
    const store = createReportHistoryStore(directory);
    for (const report of [
      historySequences.healthyUpdate[0]!,
      historySequences.healthyUpdate[1]!,
      historySequences.regression[1]!,
    ]) {
      await store.save({
        ...report,
        environments: report.environments.map((environment) => ({
          ...environment,
          environment: 'acceptance',
          declaration: { ...environment.declaration, id: 'acceptance' },
        })),
      });
    }

    const all = await capture(['history', '-c', config, '-e', 'acceptance']);
    expect(all.output).toContain('DeployTruth History');
    expect(all.output).toContain('acceptance');
    expect(all.output).toContain('PASS');
    expect(all.output).not.toMatch(/ghp_|Bearer\s|postgres(?:ql)?:\/\//i);

    const limited = await capture(['history', '-c', config, '-e', 'acceptance', '--limit', '1']);
    const runIdLines = limited.output
      .split('\n')
      .filter((line) => /^[0-9A-HJKMNP-TV-Z]{26}/.test(line));
    expect(runIdLines).toHaveLength(1);
  });

  it('diffs the latest two runs by default and supports explicit IDs', async () => {
    const directory = tempDir('dt-cli-diff-');
    const config = manifestFor(directory);
    const store = createReportHistoryStore(directory);
    const from = {
      ...historySequences.regression[0]!,
      environments: historySequences.regression[0]!.environments.map((environment) => ({
        ...environment,
        environment: 'acceptance',
        declaration: { ...environment.declaration, id: 'acceptance' },
      })),
    };
    const to = {
      ...historySequences.regression[1]!,
      environments: historySequences.regression[1]!.environments.map((environment) => ({
        ...environment,
        environment: 'acceptance',
        declaration: { ...environment.declaration, id: 'acceptance' },
      })),
    };
    await store.save(from);
    await store.save(to);

    const latest = await capture(['diff', '-c', config, '-e', 'acceptance']);
    expect(latest.output).toContain('PASS → FAIL');
    expect(latest.output).toContain('NEW FINDING');
    expect(latest.output).toContain('DEPLOYMENT_SHA_MISMATCH');
    expect(latest.output).not.toMatch(/ghp_|Bearer\s|postgres(?:ql)?:\/\//i);

    const explicit = await capture([
      'diff',
      '-c',
      config,
      '-e',
      'acceptance',
      '--from',
      from.runId,
      '--to',
      to.runId,
    ]);
    expect(explicit.output).toContain(from.runId);
    expect(explicit.output).toContain(to.runId);

    const latestAlias = await capture([
      'diff',
      '-c',
      config,
      '-e',
      'acceptance',
      '--from',
      from.runId,
      '--to',
      'latest',
    ]);
    expect(latestAlias.output).toContain('PASS → FAIL');

    const unknown = await capture([
      'diff',
      '-c',
      config,
      '-e',
      'acceptance',
      '--from',
      from.runId,
      '--to',
      '01JUNKNOWNUNKNOWNUNKNOWNUNKN',
    ]);
    expect(unknown.exit).toBe(2);
    expect(unknown.output).toMatch(/Unknown run ID|Run IDs must/i);
  });

  it('errors when history is insufficient', async () => {
    const directory = tempDir('dt-cli-diff-empty-');
    const config = manifestFor(directory);
    const empty = await capture(['diff', '-c', config, '-e', 'acceptance']);
    expect(empty.exit).toBe(2);
    expect(empty.output).toContain('Not enough stored runs');
  });
});
