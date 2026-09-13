import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createRunId,
  evaluateTruth,
  isRunId,
  truthReportSchema,
  type TruthReport,
} from '@deploytruth/core';
import {
  buildTruthSummaryMarkdown,
  createReportHistoryStore,
  parseStoredReport,
  reportFindingCounts,
  serializeTruthReport,
  writeLocalReport,
} from '@deploytruth/reporter';
import { afterEach, describe, expect, it } from 'vitest';

import { runAction, type ActionDeps, type ActionIO } from '../packages/github-action/src/action.js';
import { CI_BUNDLE_FILENAMES } from '../packages/github-action/src/bundle.js';
import { ciMetadataSchema } from '../packages/github-action/src/ci-metadata.js';
import {
  ActionInputError,
  parseActionInputs,
  resolveConfigPath,
} from '../packages/github-action/src/inputs.js';
import { cleanupTempDirs, git, initRepo, tempDir } from './git-test-utils.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const FIXED_RUN_ID = createRunId(1_700_000_000_000, new Uint8Array(10).fill(7));

const SECRETS: Record<string, string> = {
  DEPLOYTRUTH_GITHUB_TOKEN: 'ghp_SENTINEL9f8e7d6c5b4a3210',
  DEPLOYTRUTH_VERCEL_TOKEN: 'vcp_SENTINEL9f8e7d6c5b4a3210',
  DEPLOYTRUTH_SUPABASE_ACCESS_TOKEN: 'sbp_SENTINEL9f8e7d6c5b4a3210',
  DEPLOYTRUTH_SUPABASE_DATABASE_URL:
    'postgresql://postgres:SENTINELPASS9f8e7d6c@db.example.invalid:5432/postgres',
};
const SENTINELS = ['SENTINEL9f8e7d6c5b4a3210', 'SENTINELPASS9f8e7d6c'];

interface FakeIo {
  readonly io: ActionIO;
  readonly outputs: Map<string, string>;
  readonly info: string[];
  readonly warnings: string[];
  readonly failures: string[];
  readonly summaries: string[];
}

const createFakeIo = (): FakeIo => {
  const outputs = new Map<string, string>();
  const info: string[] = [];
  const warnings: string[] = [];
  const failures: string[] = [];
  const summaries: string[] = [];
  return {
    outputs,
    info,
    warnings,
    failures,
    summaries,
    io: {
      info: (message) => info.push(message),
      warning: (message) => warnings.push(message),
      setOutput: (name, value) => outputs.set(name, value),
      writeSummary: async (markdown) => {
        summaries.push(markdown);
      },
      fail: (message) => failures.push(message),
    },
  };
};

const passDeclaration = {
  version: 1 as const,
  project: 'fixture-app',
  environments: {
    production: {
      id: 'production',
      kind: 'production' as const,
      source: { provider: 'github', repository: 'example/app', branch: 'main' },
      deployment: { provider: 'vercel', project: 'app', target: 'production' as const },
      requiredEnvironmentVariables: [],
      checks: { local_git: true, remote_source: true, deployment_sha: true },
    },
  },
};

const passObservation = {
  environment: 'production',
  source: {
    provider: 'git',
    branch: 'main',
    headSha: SHA_A,
    workingTree: 'clean' as const,
    upstream: { remote: 'origin', branch: 'main', ref: 'refs/remotes/origin/main', sha: SHA_A },
  },
  remoteSource: {
    provider: 'github',
    repository: 'example/app',
    branch: 'main',
    remoteHeadSha: SHA_A,
    availability: { state: 'available' as const },
  },
  deployment: {
    provider: 'vercel',
    project: 'app',
    target: 'production',
    state: 'ready' as const,
    commitSha: SHA_A,
    availability: { state: 'available' as const },
  },
};

