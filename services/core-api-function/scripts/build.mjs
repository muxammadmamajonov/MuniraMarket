// Bundles the Function entry (esbuild, ESM, Node 24) into dist/index.mjs (git-ignored). This is
// what `neon deploy` ships (`bundler: 'none'` in /neon.ts): the shared Telegram modules import
// `BotApiError` from the bare specifier `sdk`, which only this build aliases to the stand-in.
// `--dev` also bundles scripts/dev-server.ts (the local gateway stand-in) the same way.
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { build } from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  logLevel: 'info',
  alias: { sdk: fileURLToPath(new URL('../src/scheduler/telegramSdk.ts', import.meta.url)) },
  // pg's optional native binding is never installed.
  external: ['pg-native'],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
};

await build({ ...shared, entryPoints: ['src/index.ts'], outfile: 'dist/index.mjs' });
if (process.argv.includes('--dev')) {
  await build({
    ...shared,
    entryPoints: ['scripts/dev-server.ts'],
    outfile: 'dist/dev-server.mjs',
  });
}
