// 电脑 / 手机两套排版的开关：≥1024 宽走后台式布局（侧栏 + 表格），否则走原来的手机页面。
// 全页共用一个 ref，窗口拉宽拉窄会跟着切；只换排版，页面不重建（看到哪、翻到第几页都还在，见 LedgerApp.vue）。
import { ref } from 'vue'

const QUERY = '(min-width: 1024px)'
const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(QUERY) : null
const isDesktop = ref(!!mq?.matches)

if (mq) {
  const on = (e) => { isDesktop.value = e.matches }
  if (mq.addEventListener) mq.addEventListener('change', on)
  else if (mq.addListener) mq.addListener(on) // 老 iOS Safari
}

export function useDesktop() {
  return isDesktop
}
