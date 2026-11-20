import { ref } from 'vue'

// 电脑档：屏宽 ≥1024。外壳换成左侧菜单 + 顶栏，有电脑版模板（src/desktop/**.wxml）的页面换成电脑版。
// 跟着窗口实时变：拖窄浏览器就回到手机样子，页面数据不丢（同一个页面实例，只是换一套模板）。
export const DESKTOP_QUERY = '(min-width: 1024px)'

const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(DESKTOP_QUERY) : null

export const isDesktop = ref(!!(mq && mq.matches))

if (mq) {
  const update = () => { isDesktop.value = mq.matches }
  if (mq.addEventListener) mq.addEventListener('change', update)
  else if (mq.addListener) mq.addListener(update)
}
