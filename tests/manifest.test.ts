import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ConfigError, parseDeployTruthManifest } from '@deploytruth/config';
import { describe, expect, it } from 'vitest';

describe('deploytruth.yml schema', () => {
  it('validates the documented example without secrets', () => {
    const contents = readFileSync(resolve(process.cwd(), 'deploytruth.example.yml'), 'utf8');
    const manifest = parseDeployTruthManifest(contents);

    expect(manifest.project).toBe('meridia');
    expect(manifest.environments.production?.database?.projectRef).toBe('prodabc123');
    expect(manifest.environments.preview?.kind).toBe('preview');
  });

  it('rejects unknown keys instead of silently accepting misspelled declarations', () => {
    expect(() =>
      parseDeployTruthManifest(`
version: 1
project: example
environments:
  production:
    kind: production
    sourc:
      provider: github
      repository: acme/example
      branch: main
`),
    ).toThrow(ConfigError);
  });
});
