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

  it('keeps runtime attestation transport and probing GET-only with no environment dump', () => {
    const provider = [
      read('packages/providers/src/runtime/transport.ts'),
      read('packages/providers/src/runtime/adapter.ts'),
    ].join('\n');
    const endpoint = read('examples/live-acceptance/api/deploytruth/runtime.js');

    expect(provider).not.toMatch(/method:\s*['"`](POST|PUT|PATCH|DELETE)['"`]/i);
    expect(endpoint).not.toMatch(/method:\s*['"`](POST|PUT|PATCH|DELETE)['"`]/i);
    expect(endpoint).toContain("method: 'GET'");
    expect(endpoint).not.toMatch(/Object\.entries\(process\.env\)|JSON\.stringify\(process\.env\)/);
    expect(endpoint).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
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

  it('keeps the Supabase runtime read-only and free of credential material at the boundary', () => {
    const supabase = [
      read('packages/providers/src/supabase/transport.ts'),
      read('packages/providers/src/supabase/adapter.ts'),
      read('packages/providers/src/supabase/credentials.ts'),
      read('packages/providers/src/supabase/identity.ts'),
    ].join('\n');

    // No mutation verbs may exist anywhere in the Supabase runtime path.
    expect(supabase).not.toMatch(/\bpost\b|\bput\b|\bpatch\b|\bdelete\b/i);
    expect(supabase).not.toMatch(/method:\s*['"`](POST|PUT|PATCH|DELETE)['"`]/i);
    // No credential-bearing connection strings may be embedded in source.
    expect(supabase).not.toMatch(/:\/\/[^/'\s"]*:[^/@'\s"]+@/);
  });

  it('confines the PostgreSQL reader to allowlisted read-only statements', () => {
    const reader = read('packages/providers/src/supabase/database-reader.ts');

    // The only SQL the reader may issue: an explicit READ ONLY transaction, a connectivity
    // probe, the migration-history SELECT, and ROLLBACK. No write-capable statement may
    // appear anywhere in the file — even inside dead code or comments.
    expect(reader).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|UPSERT|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|MERGE|CALL|EXECUTE)\b/,
    );
    expect(reader).toContain('START TRANSACTION READ ONLY');
    expect(reader).toContain('ROLLBACK');
    expect(reader).toContain('SELECT version FROM supabase_migrations.schema_migrations');
    // The reader exposes facts, not a query surface.
    expect(reader).not.toContain('query(text: string, params');
    expect(reader).toContain('inspectIdentity');
    expect(reader).toContain('readMigrationHistory');
  });

  it('keeps verified TLS as the only PostgreSQL runtime posture', () => {
    const reader = read('packages/providers/src/supabase/database-reader.ts');

    // DeployTruth fails closed: no runtime path may weaken or disable certificate
    // verification, and no insecure fallback may exist.
    expect(reader).not.toMatch(/rejectUnauthorized\s*:\s*false/);
    expect(reader).toContain('rejectUnauthorized: true');
    expect(reader).not.toMatch(/checkServerIdentity\s*[:=]/);
  });

  it('keeps raw Supabase concerns out of core', () => {
    const source = [
      read('packages/core/src/domain.ts'),
      read('packages/core/src/rules.ts'),
      read('packages/core/src/report.ts'),
      read('packages/core/src/topology.ts'),
    ].join('\n');

    expect(source).not.toMatch(/api\.supabase\.com|schema_migrations|postgresql:|Bearer/i);
    // Variable names in remediation text are safe; token-shaped values are not.
    expect(source).not.toMatch(/sbp_[A-Za-z0-9]{8,}/);
  });

  it('keeps verdict evaluation out of the report viewer', () => {
    const viewer = read('apps/web/src/report-viewer.tsx');

    expect(viewer).not.toContain('evaluateTruth');
    expect(viewer).not.toContain('aggregateVerdict');
  });
});
