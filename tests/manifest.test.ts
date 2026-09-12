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

  it.each(['prodabc123', 'abcdefghij1234567890ab', 'x'.repeat(64)])(
    'accepts a valid Supabase project_ref %s',
    (ref) => {
      const manifest = parseDeployTruthManifest(`
version: 1
project: example
environments:
  production:
    kind: production
    database:
      provider: supabase
      project_ref: ${ref}
`);

      expect(manifest.environments.production?.database?.projectRef).toBe(ref);
    },
  );

  it.each([
    ['prod-ref', 'contains a hyphen'],
    ['PRODABC123', 'contains uppercase'],
    ['has space', 'contains a space'],
    ['with_underscore', 'contains an underscore'],
    ['', 'is empty'],
    ['x'.repeat(65), 'is too long'],
  ])('rejects a Supabase project_ref that %s', (ref) => {
    expect(() =>
      parseDeployTruthManifest(`
version: 1
project: example
environments:
  production:
    kind: production
    database:
      provider: supabase
      project_ref: "${ref}"
`),
    ).toThrow(ConfigError);
  });

  it('rejects a database provider that is not supabase in M4', () => {
    expect(() =>
      parseDeployTruthManifest(`
version: 1
project: example
environments:
  production:
    kind: production
    database:
      provider: planetscale
      project_ref: abc123
`),
    ).toThrow(ConfigError);
  });

  it('defaults the migration directory to supabase/migrations', () => {
    const manifest = parseDeployTruthManifest(`
version: 1
project: example
environments:
  production:
    kind: production
    database:
      provider: supabase
      project_ref: prodabc123
`);

    expect(manifest.environments.production?.database?.migrationDirectory).toBe(
      'supabase/migrations',
    );
  });

  it.each(['db/migrations', 'supabase/migrations', 'a/b/c.d_e-f'])(
    'accepts a repository-relative migration directory %s',
    (directory) => {
      const manifest = parseDeployTruthManifest(`
version: 1
project: example
environments:
  production:
    kind: production
    database:
      provider: supabase
      project_ref: prodabc123
      migrations:
        directory: "${directory}"
`);

      expect(manifest.environments.production?.database?.migrationDirectory).toBe(directory);
    },
  );

  it.each([
    ['../outside', 'path traversal'],
    ['/absolute/path', 'absolute path'],
    ['a/../b', 'embedded traversal'],
    ['a//b', 'empty segment'],
    ['dir with space', 'whitespace'],
    ['trailing/', 'trailing slash'],
    ['./relative', 'leading dot segment'],
    ['C:/windows', 'drive-style path'],
  ])('rejects a migration directory with %s', (directory) => {
    expect(() =>
      parseDeployTruthManifest(`
version: 1
project: example
environments:
  production:
    kind: production
    database:
      provider: supabase
      project_ref: prodabc123
      migrations:
        directory: "${directory}"
`),
    ).toThrow(ConfigError);
  });
});
