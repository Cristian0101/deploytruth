import {
  deploymentObservationSchema,
  evaluateTruth,
  sourceObservationSchema,
  type DeploymentObservation,
  type SourceObservation,
  type TruthContext,
} from '@deploytruth/core';
import { serializeTruthReport } from '@deploytruth/reporter';
import { describe, expect, it } from 'vitest';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const declaration = {
  version: 1,
  project: 'meridia',
  environments: {
    production: {
      id: 'production',
      kind: 'production',
      source: { provider: 'github', repository: 'acme/meridia', branch: 'main' },
      deployment: { provider: 'vercel', project: 'meridia', target: 'production' },
      requiredEnvironmentVariables: [],
      checks: { local_git: true, remote_source: true, deployment_sha: true },
    },
  },
} as const;

const gitSource = (overrides: Partial<SourceObservation> = {}): SourceObservation =>
  sourceObservationSchema.parse({
    provider: 'git',
    branch: 'main',
    headSha: SHA_A,
    workingTree: 'clean',
    upstream: { remote: 'origin', branch: 'main', ref: 'refs/remotes/origin/main', sha: SHA_A },
    aheadBy: 0,
    behindBy: 0,
    ...overrides,
  });

const gitHubSource = (overrides: Partial<SourceObservation> = {}): SourceObservation =>
  sourceObservationSchema.parse({
    provider: 'github',
    repository: 'acme/meridia',
    branch: 'main',
    remoteHeadSha: SHA_A,
    defaultBranch: 'main',
    availability: { state: 'available' },
    ...overrides,
  });

const vercelDeployment = (
  overrides: Readonly<Record<string, unknown>> = {},
): DeploymentObservation =>
  deploymentObservationSchema.parse({
    provider: 'vercel',
    availability: { state: 'available' },
    project: 'meridia',
    target: 'production',
    environment: 'production',
    deploymentId: 'dpl_prod_1',
    deploymentUrl: 'https://meridia-abc.vercel.app',
    state: 'ready',
    commitSha: SHA_A,
    sourceBranch: 'main',
    createdAt: '2026-09-11T18:00:00Z',
    ...overrides,
  });

interface Observations {
  readonly source?: SourceObservation;
  readonly remoteSource?: SourceObservation;
  readonly deployment?: DeploymentObservation;
}

const context = (
  observations: Observations,
  checks: Readonly<Record<string, boolean>> = {},
  declaredDeployment: Readonly<Record<string, unknown>> = {},
): TruthContext => ({
  declaration: {
    ...declaration,
    environments: {
      production: {
        ...declaration.environments.production,
        deployment: {
          ...declaration.environments.production.deployment,
          ...declaredDeployment,
        },
        checks: { ...declaration.environments.production.checks, ...checks },
      },
    },
  },
  observations: {
    project: 'meridia',
    environments: {
      production: {
        environment: 'production',
        ...(observations.source !== undefined ? { source: observations.source } : {}),
        ...(observations.remoteSource !== undefined
          ? { remoteSource: observations.remoteSource }
          : {}),
        ...(observations.deployment !== undefined ? { deployment: observations.deployment } : {}),
      },
    },
  },
  generatedAt: '2026-09-11T00:00:00Z',
});

const codes = (report: ReturnType<typeof evaluateTruth>): readonly string[] =>
  report.findings.map((finding) => finding.code);

