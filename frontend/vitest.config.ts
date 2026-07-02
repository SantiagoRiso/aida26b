import { mergeConfig, defineConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      // Vitest only — never pulls in e2e/ specs (Playwright runs those exclusively).
      include: ['test/**/*.test.ts'],
      globals: false,
      clearMocks: true,
      restoreMocks: true,
    },
  }),
);
