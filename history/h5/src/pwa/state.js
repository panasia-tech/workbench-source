import { reactive } from 'vue'

// PWA 相关的状态：在线/离线、新版本、能否安装到桌面
const ua = navigator.userAgent
export const pwa = reactive({
  online: navigator.onLine,
  needRefresh: false,
  standalone: window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
  ios: /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1),
  canInstall: false,
  update: null,
})

let deferred = null

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  deferred = e
  pwa.canInstall = true
})

window.addEventListener('appinstalled', () => {
  deferred = null
  pwa.canInstall = false
})

window.addEventListener('online', () => { pwa.online = true })
window.addEventListener('offline', () => { pwa.online = false })

/** 安卓 Chrome：弹系统的「安装应用」。返回是否装了。 */
export async function promptInstall() {
  if (!deferred) return false
  deferred.prompt()
  const choice = await deferred.userChoice
  deferred = null
  pwa.canInstall = false
  return choice.outcome === 'accepted'
}
