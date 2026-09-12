import { fingerprintSecret, redactText, sanitizeForReport, evaluateTruth } from '@deploytruth/core';
import { serializeTruthReport } from '@deploytruth/reporter';
import { describe, expect, it } from 'vitest';

import { loadScenario } from './scenario-loader.js';

describe('secret redaction', () => {
  const githubToken = 'ghp_1234567890abcdefghijklmnopqrstuvwxyz';
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature';
  const serviceRole = 'super-sensitive-service-role-value';

  it('redacts known inline token forms and credentials', () => {
    const source = `SUPABASE_SERVICE_ROLE_KEY=${serviceRole} Authorization: Bearer ${githubToken} ${jwt} https://user:password@example.com`;
    const redacted = redactText(source);

    expect(redacted).not.toContain(serviceRole);
    expect(redacted).not.toContain(githubToken);
    expect(redacted).not.toContain(jwt);
    expect(redacted).not.toContain('password@example.com');
  });

  it('redacts sensitive object keys recursively while preserving fingerprints', () => {
    const sanitized = sanitizeForReport({
      SUPABASE_SERVICE_ROLE_KEY: serviceRole,
      nested: { apiToken: githubToken },
      fingerprint: fingerprintSecret(serviceRole),
      present: true,
    });
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain(serviceRole);
    expect(serialized).not.toContain(githubToken);
    expect(serialized).toContain(fingerprintSecret(serviceRole));
    expect(serialized).toContain('"present":true');
  });

  it('redacts credential-bearing database URLs and Supabase tokens from report text', () => {
    const databaseUrl =
      'postgresql://postgres:database-password-123@db.prodabc123.supabase.co:5432/postgres';
    const base = evaluateTruth(loadScenario('healthy-production'));
    const report = {
      ...base,
      metadata: {
        ...base.metadata,
        rawDatabaseUrl: databaseUrl,
        supabaseAccessToken: 'sbp_1234567890abcdef1234567890abcdef',
      },
    };
    const serialized = serializeTruthReport(report);

    expect(serialized).not.toContain('database-password-123');
    expect(serialized).not.toContain('sbp_1234567890abcdef1234567890abcdef');
    expect(serialized).not.toContain('postgres:database');
    expect(() => JSON.parse(serialized)).not.toThrow();
  });

  it('cannot leak common secret formats through serialized reports', () => {
    const healthyReport = evaluateTruth(loadScenario('healthy-production'));
    const report = {
      ...healthyReport,
      metadata: {
        ...healthyReport.metadata,
        rawProviderMessage: `Authorization: Bearer ${githubToken}`,
        VERCEL_TOKEN: 'vercel_1234567890abcdefghijk',
        nested: { serviceRole: serviceRole, jwt },
      },
    };
    const serialized = serializeTruthReport(report);

    for (const forbidden of [githubToken, 'vercel_1234567890abcdefghijk', serviceRole, jwt]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(() => JSON.parse(serialized)).not.toThrow();
  });
});
