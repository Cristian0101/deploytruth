import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), relativePath), 'utf8');

describe('architectural boundaries', () => {
  it('keeps provider SDK and UI imports out of core', () => {
    const source = [
      read('packages/core/src/domain.ts'),
      read('packages/core/src/rules.ts'),
      read('packages/core/src/report.ts'),
      read('packages/core/src/topology.ts'),
    ].join('\n');

    expect(source).not.toMatch(/@vercel|@supabase|apps\/web|react/i);
  });

  it('makes mutation impossible through the provider transport contract', () => {
    const contract = read('packages/providers/src/contracts.ts');

    expect(contract).toContain('readonly get:');
    expect(contract).not.toMatch(/\bpost\b|\bput\b|\bpatch\b|\bdelete\b/i);
  });

  it('keeps the GitHub runtime read-only and free of credential material at the boundary', () => {
    const github = [
      read('packages/providers/src/github/transport.ts'),
      read('packages/providers/src/github/adapter.ts'),
      read('packages/providers/src/github/credentials.ts'),
    ].join('\n');

    // No mutation verbs may exist anywhere in the GitHub runtime path.
    expect(github).not.toMatch(/\bpost\b|\bput\b|\bpatch\b|\bdelete\b/i);
    expect(github).not.toMatch(/method:\s*['"`](POST|PUT|PATCH|DELETE)['"`]/i);
  });

  it('keeps the Vercel runtime read-only and free of credential material at the boundary', () => {
    const vercel = [
      read('packages/providers/src/vercel/transport.ts'),
      read('packages/providers/src/vercel/adapter.ts'),
      read('packages/providers/src/vercel/credentials.ts'),
      read('packages/providers/src/readonly-fetch.ts'),
    ].join('\n');

    // No mutation verbs may exist anywhere in the Vercel runtime path.
    expect(vercel).not.toMatch(/\bpost\b|\bput\b|\bpatch\b|\bdelete\b/i);
    expect(vercel).not.toMatch(/method:\s*['"`](POST|PUT|PATCH|DELETE)['"`]/i);
  });

  it('keeps raw Vercel API concerns out of core', () => {
    const source = [
      read('packages/core/src/domain.ts'),
      read('packages/core/src/rules.ts'),
      read('packages/core/src/report.ts'),
      read('packages/core/src/topology.ts'),
    ].join('\n');

    // Variable names in remediation text are safe; credential-shaped values are not. The token
    // check is intentionally case-sensitive so VERCEL_* rule codes do not trip it.
    expect(source).not.toMatch(/api\.vercel\.com|Authorization|Bearer/i);
    expect(source).not.toMatch(/vercel_[A-Za-z0-9_-]{8,}/);
  });

  it('keeps raw GitHub API concerns out of core', () => {
    const source = [
      read('packages/core/src/domain.ts'),
      read('packages/core/src/rules.ts'),
      read('packages/core/src/report.ts'),
      read('packages/core/src/topology.ts'),
    ].join('\n');

    expect(source).not.toMatch(/api\.github\.com|octokit|Authorization|Bearer/i);
  });

  it('keeps verdict evaluation out of the report viewer', () => {
    const viewer = read('apps/web/src/report-viewer.tsx');

    expect(viewer).not.toContain('evaluateTruth');
    expect(viewer).not.toContain('aggregateVerdict');
  });
});
