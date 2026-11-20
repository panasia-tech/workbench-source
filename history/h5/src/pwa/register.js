import { pwa } from './state.js'

// Service Worker：预缓存整个前端（含扫码用的 wasm），接口一律走网络。
// 新版本不自动接管——员工可能正填到一半，弹条提示让人自己点「更新」。
export async function registerPwa() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  const { registerSW } = await import('virtual:pwa-register')
  const updateSW = registerSW({
    onNeedRefresh() {
      pwa.needRefresh = true
    },
    onRegisteredSW(url, reg) {
      if (!reg) return
      const check = () => reg.update().catch(() => {})
      setInterval(check, 30 * 60 * 1000)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check()
      })
    },
    onRegisterError(e) {
      console.warn('[H5] Service Worker 注册失败', e)
    },
  })
  pwa.update = () => updateSW(true)
}
