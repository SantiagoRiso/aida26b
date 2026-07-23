import tseslint from 'typescript-eslint';
import vuePlugin from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';
import globals from 'globals';

const noUnknownRule = [
  'error',
  {
    selector: 'TSUnknownKeyword',
    message:
      'unknown is banned app-wide; use exact SSOT types. Only permitted at genuine external/error boundaries with an eslint-disable-next-line + reason.',
  },
];

const suppressionHygiene = {
  rules: {
    scoped: {
      meta: { type: 'problem', schema: [] },
      create(context) {
        return {
          Program() {
            for (const comment of context.sourceCode.getAllComments()) {
              const directive = comment.value.trim();
              if (/^eslint-disable(?:\s|$)/u.test(directive)) {
                context.report({ loc: comment.loc, message: 'Use eslint-disable-next-line; file-wide disables are forbidden.' });
              }
              if (/^eslint-disable-(?:next-)?line\b/u.test(directive) && !directive.includes(' -- ')) {
                context.report({ loc: comment.loc, message: 'Lint suppressions require a reason after " -- ".' });
              }
            }
          },
        };
      },
    },
  },
};

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.planning/**',
      'docs/**',
      '**/*.config.*',
      '**/*.d.ts',
      '**/.lancedb/**',
      '**/scratch/**',
      // Generated reporter output — not source, and its vendored JS trips the suppression rules.
      '**/coverage/**',
      '**/coverage-db/**',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },
  {
    files: [
      'frontend/src/**/*.ts',
      'frontend/test/**/*.ts',
      'frontend/e2e/**/*.ts',
      'backend/src/**/*.ts',
      'backend/test/**/*.ts',
      'shared/src/**/*.ts',
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      suppressions: suppressionHygiene,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-syntax': noUnknownRule,
      'suppressions/scoped': 'error',
    },
  },
  {
    files: ['frontend/src/**/*.vue', 'frontend/test/**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        sourceType: 'module',
        extraFileExtensions: ['.vue'],
      },
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      vue: vuePlugin,
      '@typescript-eslint': tseslint.plugin,
      suppressions: suppressionHygiene,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-syntax': noUnknownRule,
      'suppressions/scoped': 'error',
    },
  },
];