const makeReport = (overrides: {
  readonly workingTree?: 'clean' | 'dirty';
  readonly deploymentSha?: string;
  readonly omitDeployment?: boolean;
  readonly environment?: string;
  readonly runId?: string;
  readonly verdict?: 'PASS' | 'WARN' | 'FAIL';
  readonly findings?: TruthReport['findings'];
}): TruthReport => {
  const environment = overrides.environment ?? 'production';
  if (overrides.findings === undefined) {
    const observation = {
      environment,
      source: {
        ...passObservation.source,
        workingTree: overrides.workingTree ?? 'clean',
      },
      remoteSource: passObservation.remoteSource,
      ...(overrides.omitDeployment === true
        ? {}
        : {
            deployment: {
              ...passObservation.deployment,
              commitSha: overrides.deploymentSha ?? SHA_A,
            },
          }),
    };
    return evaluateTruth(
      {
        declaration: passDeclaration,
        observations: {
          project: 'fixture-app',
          environments: { [environment]: observation },
        },
        generatedAt: '2026-01-01T00:00:00.000Z',
        runId: overrides.runId ?? FIXED_RUN_ID,
      },
      undefined,
      { environments: [environment] },
    );
  }
  const verdict = overrides.verdict ?? 'FAIL';
  const environmentTruth = {
    environment,
    declaration: passDeclaration.environments.production,
    findings: overrides.findings,
    verdict,
  };
  return truthReportSchema.parse({
    schemaVersion: '0.2',
    runId: overrides.runId ?? FIXED_RUN_ID,
    generatedAt: '2026-01-01T00:00:00.000Z',
    project: 'fixture-app',
    strict: false,
    verdict,
    environments: [environmentTruth],
    findings: overrides.findings,
    topology: { nodes: [], edges: [] },
    metadata: {},
  });
};

const passReport = (): TruthReport => makeReport({});
const warnReport = (): TruthReport => makeReport({ workingTree: 'dirty' });
const failReport = (): TruthReport => makeReport({ deploymentSha: SHA_B });

interface Harness {
  readonly deps: ActionDeps;
  readonly fake: FakeIo;
  readonly workspace: string;
  readonly tempRoot: string;
  readonly calls: { count: number };
}

const createHarness = (input: {
  readonly report?: TruthReport;
  readonly runCheck?: ActionDeps['runCheck'];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly inputs?: ActionDeps['inputs'];
  readonly persist?: 'none' | ActionDeps['persistReport'];
  readonly workspace?: string;
}): Harness => {
  const workspace = input.workspace ?? tempDir('dt-action-ws-');
  const tempRoot = tempDir('dt-action-tmp-');
  const fake = createFakeIo();
  const calls = { count: 0 };
  const report = input.report ?? passReport();
  const runCheck: ActionDeps['runCheck'] =
    input.runCheck ??
    (async () => {
      calls.count += 1;
      return {
        report,
        environmentId: report.environments[0]?.environment ?? 'production',
        diagnostics: [],
      };
    });
  const env: Record<string, string | undefined> = {
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REPOSITORY: 'Cristian0101/deploytruth',
    GITHUB_WORKFLOW: 'DeployTruth Certify',
    GITHUB_JOB: 'certify',
    GITHUB_RUN_ID: '9912345678',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_RUN_NUMBER: '42',
    GITHUB_SHA: SHA_A,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: tempRoot,
    ...SECRETS,
    ...input.env,
  };
  const persist = input.persist === 'none' ? undefined : (input.persist ?? writeLocalReport);
  return {
    deps: {
      inputs: { environment: 'production', ...input.inputs },
      env,
      runCheck,
      ...(persist === undefined ? {} : { persistReport: persist }),
      io: fake.io,
    },
    fake,
    workspace,
    tempRoot,
    calls,
  };
};

const readBundle = (directory: string) => {
  const entries = readdirSync(directory).sort();
  const reportJson = readFileSync(join(directory, CI_BUNDLE_FILENAMES.report), 'utf8');
  const summary = readFileSync(join(directory, CI_BUNDLE_FILENAMES.summary), 'utf8');
  const metadataJson = readFileSync(join(directory, CI_BUNDLE_FILENAMES.metadata), 'utf8');
  return { entries, reportJson, summary, metadataJson };
};

afterEach(cleanupTempDirs);

