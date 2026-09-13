import { fileURLToPath } from 'node:url';

import { defineConfig } from 'tsup';

const source = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

/**
 * The distributable Action is a single self-contained ESM file: external consumers never run
 * pnpm install. Workspace packages are aliased to their TypeScript sources so the bundle always
 * contains the same engine code that `pnpm test` certifies — never a stale dist. npm runtime
 * dependencies are inlined; only optional native driver shims stay external (the adapters
 * already degrade safely when they are absent).
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  dts: false,
  clean: true,
  minify: false,
  sourcemap: false,
  // CJS dependencies inside the bundle call require() on Node builtins; provide a real
  // createRequire binding so the ESM output works on the Actions Node runtime.
  banner: {
    js: "import { createRequire as __deploytruthCreateRequire } from 'node:module'; const require = __deploytruthCreateRequire(import.meta.url);",
  },
  noExternal: [/./],
  external: ['pg-native', 'pg-cloudflare'],
  esbuildOptions(options) {
    options.alias = {
      '@deploytruth/cli/check': source('../cli/src/check.ts'),
      '@deploytruth/core': source('../core/src/index.ts'),
      '@deploytruth/config': source('../config/src/index.ts'),
      '@deploytruth/providers': source('../providers/src/index.ts'),
      '@deploytruth/reporter': source('../reporter/src/index.ts'),
    };
  },
});
