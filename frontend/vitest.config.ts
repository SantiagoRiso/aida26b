import { mergeConfig, defineConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      setupFiles: ['./test/setup.ts'],
      // Vitest only — never pulls in e2e/ specs (Playwright runs those exclusively).
      include: ['test/**/*.test.ts'],
      globals: false,
      clearMocks: true,
      restoreMocks: true,
      coverage: {
        provider: 'v8',
        reporter: ['text', 'html', 'json-summary'],
        reportsDirectory: './coverage',
        include: ['src/**/*.{ts,vue}'],
        // Measured 2026-07-20: statements ~53-55%, branches ~45-46%, functions ~48-49%,
        // lines ~54-57% (varies slightly as the suite grows). Floor set a couple points
        // under the low end so the gate is meaningful today, not aspirational.
        thresholds: {
          lines: 54,
          statements: 52,
          functions: 48,
          branches: 44,
        },
      },
    },
  }),
);
