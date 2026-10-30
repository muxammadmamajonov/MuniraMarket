import js from '@eslint/js';
import globals from 'globals';

// Runtime constraints of Telegram Serverless: code under tgcloud/ sees only `sdk*` and other
// project modules (relative imports ending in .js). No npm packages, no Node built-ins.
const ALLOWED_IMPORT = '^(sdk(/(db|api|fetch))?|\\.{1,2}/.*\\.js)$';

export default [
  { ignores: ['node_modules/**', 'coverage/**', '.tgcloud/**'] },
  js.configs.recommended,
  {
    files: ['tgcloud/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      // Only `console` is documented as a runtime global besides the ES built-ins. The timer and
      // abort globals are used strictly behind `typeof` guards (see coreApi/client.js).
      globals: {
        console: 'readonly',
        AbortController: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: `^(?!${ALLOWED_IMPORT.slice(1, -1)}$)`,
              message:
                'tgcloud/ may import only "sdk", "sdk/db", "sdk/api", "sdk/fetch" and relative ".js" modules.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...[
          'Buffer',
          'process',
          'require',
          'module',
          '__dirname',
          'TextEncoder',
          'TextDecoder',
          'URL',
          'URLSearchParams',
          'atob',
          'btoa',
        ].map((name) => ({
          name,
          message: `${name} is not documented for the Serverless runtime.`,
        })),
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='require']",
          message: 'CommonJS is not available; use ESM imports.',
        },
        {
          selector: 'ImportExpression',
          message: 'Dynamic import is not documented for the Serverless runtime.',
        },
      ],
    },
  },
  {
    files: ['*.js', 'test/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: globals.node },
  },
];
