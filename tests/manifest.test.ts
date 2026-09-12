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

  it.each(['foo', 'github.com/foo/bar', 'https://github.com/foo/bar', 'foo/bar/baz'])(
    'rejects malformed repository declaration %s',
    (repository) => {
      expect(() =>
        parseDeployTruthManifest(`
version: 1
project: example
environments:
  production:
    kind: production
    source:
      provider: github
      repository: ${repository}
      branch: main
`),
      ).toThrow(ConfigError);
    },
  );

  it.each(['owner/repo', 'org-123/app.v2_final', 'a/b'])(
    'accepts owner/repo declaration %s',
    (repository) => {
      const manifest = parseDeployTruthManifest(`
version: 1
project: example
environments:
  production:
    kind: production
    source:
      provider: github
      repository: ${repository}
      branch: main
`);

      expect(manifest.environments.production?.source?.repository).toBe(repository);
    },
  );

  it.each(['../etc', 'a//b', 'white space', 'trailing/'])(
    'rejects unsafe branch name %s',
    (branch) => {
      expect(() =>
        parseDeployTruthManifest(`
version: 1
project: example
environments:
  production:
    kind: production
    source:
      provider: github
      repository: acme/example
      branch: "${branch}"
`),
      ).toThrow(ConfigError);
    },
  );

  it('accepts a Vercel production deployment declaration with scope and domain', () => {
    const manifest = parseDeployTruthManifest(`
version: 1
project: example
environments:
  production:
    kind: production
    deployment:
      provider: vercel
      project: example-app
      target: production
      scope: kaizora
      domain: app.example.com
`);

    const deployment = manifest.environments.production?.deployment;
    expect(deployment?.project).toBe('example-app');
    expect(deployment?.target).toBe('production');
    expect(deployment?.scope).toBe('kaizora');
    expect(deployment?.domain).toBe('app.example.com');
  });

  it('defaults the deployment target to production when omitted', () => {
    const manifest = parseDeployTruthManifest(`
version: 1
project: example
environments:
  production:
    kind: production
    deployment: { provider: vercel, project: example-app }
`);

    expect(manifest.environments.production?.deployment?.target).toBe('production');
  });

  it('rejects non-production deployment targets in M3', () => {
    expect(() =>
      parseDeployTruthManifest(`
version: 1
project: example
environments:
  preview:
    kind: preview
    deployment:
      provider: vercel
      project: example-app
      target: preview
`),
    ).toThrow(ConfigError);
  });

  it.each(['https://app.example.com', 'app.example.com/x', 'white space'])(
    'rejects non-hostname deployment domain %s',
    (domain) => {
      expect(() =>
        parseDeployTruthManifest(`
version: 1
project: example
environments:
  production:
    kind: production
    deployment:
      provider: vercel
      project: example-app
      domain: "${domain}"
`),
      ).toThrow(ConfigError);
    },
  );

  it('rejects malformed Vercel project identifiers', () => {
    expect(() =>
      parseDeployTruthManifest(`
version: 1
project: example
environments:
  production:
    kind: production
    deployment:
      provider: vercel
      project: "bad project/name"
`),
    ).toThrow(ConfigError);
  });
});
