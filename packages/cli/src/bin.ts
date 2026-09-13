#!/usr/bin/env node

import { createCli } from './index.js';

/**
 * The published executable entry. This file is bundled to dist/index.js — the npm `bin` target —
 * so it always runs the CLI. Library imports of `./index.js` (tests, the GitHub Action adapter)
 * stay side-effect free.
 */
await createCli().parseAsync(process.argv);
