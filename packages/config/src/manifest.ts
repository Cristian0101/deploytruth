import { readFile } from 'node:fs/promises';

import {
  checksSchema,
  environmentKindSchema,
  projectDeclarationSchema,
  type ProjectDeclaration,
} from '@deploytruth/core';
import { parseDocument } from 'yaml';
import { z } from 'zod';

const providerSchema = z.enum(['github', 'vercel', 'supabase']);

/**
 * GitHub identity is declared as a single `owner/repo` string. URLs, extra path segments, and
 * bare names are rejected so the declaration is unambiguous (the GitHub adapter enforces the
 * same grammar).
 */
export const GITHUB_REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

/** A safe Git branch-name subset: blocks `..`, `//`, and trailing `/` or `.`. */
export const GIT_BRANCH_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,254})$/;

/**
 * A Vercel project name or id (`prj_...`). Names are lowercase alphanumeric with `.`, `_`, and
 * `-`; ids carry a `prj_` prefix. The grammar is a safe URL-path segment either way.
 */
export const VERCEL_PROJECT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;

/** A Vercel team slug or `team_...` id; a single optional scope field covers both. */
export const VERCEL_SCOPE_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,127})$/;

/** A bare hostname (no scheme, port, or path), normalized to lowercase before validation. */
export const HOSTNAME_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const sourceInputSchema = z
  .object({
    provider: z.literal('github'),
    repository: z
      .string()
      .regex(
        GITHUB_REPOSITORY_PATTERN,
        'repository must be in owner/repo form (for example acme/meridia)',
      ),
    branch: z
      .string()
      .regex(
        GIT_BRANCH_PATTERN,
        'branch may only contain letters, digits, and . _ / - and must start with an alphanumeric',
      )
      .refine(
        (value) =>
          !value.includes('..') &&
          !value.includes('//') &&
          !value.includes('@{') &&
          !value.endsWith('/') &&
          !value.endsWith('.'),
        { message: 'branch must be a valid Git ref name' },
      ),
  })
  .strict();

const deploymentInputSchema = z
  .object({
    provider: z.literal('vercel'),
    project: z
      .string()
      .regex(
        VERCEL_PROJECT_PATTERN,
        'project must be a Vercel project name or id (letters, digits, . _ -)',
      ),
    // Only the production target is supported in M3; preview targets arrive in a later milestone.
    target: z.literal('production').default('production'),
    scope: z
      .string()
      .regex(
        VERCEL_SCOPE_PATTERN,
        'scope must be a Vercel team slug or team_... id (letters, digits, _ -)',
      )
      .optional(),
    domain: z
      .string()
      .toLowerCase()
      .regex(HOSTNAME_PATTERN, 'domain must be a bare hostname (for example app.example.com)')
      .optional(),
  })
  .strict();

const databaseInputSchema = z
  .object({
    provider: z.literal('supabase'),
    project_ref: z.string().min(1),
    migrations: z
      .object({
        directory: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

const runtimeInputSchema = z
  .object({
    url: z.string().url(),
    expected_environment: z.string().min(1).optional(),
  })
  .strict();

const environmentInputSchema = z
  .object({
    kind: environmentKindSchema.optional(),
    source: sourceInputSchema.optional(),
    deployment: deploymentInputSchema.optional(),
    database: databaseInputSchema.optional(),
    runtime: runtimeInputSchema.optional(),
    required_environment_variables: z.array(z.string().min(1)).default([]),
    checks: checksSchema.default({}),
  })
  .strict();

export const manifestInputSchema = z
  .object({
    version: z.literal(1),
    project: z.string().min(1),
    environments: z
      .record(environmentInputSchema)
      .refine((environments) => Object.keys(environments).length > 0, {
        message: 'At least one environment is required.',
      }),
  })
  .strict();

export type ManifestInput = z.infer<typeof manifestInputSchema>;

export class ConfigError extends Error {
  public constructor(
    message: string,
    public readonly details: readonly string[] = [],
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

const inferEnvironmentKind = (environmentId: string): z.infer<typeof environmentKindSchema> => {
  if (environmentId === 'production') {
    return 'production';
  }
  if (environmentId === 'preview') {
    return 'preview';
  }
  if (environmentId === 'staging') {
    return 'staging';
  }
  if (environmentId === 'development') {
    return 'development';
  }
  return 'custom';
};

const formatIssues = (issues: readonly z.ZodIssue[]): readonly string[] =>
  issues.map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`);

const normalizeManifest = (manifest: ManifestInput): ProjectDeclaration => {
  const environments = Object.fromEntries(
    Object.entries(manifest.environments).map(([environmentId, environment]) => [
      environmentId,
      {
        id: environmentId,
        kind: environment.kind ?? inferEnvironmentKind(environmentId),
        ...(environment.source
          ? {
              source: {
                provider: environment.source.provider,
                repository: environment.source.repository,
                branch: environment.source.branch,
              },
            }
          : {}),
        ...(environment.deployment
          ? {
              deployment: {
                provider: environment.deployment.provider,
                project: environment.deployment.project,
                target: environment.deployment.target,
                ...(environment.deployment.scope ? { scope: environment.deployment.scope } : {}),
                ...(environment.deployment.domain ? { domain: environment.deployment.domain } : {}),
              },
            }
          : {}),
        ...(environment.database
          ? {
              database: {
                provider: environment.database.provider,
                projectRef: environment.database.project_ref,
                ...(environment.database.migrations
                  ? { migrationDirectory: environment.database.migrations.directory }
                  : {}),
              },
            }
          : {}),
        ...(environment.runtime
          ? {
              runtime: {
                url: environment.runtime.url,
                ...(environment.runtime.expected_environment
                  ? { expectedEnvironment: environment.runtime.expected_environment }
                  : {}),
              },
            }
          : {}),
        requiredEnvironmentVariables: environment.required_environment_variables,
        checks: environment.checks,
      },
    ]),
  );

  return projectDeclarationSchema.parse({
    version: manifest.version,
    project: manifest.project,
    environments,
  });
};

/** Parses a deploytruth.yml document without performing any network access. */
export const parseDeployTruthManifest = (contents: string): ProjectDeclaration => {
  const document = parseDocument(contents, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new ConfigError(
      'deploytruth.yml contains invalid YAML.',
      document.errors.map((error) => error.message),
    );
  }

  const parsed = manifestInputSchema.safeParse(document.toJS());
  if (!parsed.success) {
    throw new ConfigError(
      'deploytruth.yml does not match the v1 manifest schema.',
      formatIssues(parsed.error.issues),
    );
  }

  return normalizeManifest(parsed.data);
};

export const loadDeployTruthManifest = async (filePath: string): Promise<ProjectDeclaration> => {
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown filesystem error';
    throw new ConfigError(`Unable to read manifest at ${filePath}.`, [message]);
  }
  return parseDeployTruthManifest(contents);
};

export const supportedManifestProviders = providerSchema.options;