describe('action inputs', () => {
  it('requires environment', () => {
    expect(() => parseActionInputs({})).toThrow(ActionInputError);
    expect(() => parseActionInputs({ environment: '   ' })).toThrow(ActionInputError);
  });

  it('defaults config to deploytruth.yml and fail-on to fail', () => {
    const inputs = parseActionInputs({ environment: 'production' });
    expect(inputs.config).toBe('deploytruth.yml');
    expect(inputs.failOn).toBe('fail');
    expect(inputs.environment).toBe('production');
  });

  it.each(['fail', 'warn', 'never'] as const)('accepts fail-on=%s', (failOn) => {
    expect(parseActionInputs({ environment: 'e', failOn }).failOn).toBe(failOn);
  });

  it.each(['always', 'error', 'PASS'])('rejects invalid fail-on=%s', (failOn) => {
    expect(() => parseActionInputs({ environment: 'e', failOn })).toThrow(ActionInputError);
  });

  it.each([
    '/etc/deploytruth.yml',
    'C:\\secrets\\deploytruth.yml',
    '~/deploytruth.yml',
    '../deploytruth.yml',
    'sub/../../deploytruth.yml',
    'sub//deploytruth.yml',
    './deploytruth.yml',
    'sub/./deploytruth.yml',
    'sub dir/deploytruth.yml',
    'deploytruth.yml\\..\\x',
    'deploytruth.yml\x00',
  ])('rejects unsafe config path %s', (config) => {
    expect(() => parseActionInputs({ environment: 'e', config })).toThrow(ActionInputError);
  });

  it.each(['deploytruth.yml', 'ci/deploytruth.yml', '.github/deploytruth.yml'])(
    'accepts repository-relative config path %s',
    (config) => {
      expect(parseActionInputs({ environment: 'e', config }).config).toBe(config);
    },
  );

  it('resolves config strictly inside the workspace', () => {
    const workspace = tempDir('dt-action-path-');
    expect(resolveConfigPath(workspace, 'ci/deploytruth.yml')).toBe(
      join(workspace, 'ci', 'deploytruth.yml'),
    );
  });

  it('fails the run when the environment input is missing', async () => {
    const harness = createHarness({ inputs: { environment: undefined } });
    const outcome = await runAction(harness.deps);
    expect(outcome.status).toBe('failed');
    expect(harness.calls.count).toBe(0);
  });
});

describe('fail-on policy matrix', () => {
  const verdicts = { PASS: passReport, WARN: warnReport, FAIL: failReport } as const;
  const cases: ReadonlyArray<readonly [keyof typeof verdicts, string, 'success' | 'failed']> = [
    ['PASS', 'fail', 'success'],
    ['WARN', 'fail', 'success'],
    ['FAIL', 'fail', 'failed'],
    ['PASS', 'warn', 'success'],
    ['WARN', 'warn', 'failed'],
    ['FAIL', 'warn', 'failed'],
    ['PASS', 'never', 'success'],
    ['WARN', 'never', 'success'],
    ['FAIL', 'never', 'success'],
  ];

  it.each(cases)('%s + fail-on=%s → %s', async (verdict, failOn, expected) => {
    const harness = createHarness({
      report: verdicts[verdict](),
      inputs: { environment: 'production', failOn },
    });
    const outcome = await runAction(harness.deps);
    expect(outcome.status).toBe(expected);
    // Summary and outputs must exist even when the step fails.
    expect(harness.fake.summaries.join('\n')).toContain(`**${verdict}**`);
    expect(harness.fake.outputs.get('verdict')).toBe(verdict);
    expect(harness.fake.outputs.get('artifact-directory')).toBeTruthy();
  });

  it('never hides execution errors even with fail-on=never', async () => {
    const harness = createHarness({
      runCheck: async () => {
        throw new Error('manifest exploded');
      },
      inputs: { environment: 'production', failOn: 'never' },
    });
    const outcome = await runAction(harness.deps);
    expect(outcome.status).toBe('failed');
    expect(harness.fake.failures[0]).toContain('execution failed');
    expect(harness.fake.summaries.join('\n')).toContain('failed before certification');
    // No truth outputs may be invented for a failed execution.
    expect(harness.fake.outputs.has('verdict')).toBe(false);
  });

  it('WARN under fail-on=fail stays successful but visibly warns', async () => {
    const harness = createHarness({ report: warnReport() });
    const outcome = await runAction(harness.deps);
    expect(outcome.status).toBe('success');
    expect(harness.fake.warnings.join('\n')).toContain('WARN');
    expect(harness.fake.failures).toHaveLength(0);
  });

  it('FAIL under fail-on=never keeps the step green without disguising the verdict', async () => {
    const harness = createHarness({
      report: failReport(),
      inputs: { environment: 'production', failOn: 'never' },
    });
    const outcome = await runAction(harness.deps);
    expect(outcome.status).toBe('success');
    expect(harness.fake.failures).toHaveLength(0);
    expect(harness.fake.warnings.join('\n')).toContain('FAIL');
    expect(harness.fake.summaries.join('\n')).toContain('**FAIL**');
    expect(harness.fake.warnings.join('\n')).not.toContain('PASS');
  });
});

