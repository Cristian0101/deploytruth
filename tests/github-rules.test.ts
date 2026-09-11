import {
  evaluateTruth,
  sourceObservationSchema,
  type SourceObservation,
  type TruthContext,
} from '@deploytruth/core';
import { serializeTruthReport } from '@deploytruth/reporter';
import { describe, expect, it } from 'vitest';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

const declaration = {
  version: 1,
  project: 'meridia',
  environments: {
    production: {
      id: 'production',
      kind: 'production',
      source: { provider: 'github', repository: 'acme/meridia', branch: 'main' },
      requiredEnvironmentVariables: [],
      checks: { local_git: true, remote_source: true },
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

const context = (
  source?: SourceObservation,
  remoteSource?: SourceObservation,
  checks: Readonly<Record<string, boolean>> = {},
): TruthContext => ({
  declaration: {
    ...declaration,
    environments: {
      production: {
        ...declaration.environments.production,
        checks: { ...declaration.environments.production.checks, ...checks },
      },
    },
  },
  observations: {
    project: 'meridia',
    environments: {
      production: {
        environment: 'production',
        ...(source !== undefined ? { source } : {}),
        ...(remoteSource !== undefined ? { remoteSource } : {}),
      },
    },
  },
  generatedAt: '2026-09-11T00:00:00Z',
});

describe('GitHub authoritative source rules', () => {
  it('produces no findings and PASSes when local and GitHub truth agree', () => {
    const report = evaluateTruth(context(gitSource(), gitHubSource()));

    expect(report.findings).toEqual([]);
    expect(report.verdict).toBe('PASS');
  });

  it('STALE_TRACKING_REF fires when the local tracking ref differs from the GitHub head', () => {
    const report = evaluateTruth(context(gitSource(), gitHubSource({ remoteHeadSha: SHA_B })));
    const finding = report.findings.find((entry) => entry.code === 'STALE_TRACKING_REF');

    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('WARNING');
    expect(finding?.status).toBe('WARN');
    expect(finding?.expected).toBe(SHA_B);
    expect(finding?.observed).toBe(SHA_A);
    expect(finding?.evidence['trackingRef']).toBe('refs/remotes/origin/main');
  });

  it('never compares a tracking ref for a different branch against the remote head', () => {
    const local = gitSource({
      branch: 'feature/x',
      headSha: SHA_C,
      upstream: {
        remote: 'origin',
        branch: 'feature/x',
        ref: 'refs/remotes/origin/feature/x',
        sha: SHA_C,
      },
    });
    const remote = gitHubSource({ remoteHeadSha: SHA_B });
    const report = evaluateTruth(context(local, remote));

    const codesFound = report.findings.map((finding) => finding.code);
    expect(codesFound).not.toContain('STALE_TRACKING_REF');
    // A feature branch differing from GitHub main is informational, not a warning.
    const head = report.findings.find((entry) => entry.code === 'LOCAL_HEAD_DIFFERS_FROM_GITHUB');
    expect(head?.severity).toBe('INFO');
  });

  it('LOCAL_HEAD_DIFFERS_FROM_GITHUB warns when on the declared branch and HEAD differs', () => {
    const local = gitSource({
      headSha: SHA_C,
      upstream: {
        remote: 'origin',
        branch: 'main',
        ref: 'refs/remotes/origin/main',
        sha: SHA_B,
      },
    });
    const remote = gitHubSource({ remoteHeadSha: SHA_B });
    const report = evaluateTruth(context(local, remote));

    const finding = report.findings.find(
      (entry) => entry.code === 'LOCAL_HEAD_DIFFERS_FROM_GITHUB',
    );
    expect(finding?.severity).toBe('WARNING');
    // Tracking ref agrees with GitHub, so only the HEAD difference is reported.
    expect(report.findings.map((entry) => entry.code)).not.toContain('STALE_TRACKING_REF');
  });

  it('reports no remote comparison findings when no local upstream exists', () => {
    const local = gitSource({ upstream: undefined, aheadBy: undefined, behindBy: undefined });
    const remote = gitHubSource({ remoteHeadSha: SHA_A });
    const report = evaluateTruth(context(local, remote));

    const codesFound = report.findings.map((finding) => finding.code);
    expect(codesFound).not.toContain('STALE_TRACKING_REF');
    expect(codesFound).not.toContain('LOCAL_HEAD_DIFFERS_FROM_GITHUB');
    // The pre-existing local rule still explains that drift is unverifiable locally.
    expect(codesFound).toContain('NO_UPSTREAM_CONFIGURED');
  });

  it('DECLARED_BRANCH_DIFFERS_FROM_GITHUB_DEFAULT is informational only', () => {
    const remote = gitHubSource({ defaultBranch: 'main' });
    const contextInput = context(gitSource(), remote);
    contextInput.declaration.environments.production = {
      ...contextInput.declaration.environments.production,
      source: { provider: 'github', repository: 'acme/meridia', branch: 'release' },
    };
    const report = evaluateTruth(contextInput);

    const finding = report.findings.find(
      (entry) => entry.code === 'DECLARED_BRANCH_DIFFERS_FROM_GITHUB_DEFAULT',
    );
    expect(finding?.severity).toBe('INFO');
    expect(finding?.status).toBe('WARN');
    expect(report.verdict).toBe('WARN');
  });

  it('GITHUB_REPOSITORY_UNAVAILABLE prevents a false PASS', () => {
    const remote = gitHubSource({
      remoteHeadSha: undefined,
      defaultBranch: undefined,
      availability: {
        state: 'unavailable',
        target: 'repository',
        reason: 'rate_limited',
        detail: 'GitHub API rate limit exceeded.',
        rateLimit: { limit: 60, remaining: 0, resetAt: '2026-09-11T14:00:00Z' },
      },
    });
    const report = evaluateTruth(context(gitSource(), remote));

    const codesFound = report.findings.map((finding) => finding.code);
    expect(codesFound).toContain('GITHUB_REPOSITORY_UNAVAILABLE');
    expect(codesFound).toContain('REQUIRED_OBSERVATION_UNAVAILABLE');
    expect(report.verdict).toBe('WARN');
    expect(report.verdict).not.toBe('PASS');
  });

  it('GITHUB_BRANCH_UNAVAILABLE distinguishes branch evidence from repository absence', () => {
    const remote = gitHubSource({
      remoteHeadSha: undefined,
      availability: {
        state: 'unavailable',
        target: 'branch',
        reason: 'not_found',
        detail: 'GitHub returned not found for the declared branch.',
      },
    });
    const report = evaluateTruth(context(gitSource(), remote));

    const codesFound = report.findings.map((finding) => finding.code);
    expect(codesFound).toContain('GITHUB_BRANCH_UNAVAILABLE');
    expect(codesFound).not.toContain('GITHUB_REPOSITORY_UNAVAILABLE');
  });

  it('missing GitHub evidence alone blocks PASS through coverage', () => {
    const report = evaluateTruth(context(gitSource()));

    const codesFound = report.findings.map((finding) => finding.code);
    expect(codesFound).toContain('REQUIRED_OBSERVATION_UNAVAILABLE');
    expect(codesFound).not.toContain('GITHUB_REPOSITORY_UNAVAILABLE');
    expect(report.verdict).toBe('WARN');
  });

  it('an explicit remote_source opt-out silences GitHub findings and coverage', () => {
    const remote = gitHubSource({
      remoteHeadSha: undefined,
      availability: {
        state: 'unavailable',
        target: 'repository',
        reason: 'network_error',
        detail: 'The GitHub API could not be reached.',
      },
    });
    const report = evaluateTruth(context(gitSource(), remote, { remote_source: false }));

    const codesFound = report.findings.map((finding) => finding.code);
    expect(codesFound).not.toContain('GITHUB_REPOSITORY_UNAVAILABLE');
    expect(codesFound).not.toContain('REQUIRED_OBSERVATION_UNAVAILABLE');
  });

  it('uses the authoritative remote SHA as deployment truth evidence', () => {
    const report = evaluateTruth(context(gitSource(), gitHubSource({ remoteHeadSha: SHA_B })));
    const node = report.topology.nodes.find((entry) => entry.type === 'source');

    expect(node?.metadata['sha']).toBe(SHA_B);
  });

  it('serializes GitHub findings without any credential-shaped material', () => {
    const remote = gitHubSource({
      remoteHeadSha: undefined,
      availability: {
        state: 'unavailable',
        target: 'repository',
        reason: 'unauthorized',
        detail: 'GitHub rejected the configured credentials (HTTP 401).',
      },
    });
    const report = evaluateTruth(context(gitSource(), remote));
    const serialized = serializeTruthReport(report);

    expect(serialized).not.toContain('ghp_');
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).toContain('GITHUB_REPOSITORY_UNAVAILABLE');
  });
});
