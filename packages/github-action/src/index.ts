import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

import * as core from '@actions/core';
import { runEnvironmentCheck } from '@deploytruth/cli/check';
import { writeLocalReport } from '@deploytruth/reporter';

import { runAction, type ActionIO } from './action.js';

/**
 * The distributable Action entry. All truth evaluation lives in the certified
 * `runEnvironmentCheck` orchestration; this wrapper only adapts CI IO (inputs, Job Summary,
 * outputs, artifact bundle, fail policy) — it never re-interprets findings.
 */

// Real runners pre-create step file-command targets; local harnesses may not. Open in append
// mode so an existing file is never truncated.
const ensureWritableFile = (envVar: 'GITHUB_STEP_SUMMARY' | 'GITHUB_OUTPUT'): void => {
  const filePath = process.env[envVar];
  if (filePath === undefined || filePath.length === 0 || existsSync(filePath)) {
    return;
  }
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    closeSync(openSync(filePath, 'a'));
  } catch {
    // The toolkit reports the file-access failure; nothing to hide here.
  }
};

ensureWritableFile('GITHUB_STEP_SUMMARY');
ensureWritableFile('GITHUB_OUTPUT');

const io: ActionIO = {
  info: (message) => core.info(message),
  warning: (message) => core.warning(message),
  setOutput: (name, value) => core.setOutput(name, value),
  writeSummary: async (markdown) => {
    core.summary.addRaw(markdown);
    await core.summary.write();
  },
  fail: (message) => core.setFailed(message),
};

await runAction({
  inputs: {
    environment: core.getInput('environment'),
    config: core.getInput('config'),
    failOn: core.getInput('fail-on'),
  },
  env: process.env,
  runCheck: runEnvironmentCheck,
  persistReport: writeLocalReport,
  io,
});
