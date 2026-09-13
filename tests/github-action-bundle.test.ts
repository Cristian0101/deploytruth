import { execFileSync, spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ACTION_OUTPUT_NAMES } from '../packages/github-action/src/action.js';
import { ACTION_INPUT_NAMES } from '../packages/github-action/src/inputs.js';
import { cleanupTempDirs, tempDir } from './git-test-utils.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const actionPackage = join(root, 'packages', 'github-action');
const actionEntry = join(actionPackage, 'dist', 'index.js');

const ACTION_YML = join(root, 'action.yml');
const CERTIFY_WORKFLOW = join(root, '.github', 'workflows', 'deploytruth-certify.yml');
const SUPABASE_CA = join(root, '.github', 'trust', 'supabase-root-2021-ca.crt');

/**
 * Extracts `name:` keys from a top-level action.yml block (`inputs:`/`outputs:`). Narrow on
 * purpose: action.yml is a small hand-maintained file, not arbitrary YAML.
 */
const actionYmlKeys = (section: 'inputs' | 'outputs'): readonly string[] => {
  const yaml = readFileSync(ACTION_YML, 'utf8');
  const match = yaml.match(new RegExp(`^${section}:\\n((?:  .+\\n)+)`, 'm'));
  if (match === null) {
    return [];
  }
  return [...match[1].matchAll(/^ {2}([a-z0-9-]+):/gm)].map((entry) => entry[1] ?? '');
};

interface ActionRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly workspace: string;
  readonly runnerTemp: string;
  readonly summaryFile: string;
  readonly outputFile: string;
}

const runBundledAction = (env: Readonly<Record<string, string>>): ActionRun => {
  const workspace = tempDir('dt-bundle-ws-');
  const runnerTemp = tempDir('dt-bundle-tmp-');
  const summaryFile = join(runnerTemp, 'step-summary.md');
  const outputFile = join(runnerTemp, 'github-output.txt');
  writeFileSync(
    join(workspace, 'deploytruth.yml'),
    'version: 1\nproject: smoke\nenvironments:\n  smoke:\n    kind: custom\n',
  );
  const result = spawnSync(process.execPath, [actionEntry], {
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '',
      GITHUB_WORKSPACE: workspace,
      RUNNER_TEMP: runnerTemp,
      GITHUB_STEP_SUMMARY: summaryFile,
      GITHUB_OUTPUT: outputFile,
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REPOSITORY: 'Cristian0101/deploytruth',
      GITHUB_WORKFLOW: 'DeployTruth Certify',
      GITHUB_RUN_ID: '9912345678',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_SHA: 'a'.repeat(40),
      GITHUB_REF: 'refs/heads/main',
      INPUT_ENVIRONMENT: 'smoke',
      INPUT_CONFIG: 'deploytruth.yml',
      'INPUT_FAIL-ON': 'fail',
      DEPLOYTRUTH_VERCEL_TOKEN: 'vcp_SENTINEL9f8e7d6c5b4a3210',
      DEPLOYTRUTH_SUPABASE_ACCESS_TOKEN: 'sbp_SENTINEL9f8e7d6c5b4a3210',
      DEPLOYTRUTH_SUPABASE_DATABASE_URL:
        'postgresql://postgres:SENTINELPASS@db.invalid:5432/postgres',
      ...env,
    },
    encoding: 'utf8',
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    workspace,
    runnerTemp,
    summaryFile,
    outputFile,
  };
};

const outputsFrom = (file: string): Readonly<Record<string, string>> => {
  const contents = readFileSync(file, 'utf8');
  const parsed: Record<string, string> = {};
  const blocks = contents.split('\n');
  for (let index = 0; index < blocks.length; index += 1) {
    const line = blocks[index];
    const marker = line?.match(/^([a-z0-9-]+)<<(.+)$/);
    if (marker?.[1] !== undefined && marker[2] !== undefined) {
      const name = marker[1];
      const delimiter = marker[2];
      const values: string[] = [];
      index += 1;
      while (index < blocks.length && blocks[index] !== delimiter) {
        values.push(blocks[index] ?? '');
        index += 1;
      }
      parsed[name] = values.join('\n');
    } else if (line !== undefined && line.includes('=')) {
      const [name, ...rest] = line.split('=');
      if (name !== undefined) {
        parsed[name] = rest.join('=');
      }
    }
  }
  return parsed;
};

