import { fileURLToPath } from 'node:url';

import { defineConfig } from 'tsup';

const source = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

/**
 * The published `deploytruth` package is a single self-contained ESM file: `npm install` /
 * `npx` consumers never see a workspace dependency. Workspace packages are aliased to their
 * TypeScript sources so the bundle always contains the same engine code that `pnpm test`
 * certifies — never a stale dist. npm runtime dependencies are inlined; only optional native
 * driver shims stay external (the adapters already degrade safely when they are absent).
 */
export default defineConfig({
  // src/bin.ts is the executable entry; it is emitted as dist/index.js, the npm `bin` target.
  entry: { index: 'src/bin.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: false,
  clean: true,
  minify: false,
  sourcemap: false,
  // CJS dependencies inside the bundle call require() on Node builtins; provide a real
  // createRequire binding so the ESM output works when installed as a global bin.
  banner: {
    js: "import { createRequire as __deploytruthCreateRequire } from 'node:module'; const require = __deploytruthCreateRequire(import.meta.url);",
  },
  noExternal: [/./],
  external: ['pg-native', 'pg-cloudflare'],
  esbuildOptions(options) {
    options.alias = {
      '@deploytruth/config': source('../config/src/index.ts'),
      '@deploytruth/core': source('../core/src/index.ts'),
      '@deploytruth/providers': source('../providers/src/index.ts'),
      '@deploytruth/reporter': source('../reporter/src/index.ts'),
    };
  },
});