describe('action outputs', () => {
  it('emits the complete machine-readable output set', async () => {
    const harness = createHarness({ report: failReport() });
    await runAction(harness.deps);
    const outputs = harness.fake.outputs;
    expect(outputs.get('verdict')).toBe('FAIL');
    const runId = outputs.get('run-id');
    expect(runId).toBe(FIXED_RUN_ID);
    expect(isRunId(runId ?? '')).toBe(true);
    expect(outputs.get('verified')).toMatch(/^[0-9]+$/);
    expect(outputs.get('warnings')).toMatch(/^[0-9]+$/);
    expect(outputs.get('failures')).toBe('1');
    expect(outputs.get('findings')).toBe('1');
    expect(outputs.get('environment')).toBe('production');
    for (const key of ['report-path', 'summary-path', 'metadata-path']) {
      const value = outputs.get(key);
      expect(value).toBeTruthy();
      expect(value?.startsWith(join(harness.tempRoot, 'deploytruth'))).toBe(true);
    }
    expect(outputs.get('artifact-directory')).toBe(
      join(harness.tempRoot, 'deploytruth', FIXED_RUN_ID),
    );
  });

  it('counts match the shared report interpretation', async () => {
    const report = warnReport();
    const harness = createHarness({ report });
    await runAction(harness.deps);
    const counts = reportFindingCounts(report);
    expect(harness.fake.outputs.get('verified')).toBe(String(counts.verified));
    expect(harness.fake.outputs.get('warnings')).toBe(String(counts.warnings));
    expect(harness.fake.outputs.get('failures')).toBe(String(counts.failures));
    expect(harness.fake.outputs.get('findings')).toBe(String(counts.findings));
  });

  it('never emits the raw report JSON or secrets in outputs', async () => {
    const harness = createHarness({ report: failReport() });
    await runAction(harness.deps);
    const all = [...harness.fake.outputs.values()].join('\n');
    expect(all).not.toContain('"schemaVersion"');
    for (const sentinel of SENTINELS) {
      expect(all).not.toContain(sentinel);
    }
  });

  it('runs the check orchestration exactly once and reuses its run ID everywhere', async () => {
    const harness = createHarness({ report: failReport() });
    const outcome = await runAction(harness.deps);
    expect(outcome.status).toBe('failed');
    expect(harness.calls.count).toBe(1);
    const { metadataJson } = readBundle(harness.fake.outputs.get('artifact-directory') ?? '');
    const metadata = ciMetadataSchema.parse(JSON.parse(metadataJson));
    expect(metadata.truthRunId).toBe(FIXED_RUN_ID);
    expect(metadata.githubRunId).toBe('9912345678');
    expect(metadata.truthRunId).not.toBe(metadata.githubRunId);
  });
});

