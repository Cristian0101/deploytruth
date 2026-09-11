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

const sourceInputSchema = z
  .object({
    provider: z.literal('github'),
    repository: z.string().min(3),
    branch: z.string().min(1),
  })
  .strict();

const deploymentInputSchema = z
  .object({
    provider: z.literal('vercel'),
    project: z.string().min(1),
    stable_domain: z.string().url().optional(),
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
                ...(environment.deployment.stable_domain
                  ? { stableDomain: environment.deployment.stable_domain }
                  : {}),
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
