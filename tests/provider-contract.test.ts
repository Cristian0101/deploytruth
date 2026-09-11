import { createFixtureProvider } from '@deploytruth/providers';
import { describe, expect, it } from 'vitest';

describe('provider contract', () => {
  it('supports deterministic normalized fixture observations without a transport or live credentials', async () => {
    const provider = createFixtureProvider({
      id: 'fixture-github',
      capabilities: ['source'] as const,
      validateConfig: (value: unknown) => ({ repository: String(value) }),
      observationFor: () => ({
        provider: 'github',
        repository: 'acme/meridia',
        branch: 'main',
        remoteHeadSha: 'abc123',
        workingTree: 'unknown' as const,
      }),
    });

    const config = provider.validateConfig('acme/meridia');
    const observation = await provider.observe({
      project: 'meridia',
      environment: 'production',
      config,
    });

    expect(provider.capabilities).toEqual(['source']);
    expect(observation).toMatchObject({ provider: 'github', remoteHeadSha: 'abc123' });
  });
});
