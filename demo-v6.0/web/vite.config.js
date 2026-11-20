import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [vue()],
  resolve: {
    preserveSymlinks: true,
    alias: {
      'vue-router': path.resolve(__dirname, 'src/lib/vue-router.js'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:5860',
      '/app/xy-sxjk': 'http://127.0.0.1:5860',
      '/media': 'http://127.0.0.1:5860',
      '/evidence': 'http://127.0.0.1:5860',
    },
  },
});
