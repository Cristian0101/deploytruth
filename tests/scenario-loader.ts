import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

export const loadScenario = (name: string): TruthContext => {
  const filePath = resolve(process.cwd(), 'fixtures', 'scenarios', `${name}.json`);
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
