// ESLint — REPORT-ONLY for now.
//
// This repo shipped with no ESLint at all: no config file and no dependency in
// any package. `npm run lint` is scripts/check-log-safety.js plus
// `tsc --noEmit`, which means all 201 `eslint-disable` comments in the tree
// were inert — they suppressed rules from a linter that was never installed.
//
// Turning a linter on across a codebase this size produces a finding count
// nobody can triage in one pass, so this config is deliberately NOT wired into
// `npm run lint`. It runs as `npm run lint:eslint` and as a
// continue-on-error CI step. The counts it produces are the input for deciding
// which rules can become blocking — see
// docs/quality/engineering-baseline-2026-07-25.md.
//
// Scope discipline: correctness rules only. No stylistic rules — formatting
// disagreements would bury the signal that matters (unawaited promises,
// impossible conditions, misused async).
//
// Unused-disable-directive reporting is left ON (the ESLint default) on
// purpose. It is noisy — 181 of the 201 pre-existing suppressions report
// something — but that noise IS the cleanup inventory: 76 reference
// `import/*` rules from eslint-plugin-import, which this repo never had
// installed, and 105 suppress rules that report nothing. Both must be deleted,
// not carried forward. Do not silence this without deleting the directives.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/** Correctness rules that need no type information. */
const untypedCorrectness = {
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-fallthrough': 'error',
  'no-promise-executor-return': 'error',
  'no-unreachable': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-self-compare': 'error',
  'no-template-curly-in-string': 'error',
  'require-atomic-updates': 'error',
  'valid-typeof': 'error',
  'use-isnan': 'error',
  // tsc already reports these, and its messages are better.
  'no-unused-vars': 'off',
  'no-undef': 'off',
  'no-redeclare': 'off',
  'no-dupe-class-members': 'off',
};

/**
 * Rules that require the TypeScript type checker. These are the high-value
 * ones: an unawaited promise in a money or audit path is a real defect that
 * `tsc --noEmit` does not catch.
 */
const typedCorrectness = {
  '@typescript-eslint/await-thenable': 'error',
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
  '@typescript-eslint/no-for-in-array': 'error',
  '@typescript-eslint/no-array-delete': 'error',
  '@typescript-eslint/no-unsafe-unary-minus': 'error',
  '@typescript-eslint/only-throw-error': 'error',
  '@typescript-eslint/no-unnecessary-condition': 'warn',
  '@typescript-eslint/require-await': 'warn',
  '@typescript-eslint/return-await': ['warn', 'in-try-catch'],
};

/**
 * Rules from `recommendedTypeChecked` that fire in the hundreds or thousands
 * on an existing codebase without indicating defects. Off so the report stays
 * readable; revisit individually once the correctness rules are at zero.
 */
const deferredNoise = {
  '@typescript-eslint/no-explicit-any': 'off',
  '@typescript-eslint/no-unused-vars': 'off',
  '@typescript-eslint/no-empty-object-type': 'off',
  '@typescript-eslint/no-empty-function': 'off',
  '@typescript-eslint/no-unsafe-assignment': 'off',
  '@typescript-eslint/no-unsafe-member-access': 'off',
  '@typescript-eslint/no-unsafe-call': 'off',
  '@typescript-eslint/no-unsafe-return': 'off',
  '@typescript-eslint/no-unsafe-argument': 'off',
  '@typescript-eslint/no-unnecessary-type-assertion': 'off',
  '@typescript-eslint/no-redundant-type-constituents': 'off',
  '@typescript-eslint/no-duplicate-type-constituents': 'off',
  '@typescript-eslint/restrict-template-expressions': 'off',
  '@typescript-eslint/restrict-plus-operands': 'off',
  '@typescript-eslint/no-base-to-string': 'off',
  '@typescript-eslint/unbound-method': 'off',
  '@typescript-eslint/require-typeof-check': 'off',
};

export default tseslint.config(
  {
    // Not source. The corpus/report fixtures in particular are generated.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.expo/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'docs/**',
      'data/**',
      '**/*.d.ts',
    ],
  },

  // Plain JavaScript. Kept separate from TypeScript because the default
  // espree parser cannot read TS syntax — pointing the baseline at both
  // extensions is what produced 1,604 spurious "Parsing error" fatals on the
  // first run of this config.
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2023 },
    },
    rules: untypedCorrectness,
  },

  // Every TypeScript file gets the TS parser and the syntax-only rules. This
  // covers e2e/, scripts/, .github/scripts/, packages/*/test/, and mobile —
  // none of which are inside the type-aware globs below.
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [tseslint.configs.base, js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2023 },
    },
    rules: untypedCorrectness,
  },

  // Type-aware pass over the shipping source. `projectService` resolves the
  // nearest tsconfig per file, which is what lets three packages with
  // different configs share one block.
  {
    files: ['packages/{api,web,shared}/src/**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: { ...untypedCorrectness, ...typedCorrectness, ...deferredNoise },
  },

  // React: hooks rules catch real render-correctness bugs (conditional hooks,
  // stale closures in dependency arrays).
  {
    files: ['packages/{web,mobile}/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // Tests. A floating promise in a test is usually a missing await on an
  // assertion, which passes silently — but tests are not type-aware linted
  // here, so that rule is not active. Relax the rules that fire on
  // deliberate test shapes.
  {
    files: [
      '**/test/**/*.{ts,tsx}',
      '**/*.{test,spec}.{ts,tsx}',
      'e2e/**/*.ts',
      '**/__mocks__/**/*.ts',
    ],
    rules: {
      'no-constant-condition': 'off',
      'require-atomic-updates': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // Standalone tsx/node entrypoints. Console output is their interface.
  {
    files: [
      'scripts/**/*.{ts,js,mjs}',
      '.github/scripts/**/*.ts',
      'qa-runner/**/*.mjs',
      'loadtest/**/*.ts',
      'e2e/fixtures/**/*.ts',
    ],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
