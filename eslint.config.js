// ESLint flat config (ESLint 9). TypeScript files are checked with the
// recommended type-aware-free ruleset; the plain .mjs scripts and the classic
// worker files use the browser/node globals they actually run with.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

// Empty catch blocks are deliberate throughout (best-effort storage/cleanup);
// `allowEmptyCatch` keeps them legal without weakening other empty checks.
const allowEmptyCatch = { 'no-empty': ['error', { allowEmptyCatch: true }] };
const unusedVars = [
  'warn',
  { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
];

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'public/wasm/', 'smoke-results/', 'data/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.worker },
    },
    rules: {
      ...allowEmptyCatch,
      // The base rule mis-reports names in type-only positions (interface
      // signatures, `declare global`); the TS-aware rule is the right one here.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': unusedVars,
    },
  },
  {
    files: ['src/**/*.test.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // The Node harness scripts drive a browser, so they legitimately reference
    // `document`/`window` inside page.evaluate callbacks; allow both global sets.
    files: ['scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      ...allowEmptyCatch,
      'no-unused-vars': unusedVars,
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    // The inference worker and the no-dev-server hint run in a classic worker /
    // page context; `ort` is the global installed by importScripts.
    files: ['public/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.worker,
        importScripts: 'readonly',
        ort: 'readonly',
      },
    },
    rules: {
      ...allowEmptyCatch,
      'no-unused-vars': unusedVars,
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
