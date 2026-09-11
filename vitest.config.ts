import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pathFromRoot = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@deploytruth/core': pathFromRoot('./packages/core/src/index.ts'),
      '@deploytruth/config': pathFromRoot('./packages/config/src/index.ts'),
      '@deploytruth/providers': pathFromRoot('./packages/providers/src/index.ts'),
      '@deploytruth/reporter': pathFromRoot('./packages/reporter/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    environment: 'node',
    clearMocks: true,
  },
});
