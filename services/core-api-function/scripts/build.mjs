// Bundles the Function entry exactly as `neon deploy` does (esbuild, ESM, Node 24) to prove it
// builds without the Python/Docker toolchain. Output: dist/index.mjs (git-ignored).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  logLevel: 'info',
  // pg's optional native binding is never installed.
  external: ['pg-native'],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
