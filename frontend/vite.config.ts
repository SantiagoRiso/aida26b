import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { API_PREFIX } from '../shared/src/ssot/api-paths';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared/src'),
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // host:true binds 0.0.0.0 so the dev server is reachable from outside the container.
    host: true,
    port: 8080,
    // Bind-mounted source from a Windows host doesn't emit inotify events inside the
    // Linux container, so the native watcher never fires. Poll instead so edits hot-reload.
    watch: { usePolling: true, interval: 300 },
    proxy: {
      // Dev-only: Express serves the API; Vite proxies /api so cookies stay same-site.
      // Target is the backend host — 'backend' inside Docker, localhost for bare-metal dev.
      [API_PREFIX]: {
        target: process.env.API_PROXY_TARGET || 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
