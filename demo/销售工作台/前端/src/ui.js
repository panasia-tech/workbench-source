// 全局小状态：提示、「怎么用」抽屉、视频弹层、双皮肤主题切换。
import { reactive } from 'vue'

const urlSkin = new URLSearchParams(location.search).get('skin')
let savedSkin = null
try { savedSkin = localStorage.getItem('erp_skin') } catch {}
const sysDark = typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
const initSkin = (urlSkin === 'dark' || urlSkin === 'light')
  ? urlSkin
  : (savedSkin === 'dark' || savedSkin === 'light') ? savedSkin : (sysDark ? 'dark' : 'light')

export const ui = reactive({
  term: null, tour: null, help: null, video: null, practice: null, toast: '',
  fontBig: (() => { try { return localStorage.getItem('font_big') !== '0' } catch { return true } })(),
  skin: initSkin
})
let t
export const toast = (m) => { ui.toast = m; clearTimeout(t); t = setTimeout(() => (ui.toast = ''), 2600) }
export const openHelp = (key) => { ui.help = key }
export const openTerm = (k) => { ui.term = k }
export const openVideo = (v) => { ui.video = v }
export const setFont = (big) => { ui.fontBig = big; try { localStorage.setItem('font_big', big ? '1' : '0') } catch {}; document.documentElement.style.fontSize = big ? '17px' : '15px' }
export const setSkin = (s) => {
  const next = s === 'dark' ? 'dark' : 'light'
  ui.skin = next
  try { localStorage.setItem('erp_skin', next) } catch {}
  document.documentElement.dataset.skin = next
  document.documentElement.style.colorScheme = next
}
export const toggleSkin = () => {
  setSkin(ui.skin === 'dark' ? 'light' : 'dark')
  toast(ui.skin === 'dark' ? '已切换：Claude 黑色皮肤' : '已切换：Stitch 浅色皮肤')
}
setSkin(initSkin)
window.addEventListener('erp-skin-set', (e) => { if (e?.detail) setSkin(e.detail) })

// Gallery 的筛选、分组、搜索词：进详情再返回要还在（#95 LIB-02）
export const gf = reactive({ flt: 'all', by: 'status', q: '' })
