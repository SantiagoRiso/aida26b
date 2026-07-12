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
    ],
  },
  {
    files: [
      'frontend/src/**/*.ts',
      'frontend/test/**/*.ts',
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
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-syntax': noUnknownRule,
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
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-syntax': noUnknownRule,
    },
  },
];
