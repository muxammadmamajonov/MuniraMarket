#!/usr/bin/env node
/**
 * Fails the Workers build of an app unless its server bundle actually uses the CORE_API service
 * binding (the Vite plugin in ../vinext.mts swapped `src/lib/api/upstream-fetch.ts`). Without
 * the swap the deployed Worker would try to fetch the placeholder API host and every API call
 * would fail. Run from the app directory after `vite build`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const bundle = '.cloudflare/output/v0/workers/default/bundle';

function* jsFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* jsFiles(path);
    else if (name.endsWith('.js')) yield path;
  }
}

const uses = [...jsFiles(bundle)].some((file) => readFileSync(file, 'utf8').includes('CORE_API'));
if (!uses) {
  console.error(`${process.cwd()}: the Workers bundle does not use the CORE_API binding`);
  process.exit(1);
}
console.log('CORE_API binding is wired into the Workers bundle');
