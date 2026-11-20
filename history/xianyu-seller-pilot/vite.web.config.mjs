import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// The Electron renderer and the employee H5 intentionally share the same Vue
// views.  The transport is injected at runtime by server/web/erp-adapter.js;
// no Electron or preload module is bundled into this output.
export default defineConfig({
  root: resolve('src/renderer'),
  resolve: { alias: { '@': resolve('src/renderer/src') } },
  plugins: [vue()],
  build: {
    outDir: resolve('out/web'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve('src/renderer/index.html')
    }
  }
})
