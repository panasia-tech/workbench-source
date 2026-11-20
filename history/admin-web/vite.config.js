import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// base：管理后台的部署前缀。后台整体挂在这个子路径下，根路径 301 过来。
// （2026-09-17 之前根路径是个静态博客，备案下号后删了。）
// 改前缀只需改这一处——router 和 api.js 都读 import.meta.env.BASE_URL。
export default defineConfig({
  base: '/console/',
  plugins: [vue()],
  // 两个页面：后台本身，和单独给手机用的大台账（/console/ledger.html，见 src/ledger/）
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        ledger: fileURLToPath(new URL('./ledger.html', import.meta.url)),
      },
    },
  },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8000' } },
})
