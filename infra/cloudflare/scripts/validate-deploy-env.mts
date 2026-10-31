#!/usr/bin/env node
// Usage: node infra/cloudflare/scripts/validate-deploy-env.mts --mode staging|production
// Reads the deploy-time variables from the process environment; prints only variable names.
import { validateDeployEnv } from '../deploy-env.mts';

const index = process.argv.indexOf('--mode');
const mode = index === -1 ? undefined : process.argv[index + 1];
if (mode !== 'staging' && mode !== 'production') {
  console.error('usage: validate-deploy-env.mts --mode staging|production');
  process.exit(2);
}
const problems = validateDeployEnv(mode, process.env);
for (const problem of problems) console.error(`${problem.variable} ${problem.message}`);
if (problems.length > 0) {
  console.error(`${problems.length} problem(s); fix them before deploying ${mode}.`);
  process.exit(1);
}
console.log(`deploy environment for ${mode} looks complete`);
