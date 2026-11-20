import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import mp from './compiler/plugin.js'

// H5 挂在 http://127.0.0.1:8000 见 deploy/nginx/admin.conf），接口走同域名的 /api 与 /ws。
// 本地开发：/api、/ws 代理到 H5_PROXY_TARGET，默认本机 8000 端口的后端。
// 聚合聊天直连群控的 /gc：线上是 nginx 转到群控 8100 的 /api/gc/；本地起了群控就设
// H5_GC_PROXY_TARGET=http://127.0.0.1:端口（代理时补上 /api 前缀），不设就跟 /api 走同一个后端。
// 不改 Host：后端 307 重定向（比如尾斜杠）要落回同源，跨源重定向浏览器会丢掉 Authorization。
// 改部署前缀只改 base 这一处：manifest 的 start_url/scope 跟着它算。
const BASE = '/h5/'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.H5_PROXY_TARGET || 'http://127.0.0.1:8000'
  // 本机后端不改 Host（见上）；代理到远端时要改，否则对面 nginx 按 Host 找不到站点
  const changeOrigin = !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(target)
  const gcTarget = env.H5_GC_PROXY_TARGET
  const proxy = {
    '/api': { target, changeOrigin },
    '/ws': { target, changeOrigin, ws: true },
    '/gc': gcTarget
      ? { target: gcTarget, rewrite: (p) => p.replace(/^\/gc\//, '/api/gc/') }
      : { target, changeOrigin },
  }
  return {
    base: BASE,
    plugins: [
      mp(),
      vue({ template: { compilerOptions: { isCustomElement: (tag) => tag.startsWith('wx-') } } }),
      VitePWA({
        registerType: 'prompt',
        injectRegister: false,
        includeAssets: ['icons/*.png', 'icons/*.svg'],
        manifest: {
          id: BASE,
          name: '泛亚货运社',
          short_name: '泛亚货运社',
          description: '泛亚货运社员工端',
          lang: 'zh-CN',
          start_url: BASE,
          scope: BASE,
          display: 'standalone',
          orientation: 'portrait',
          background_color: '#F5F7FA',
          theme_color: '#F5F7FA',
          icons: [
            { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          // 整个前端（含扫码 wasm）预缓存，断网也能打开；接口不缓存，数据永远是现取的
          globPatterns: ['**/*.{js,css,html,svg,png,ico,wasm,webmanifest}'],
          navigateFallback: `${BASE}index.html`,
          navigateFallbackAllowlist: [new RegExp(`^${BASE}`)],
          cleanupOutdatedCaches: true,
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        },
      }),
    ],
    server: { port: 5180, strictPort: true, proxy },
    // 本地看生产包（含 Service Worker）：pnpm build && pnpm preview
    preview: { port: 5181, strictPort: true, proxy },
    build: {
      target: ['es2020', 'safari14', 'chrome87', 'firefox78'],
      chunkSizeWarningLimit: 1500,
    },
  }
})
