import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { formatCheckReport, runEnvironmentCheck } from '../packages/cli/src/check.js';
import { cleanupTempDirs, tempDir } from './git-test-utils.js';
import { TEST_RUNTIME_SHA, createFixtureRuntimeProvider } from './runtime-test-utils.js';
import { createFixtureVercelProvider } from './vercel-test-utils.js';

const manifestAt = (directory: string): string => {
  const path = join(directory, 'deploytruth.yml');
  writeFileSync(
    path,
    `version: 1
project: example
environments:
  acceptance:
    kind: custom
    deployment: { provider: vercel, project: example, target: production }
    runtime:
      url: https://runtime.example.test/api/deploytruth/runtime
      expected_environment: acceptance
    required_environment_variables: [SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY]
    checks:
      deployment_sha: false
      runtime_identity: true
      environment_isolation: true
      environment_variables: true
`,
  );
  return path;
};

afterEach(cleanupTempDirs);

describe('deploytruth check runtime truth', () => {
  it('observes runtime evidence, satisfies coverage, and renders the runtime section', async () => {
    const execution = await runEnvironmentCheck({
      configPath: manifestAt(tempDir('dt-runtime-cli-')),
      environmentName: 'acceptance',
      vercelProvider: createFixtureVercelProvider({
        project: 'example',
        sourceSha: TEST_RUNTIME_SHA,
      }),
      runtimeProvider: createFixtureRuntimeProvider(),
    });

    expect(execution.report.verdict).toBe('PASS');
    expect(execution.report.findings).toEqual([]);
    const output = formatCheckReport(execution);
    expect(output).toContain('RUNTIME');
    expect(output).toContain('Freshness');
    expect(output).toContain('VERIFIED');
    expect(output).toContain('2 / 2 present');
  });

  it('keeps a wrong nonce at WARN without comparing stale identity', async () => {
    const execution = await runEnvironmentCheck({
      configPath: manifestAt(tempDir('dt-runtime-cli-nonce-')),
      environmentName: 'acceptance',
      vercelProvider: createFixtureVercelProvider({
        project: 'example',
        sourceSha: TEST_RUNTIME_SHA,
      }),
      runtimeProvider: createFixtureRuntimeProvider({
        wrongNonce: true,
        bodyOverrides: { commit: 'b'.repeat(40) },
      }),
    });
    const codes = execution.report.findings.map((finding) => finding.code);
    expect(codes).toContain('RUNTIME_ATTESTATION_FRESHNESS_UNVERIFIED');
    expect(codes).not.toContain('RUNTIME_SHA_MISMATCH');
    expect(execution.report.verdict).toBe('WARN');
  });

  it('fails a fresh runtime SHA mismatch', async () => {
    const execution = await runEnvironmentCheck({
      configPath: manifestAt(tempDir('dt-runtime-cli-sha-')),
      environmentName: 'acceptance',
      vercelProvider: createFixtureVercelProvider({
        project: 'example',
        sourceSha: TEST_RUNTIME_SHA,
      }),
      runtimeProvider: createFixtureRuntimeProvider({
        bodyOverrides: { commit: 'b'.repeat(40) },
      }),
    });
    expect(execution.report.findings.map((finding) => finding.code)).toContain(
      'RUNTIME_SHA_MISMATCH',
    );
    expect(execution.report.verdict).toBe('FAIL');
  });
});