describe('Vercel deployment truth rules', () => {
  it('PASSes with no deployment findings when GitHub and Vercel production agree', () => {
    const report = evaluateTruth(
      context({
        source: gitSource(),
        remoteSource: gitHubSource(),
        deployment: vercelDeployment(),
      }),
    );

    expect(report.findings).toEqual([]);
    expect(report.verdict).toBe('PASS');
  });

  it('DEPLOYMENT_SHA_MISMATCH fails when Vercel production was built from another commit', () => {
    const report = evaluateTruth(
      context({
        source: gitSource(),
        remoteSource: gitHubSource({ remoteHeadSha: SHA_A }),
        deployment: vercelDeployment({ commitSha: SHA_B }),
      }),
    );
    const finding = report.findings.find((entry) => entry.code === 'DEPLOYMENT_SHA_MISMATCH');

    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('HIGH');
    expect(finding?.status).toBe('FAIL');
    expect(finding?.expected).toBe(SHA_A);
    expect(finding?.observed).toBe(SHA_B);
    expect(report.verdict).toBe('FAIL');
  });

  it('still reports DEPLOYMENT_SHA_MISMATCH for an intentional-looking rollback', () => {
    // Production serves an older commit than the declared branch head; declaration wins.
    const report = evaluateTruth(
      context({
        source: gitSource(),
        remoteSource: gitHubSource({ remoteHeadSha: SHA_B }),
        deployment: vercelDeployment({ commitSha: SHA_A, deploymentId: 'dpl_rolled_back' }),
      }),
    );
    const finding = report.findings.find((entry) => entry.code === 'DEPLOYMENT_SHA_MISMATCH');

    expect(finding).toBeDefined();
    expect(finding?.evidence['deploymentId']).toBe('dpl_rolled_back');
    expect(report.verdict).toBe('FAIL');
  });

  it('cannot PASS when GitHub is unavailable even if local HEAD matches the deployment', () => {
    const report = evaluateTruth(
      context({
        source: gitSource(),
        remoteSource: gitHubSource({
          remoteHeadSha: undefined,
          defaultBranch: undefined,
          availability: {
            state: 'unavailable',
            target: 'repository',
            reason: 'rate_limited',
            detail: 'GitHub API rate limit exceeded.',
          },
        }),
        deployment: vercelDeployment({ commitSha: SHA_A }),
      }),
    );

    expect(codes(report)).toContain('GITHUB_REPOSITORY_UNAVAILABLE');
    expect(codes(report)).toContain('REQUIRED_OBSERVATION_UNAVAILABLE');
    expect(report.verdict).toBe('WARN');
    expect(report.verdict).not.toBe('PASS');
  });

  it('cannot PASS when Vercel is unavailable while GitHub is healthy', () => {
    const report = evaluateTruth(
      context({
        source: gitSource(),
        remoteSource: gitHubSource(),
        deployment: vercelDeployment({
          availability: {
            state: 'unavailable',
            target: 'project',
            reason: 'missing_credentials',
            detail: 'No Vercel token is configured.',
          },
          deploymentId: undefined,
          commitSha: undefined,
          state: undefined,
        }),
      }),
    );

    expect(codes(report)).toContain('VERCEL_PROJECT_UNAVAILABLE');
    expect(codes(report)).toContain('REQUIRED_OBSERVATION_UNAVAILABLE');
    expect(report.verdict).toBe('WARN');
    expect(report.verdict).not.toBe('PASS');
  });

  it('VERCEL_PRODUCTION_DEPLOYMENT_UNAVAILABLE when production cannot be resolved', () => {
    const report = evaluateTruth(
      context({
        source: gitSource(),
        remoteSource: gitHubSource(),
        deployment: vercelDeployment({
          availability: {
            state: 'unavailable',
            target: 'deployment',
            reason: 'deployment_unavailable',
            detail: 'No production domain is assigned to a deployment.',
          },
          deploymentId: undefined,
          commitSha: undefined,
          state: undefined,
        }),
      }),
    );

    expect(codes(report)).toContain('VERCEL_PRODUCTION_DEPLOYMENT_UNAVAILABLE');
    expect(codes(report)).not.toContain('VERCEL_PROJECT_UNAVAILABLE');
    expect(report.verdict).toBe('WARN');
  });

  it('DEPLOYMENT_SOURCE_UNVERIFIED warns when the deployment carries no source commit', () => {
    const report = evaluateTruth(
      context({
        source: gitSource(),
        remoteSource: gitHubSource(),
        deployment: vercelDeployment({ commitSha: undefined, sourceBranch: undefined }),
      }),
    );
    const finding = report.findings.find((entry) => entry.code === 'DEPLOYMENT_SOURCE_UNVERIFIED');

    expect(finding?.severity).toBe('WARNING');
    expect(codes(report)).toContain('REQUIRED_OBSERVATION_UNAVAILABLE');
    expect(report.verdict).toBe('WARN');
    expect(report.verdict).not.toBe('PASS');
  });

  it.each([
    ['building', 'DEPLOYMENT_NOT_READY', 'WARN'],
    ['queued', 'DEPLOYMENT_NOT_READY', 'WARN'],
    ['unknown', 'DEPLOYMENT_NOT_READY', 'WARN'],
    ['error', 'DEPLOYMENT_FAILED', 'FAIL'],
    ['canceled', 'DEPLOYMENT_FAILED', 'FAIL'],
  ] as const)('state %s produces %s with status %s', (state, expectedCode, expectedStatus) => {
    const report = evaluateTruth(
      context({
        source: gitSource(),
        remoteSource: gitHubSource(),
        deployment: vercelDeployment({ state }),
      }),
    );
    const finding = report.findings.find((entry) => entry.code === expectedCode);

    expect(finding).toBeDefined();
    expect(finding?.status).toBe(expectedStatus);
  });

  it('does not fire DEPLOYMENT_NOT_READY for a ready deployment', () => {
    const report = evaluateTruth(
      context({
        source: gitSource(),
        remoteSource: gitHubSource(),
        deployment: vercelDeployment({ state: 'ready' }),
      }),
    );

    expect(codes(report)).not.toContain('DEPLOYMENT_NOT_READY');
    expect(codes(report)).not.toContain('DEPLOYMENT_FAILED');
  });

  it('STABLE_DOMAIN_STALE fails when the declared domain resolves to another deployment', () => {
    const report = evaluateTruth(
      context(
        {
          source: gitSource(),
          remoteSource: gitHubSource(),
          deployment: vercelDeployment({
            stableDomain: 'app.example.com',
            stableDomainVerified: false,
          }),
        },
        {},
        { domain: 'app.example.com' },
      ),
    );
    const finding = report.findings.find((entry) => entry.code === 'STABLE_DOMAIN_STALE');

    expect(finding?.severity).toBe('HIGH');
    expect(finding?.status).toBe('FAIL');
    expect(report.verdict).toBe('FAIL');
  });

  it('STABLE_DOMAIN_STALE warns when domain verification is inconclusive', () => {
    const report = evaluateTruth(
      context(
        {
          source: gitSource(),
          remoteSource: gitHubSource(),
          deployment: vercelDeployment({ stableDomain: 'app.example.com' }),
        },
        {},
        { domain: 'app.example.com' },
      ),
    );
    const finding = report.findings.find((entry) => entry.code === 'STABLE_DOMAIN_STALE');

    expect(finding?.severity).toBe('WARNING');
    expect(finding?.status).toBe('WARN');
    expect(report.verdict).toBe('WARN');
  });

  it('does not evaluate the stable domain rule when no domain is declared', () => {
    const report = evaluateTruth(
      context({
        source: gitSource(),
        remoteSource: gitHubSource(),
        deployment: vercelDeployment(),
      }),
    );

    expect(codes(report)).not.toContain('STABLE_DOMAIN_STALE');
  });

  it('verified stable domain adds no finding', () => {
    const report = evaluateTruth(
      context(
        {
          source: gitSource(),
          remoteSource: gitHubSource(),
          deployment: vercelDeployment({
            stableDomain: 'app.example.com',
            stableDomainVerified: true,
          }),
        },
        {},
        { domain: 'app.example.com' },
      ),
    );

    expect(codes(report)).not.toContain('STABLE_DOMAIN_STALE');
    expect(report.verdict).toBe('PASS');
  });

  it('an explicit deployment_sha opt-out silences deployment findings and coverage', () => {
    const report = evaluateTruth(
      context(
        {
          source: gitSource(),
          remoteSource: gitHubSource(),
          deployment: vercelDeployment({ commitSha: SHA_B }),
        },
        { deployment_sha: false },
      ),
    );

    expect(codes(report)).not.toContain('DEPLOYMENT_SHA_MISMATCH');
    expect(codes(report)).not.toContain('REQUIRED_OBSERVATION_UNAVAILABLE');
    expect(report.verdict).toBe('PASS');
  });

  it('a deployment-only environment can never false-PASS on missing source evidence', () => {
    const input = context({ deployment: vercelDeployment() });
    delete input.declaration.environments.production.source;

    const report = evaluateTruth(input);

    expect(codes(report)).toContain('REQUIRED_OBSERVATION_UNAVAILABLE');
    expect(report.verdict).toBe('WARN');
    expect(report.verdict).not.toBe('PASS');
  });

  it('serializes Vercel findings without credential-shaped material', () => {
    const report = evaluateTruth(
      context({
        source: gitSource(),
        remoteSource: gitHubSource(),
        deployment: vercelDeployment({
          availability: {
            state: 'unavailable',
            target: 'project',
            reason: 'unauthorized',
            detail: 'Vercel rejected the configured credentials (HTTP 401).',
          },
          deploymentId: undefined,
          commitSha: undefined,
          state: undefined,
        }),
      }),
    );
    const serialized = serializeTruthReport(report);

    expect(serialized).not.toContain('vercel_');
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).toContain('VERCEL_PROJECT_UNAVAILABLE');
  });
});