describe('job summary markdown', () => {
  it('renders the healthy PASS form', () => {
    const markdown = buildTruthSummaryMarkdown(passReport());
    expect(markdown).toContain('# DeployTruth — production');
    expect(markdown).toContain('**PASS**');
    expect(markdown).toContain('3 verified · 0 warnings · 0 failures');
    expect(markdown).toContain('| Check | Status |');
    expect(markdown).toContain('| Local Git | VERIFIED |');
    expect(markdown).toContain('| GitHub source | VERIFIED |');
    expect(markdown).toContain('| GitHub → Vercel | VERIFIED |');
    expect(markdown).toContain('No findings.');
    expect(markdown).toContain(`Run ID: \`${FIXED_RUN_ID}\``);
  });

  it('renders WARN findings with evidence', () => {
    const markdown = buildTruthSummaryMarkdown(warnReport());
    expect(markdown).toContain('**WARN**');
    expect(markdown).toContain('1 warning');
    expect(markdown).toContain('DIRTY_WORKTREE');
    expect(markdown).toContain('| Local Git | WARN |');
  });

  it('renders FAIL with expected/observed evidence', () => {
    const markdown = buildTruthSummaryMarkdown(failReport());
    expect(markdown).toContain('**FAIL**');
    expect(markdown).toContain('1 failure');
    expect(markdown).toContain('DEPLOYMENT_SHA_MISMATCH');
    expect(markdown).toContain('HIGH · FAIL · GitHub → Vercel');
    expect(markdown).toContain(`Expected: \`${SHA_A}\``);
    expect(markdown).toContain(`Observed: \`${SHA_B}\``);
    expect(markdown).toContain('| GitHub → Vercel | FAIL |');
  });

  it('marks uncovered checks UNVERIFIED instead of pretending VERIFIED', () => {
    const markdown = buildTruthSummaryMarkdown(makeReport({ omitDeployment: true }));
    expect(markdown).toContain('| GitHub → Vercel | UNVERIFIED |');
  });

  it('omits evidence blocks when findings carry none', () => {
    const finding = {
      code: 'TEST_FINDING',
      title: 'A finding without expected/observed',
      description: 'Nothing to show.',
      severity: 'WARNING' as const,
      status: 'WARN' as const,
      evidence: {},
      affectedComponents: [{ type: 'deployment' as const, environment: 'production' }],
      remediation: 'Do nothing.',
    };
    const markdown = buildTruthSummaryMarkdown(
      makeReport({ findings: [finding], verdict: 'WARN' }),
    );
    expect(markdown).toContain('TEST_FINDING');
    expect(markdown).not.toContain('Expected:');
    expect(markdown).not.toContain('Observed:');
  });

  it('bounds long finding lists', () => {
    const findings = Array.from({ length: 30 }, (_, index) => ({
      code: `FINDING_${String(index).padStart(2, '0')}`,
      title: `Finding number ${index}`,
      description: 'Generated finding.',
      severity: 'WARNING' as const,
      status: 'WARN' as const,
      evidence: {},
      affectedComponents: [{ type: 'deployment' as const, environment: 'production' }],
      remediation: 'Fix it.',
    }));
    const markdown = buildTruthSummaryMarkdown(makeReport({ findings, verdict: 'FAIL' }));
    expect(markdown).toContain('FINDING_19');
    expect(markdown).not.toContain('FINDING_20');
    expect(markdown).toContain('and 10 more findings');
  });

  it('escapes Markdown-hostile text in tables, headings, and findings', () => {
    const hostile = {
      code: 'HOSTILE|CODE',
      title: 'Breaks | tables *and* <script>alert(1)</script> `code`',
      description: 'Line one\n::warning:: injected command attempt\nLine two',
      severity: 'HIGH' as const,
      status: 'FAIL' as const,
      expected: 'value|with|pipes',
      observed: '<img src=x>',
      evidence: {},
      affectedComponents: [{ type: 'deployment' as const, environment: 'production' }],
      remediation: 'Use [links](https://evil.invalid) carefully',
    };
    const markdown = buildTruthSummaryMarkdown(makeReport({ findings: [hostile] }));
    expect(markdown).not.toContain('<script>');
    expect(markdown).toContain('&lt;script&gt;');
    expect(markdown).toContain('`HOSTILE|CODE`');
    expect(markdown).toContain('`value|with|pipes`');
    expect(markdown).toContain('`<img src=x>`');
    // Newlines are flattened so untrusted text can never start a "::" command line.
    expect(markdown).not.toMatch(/\n::/);
    expect(markdown).toContain('Line one ::warning:: injected command attempt Line two');
  });
});

describe('ci artifact bundle', () => {
  it('contains exactly the three expected files with valid schemas', async () => {
    const harness = createHarness({ report: warnReport() });
    await runAction(harness.deps);
    const directory = harness.fake.outputs.get('artifact-directory') ?? '';
    const { entries, reportJson, summary, metadataJson } = readBundle(directory);
    expect(entries).toEqual(
      [
        CI_BUNDLE_FILENAMES.metadata,
        CI_BUNDLE_FILENAMES.summary,
        CI_BUNDLE_FILENAMES.report,
      ].sort(),
    );
    expect(parseStoredReport(reportJson).status).toBe('ok');
    expect(() => ciMetadataSchema.parse(JSON.parse(metadataJson))).not.toThrow();
    expect(summary).toContain('**WARN**');
  });

  it('lives under the trusted runner temp root, never the workspace', async () => {
    const harness = createHarness({ report: passReport() });
    await runAction(harness.deps);
    const directory = harness.fake.outputs.get('artifact-directory') ?? '';
    expect(directory.startsWith(harness.tempRoot)).toBe(true);
    expect(directory.startsWith(harness.workspace)).toBe(false);
  });

  it('stores the same normalized serialization the CLI and history use', async () => {
    const report = failReport();
    const harness = createHarness({ report });
    await runAction(harness.deps);
    const { reportJson } = readBundle(harness.fake.outputs.get('artifact-directory') ?? '');
    expect(reportJson).toBe(serializeTruthReport(report));
  });

  it('contains no secret material or raw provider markers anywhere', async () => {
    const harness = createHarness({ report: warnReport() });
    const outcome = await runAction(harness.deps);
    expect(outcome.status).toBe('success');
    const directory = harness.fake.outputs.get('artifact-directory') ?? '';
    const corpus = [
      ...readdirSync(directory).map((name) => readFileSync(join(directory, name), 'utf8')),
      ...[...harness.fake.outputs.values()],
      ...harness.fake.info,
      ...harness.fake.warnings,
      ...harness.fake.failures,
      ...harness.fake.summaries,
    ].join('\n');
    for (const sentinel of SENTINELS) {
      expect(corpus).not.toContain(sentinel);
    }
    expect(corpus).not.toContain('rawOnlySentinel');
    expect(corpus).not.toContain('Authorization');
  });
});

