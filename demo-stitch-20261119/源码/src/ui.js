// 全局小状态：提示、「怎么用」抽屉、视频弹层。
import { reactive } from 'vue'

export const ui = reactive({ term: null, tour: null, help: null, video: null, practice: null, toast: '', fontBig: localStorage.getItem('font_big') !== '0' })
let t
export const toast = (m) => { ui.toast = m; clearTimeout(t); t = setTimeout(() => (ui.toast = ''), 2600) }
export const openHelp = (key) => { ui.help = key }
export const openTerm = (k) => { ui.term = k }
export const openVideo = (v) => { ui.video = v }
export const setFont = (big) => { ui.fontBig = big; localStorage.setItem('font_big', big ? '1' : '0'); document.documentElement.style.fontSize = big ? '17px' : '15px' }

// Gallery 的筛选、分组、搜索词：进详情再返回要还在（#95 LIB-02）
export const gf = reactive({ flt: 'all', by: 'status', q: '' })
