import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared/src'),
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      // Dev-only: Express runs on :3000; Vite dev server proxies /api so cookies stay same-site.
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
  },
});