describe('ci metadata', () => {
  it('contains only allowlisted provenance fields', async () => {
    const harness = createHarness({ report: passReport() });
    await runAction(harness.deps);
    const { metadataJson } = readBundle(harness.fake.outputs.get('artifact-directory') ?? '');
    const metadata = ciMetadataSchema.parse(JSON.parse(metadataJson));
    expect(Object.keys(metadata).sort()).toEqual(
      [
        'schemaVersion',
        'provider',
        'repository',
        'workflow',
        'job',
        'githubRunId',
        'githubRunAttempt',
        'githubRunNumber',
        'eventName',
        'gitSha',
        'gitRef',
        'environment',
        'truthRunId',
        'verdict',
        'generatedAt',
      ].sort(),
    );
    expect(metadata.provider).toBe('github-actions');
    expect(metadata.environment).toBe('production');
    expect(metadata.verdict).toBe('PASS');
  });

  it('drops malformed GitHub context instead of trusting it', async () => {
    const harness = createHarness({
      report: passReport(),
      env: {
        GITHUB_REPOSITORY: 'not-a-repo-shape',
        GITHUB_RUN_ID: 'abc\n::error::injected',
        GITHUB_SHA: 'not-a-sha',
        GITHUB_REF: 'main',
      },
    });
    await runAction(harness.deps);
    const { metadataJson } = readBundle(harness.fake.outputs.get('artifact-directory') ?? '');
    const metadata = ciMetadataSchema.parse(JSON.parse(metadataJson));
    expect(metadata.repository).toBeUndefined();
    expect(metadata.githubRunId).toBeUndefined();
    expect(metadata.gitSha).toBeUndefined();
    expect(metadata.gitRef).toBeUndefined();
    expect(metadataJson).not.toContain('::error::');
  });
});

describe('trusted event security', () => {
  it('refuses pull_request_target before any provider access', async () => {
    const harness = createHarness({
      report: passReport(),
      env: { GITHUB_EVENT_NAME: 'pull_request_target' },
    });
    const outcome = await runAction(harness.deps);
    expect(outcome.status).toBe('failed');
    expect(harness.calls.count).toBe(0);
    expect(harness.fake.failures.join('\n')).toContain('pull_request_target');
    expect(harness.fake.outputs.has('verdict')).toBe(false);
  });

  it('does not touch tracked workspace files', async () => {
    const workspace = initRepo(tempDir('dt-action-git-'));
    const harness = createHarness({ report: passReport(), workspace });
    const outcome = await runAction(harness.deps);
    expect(outcome.status).toBe('success');
    const status = git(['status', '--porcelain'], workspace);
    expect(
      status
        .split('\n')
        .filter(Boolean)
        .every((line) => line.includes('.deploytruth')),
    ).toBe(true);
  });

  it('writes exactly one local history run, matching deploytruth check', async () => {
    const harness = createHarness({ report: passReport() });
    await runAction(harness.deps);
    const store = createReportHistoryStore(harness.workspace);
    const runs = await store.list('fixture-app', 'production');
    expect(runs.filter((entry) => entry.status === 'ok')).toHaveLength(1);
    expect(runs[0]?.runId).toBe(FIXED_RUN_ID);
  });

  it('fails closed when GITHUB_WORKSPACE is missing', async () => {
    const harness = createHarness({ report: passReport(), env: { GITHUB_WORKSPACE: undefined } });
    const outcome = await runAction(harness.deps);
    expect(outcome.status).toBe('failed');
    expect(harness.calls.count).toBe(0);
  });
});