beforeAll(() => {
  // The packaging test exercises the real committed-bundle path: build exactly what ships.
  execFileSync(join(root, 'node_modules', '.bin', 'tsup'), ['--config', 'tsup.config.ts'], {
    cwd: actionPackage,
    stdio: 'pipe',
  });
  expect(existsSync(actionEntry)).toBe(true);
}, 60_000);

afterEach(cleanupTempDirs);

describe('action.yml contract', () => {
  it('declares exactly the inputs the runtime reads', () => {
    expect(actionYmlKeys('inputs').sort()).toEqual([...ACTION_INPUT_NAMES].sort());
  });

  it('declares exactly the outputs the runtime emits', () => {
    expect(actionYmlKeys('outputs').sort()).toEqual([...ACTION_OUTPUT_NAMES].sort());
  });

  it('uses a supported Node runtime and the committed bundle', () => {
    const yaml = readFileSync(ACTION_YML, 'utf8');
    expect(yaml).toContain('using: node24');
    expect(yaml).toContain('main: packages/github-action/dist/index.js');
  });
});

describe('acceptance workflow TLS trust bootstrap', () => {
  it('pins a public Supabase CA without weakening peer verification', () => {
    const workflow = readFileSync(CERTIFY_WORKFLOW, 'utf8');
    const certificateText = readFileSync(SUPABASE_CA, 'utf8');
    const certificate = new X509Certificate(certificateText);

    expect(certificateText).not.toContain('PRIVATE KEY');
    expect(certificate.subject).toContain('CN=Supabase Root 2021 CA');
    expect(certificate.fingerprint256).toBe(
      '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA',
    );
    expect(Date.parse(certificate.validTo)).toBeGreaterThan(Date.now() + 86_400_000);
    expect(workflow).toContain(
      'NODE_EXTRA_CA_CERTS: ${{ github.workspace }}/.github/trust/supabase-root-2021-ca.crt',
    );
    expect(workflow).toContain('openssl x509 -in "$certificate" -noout -checkend 86400');
    expect(workflow).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED');
    expect(workflow).not.toContain('rejectUnauthorized: false');
  });
});

describe('bundled action execution', () => {
  it('runs end-to-end with no install step and emits safe evidence', () => {
    const run = runBundledAction({});
    expect(run.status).toBe(0);

    const outputs = outputsFrom(run.outputFile);
    expect(outputs['verdict']).toBe('PASS');
    expect(outputs['run-id']).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(outputs['environment']).toBe('smoke');
    for (const name of ACTION_OUTPUT_NAMES) {
      expect(outputs[name]).toBeDefined();
    }

    const summary = readFileSync(run.summaryFile, 'utf8');
    expect(summary).toContain('# DeployTruth — smoke');
    expect(summary).toContain('**PASS**');

    const directory = outputs['artifact-directory'] ?? '';
    expect(directory.startsWith(run.runnerTemp)).toBe(true);
    expect(readdirSync(directory).sort()).toEqual(
      ['ci-metadata.json', 'summary.md', 'truth-report.json'].sort(),
    );

    // Secrets present in the process environment never reach any evidence surface.
    const corpus = [
      readFileSync(run.outputFile, 'utf8'),
      summary,
      run.stdout,
      run.stderr,
      ...readdirSync(directory).map((name) => readFileSync(join(directory, name), 'utf8')),
    ].join('\n');
    expect(corpus).not.toContain('SENTINEL');
  });

  it('refuses pull_request_target with a clear security error', () => {
    const run = runBundledAction({ GITHUB_EVENT_NAME: 'pull_request_target' });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('::error::');
    expect(run.stdout).toContain('pull_request_target');
  });

  it('rejects a config path escaping the workspace', () => {
    const run = runBundledAction({ INPUT_CONFIG: '../outside.yml' });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('::error::');
  });

  it('fails when the required environment input is absent', () => {
    const run = runBundledAction({ INPUT_ENVIRONMENT: '' });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('::error::');
  });

  it('leaves no DeployTruth files inside the workspace', () => {
    const run = runBundledAction({});
    expect(run.status).toBe(0);
    const entries = readdirSync(run.workspace).filter(
      (name) => name !== 'deploytruth.yml' && name !== '.deploytruth',
    );
    expect(entries).toEqual([]);
  });
});
