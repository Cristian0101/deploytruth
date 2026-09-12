import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  projectDeclarationSchema,
  projectObservationSchema,
  type TruthContext,
} from '@deploytruth/core';

interface RawScenario {
  readonly declaration: unknown;
  readonly observations: unknown;
  readonly generatedAt: unknown;
  readonly strict?: unknown;
}

const isRawScenario = (value: unknown): value is RawScenario =>
  typeof value === 'object' && value !== null && 'declaration' in value && 'observations' in value;

const scenariosDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'scenarios',
);

export const loadScenario = (name: string): TruthContext => {
  const filePath = join(scenariosDirectory, `${name}.json`);
  const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!isRawScenario(parsed) || typeof parsed.generatedAt !== 'string') {
    throw new Error(`Scenario ${name} is malformed.`);
  }
  if (parsed.strict !== undefined && typeof parsed.strict !== 'boolean') {
    throw new Error(`Scenario ${name} has a non-boolean strict setting.`);
  }

  return {
    declaration: projectDeclarationSchema.parse(parsed.declaration),
    observations: projectObservationSchema.parse(parsed.observations),
    generatedAt: parsed.generatedAt,
    ...(typeof parsed.strict === 'boolean' ? { strict: parsed.strict } : {}),
  };
};
