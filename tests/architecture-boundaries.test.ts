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

  it('keeps verdict evaluation out of the report viewer', () => {
    const viewer = read('apps/web/src/report-viewer.tsx');

    expect(viewer).not.toContain('evaluateTruth');
    expect(viewer).not.toContain('aggregateVerdict');
  });
});
