import { reactive } from 'vue'
import { callbackSync } from './util.js'
import { pushLayer, popLayer } from './router.js'

// 弹层的状态。渲染在 src/shell/Overlays.vue 等组件里。
// 能「返回键关掉」的弹层（模态框、操作菜单、选择器、图片预览、扫码）都登记成路由层，
// 安卓返回手势先关弹层，不会把整页退掉。

// ---------------------------------------------------------------- toast / loading
// 小程序里 toast 和 loading 是同一个位置：showToast 会顶掉 loading，hideLoading 也会关掉 toast。
export const toast = reactive({ visible: false, title: '', icon: 'none', image: '', mask: false, loading: false, seq: 0 })
let toastTimer = null

export function showToast(o = {}) {
  clearTimeout(toastTimer)
  const icon = o.icon === undefined ? 'success' : o.icon
  Object.assign(toast, {
    visible: true,
    title: o.title == null ? '' : String(o.title),
    icon,
    image: o.image || '',
    mask: !!o.mask,
    loading: icon === 'loading',
    seq: toast.seq + 1,
  })
  const duration = o.duration === undefined ? 1500 : Number(o.duration)
  if (duration > 0) toastTimer = setTimeout(hideToast, duration)
}

export function showLoading(o = {}) {
  clearTimeout(toastTimer)
  Object.assign(toast, {
    visible: true,
    title: o.title == null ? '' : String(o.title),
    icon: 'loading',
    image: '',
    mask: !!o.mask,
    loading: true,
    seq: toast.seq + 1,
  })
}

export function hideToast() {
  clearTimeout(toastTimer)
  toast.visible = false
}

// ---------------------------------------------------------------- modal
export const modal = reactive({ visible: false, current: null, inputValue: '' })
const modalQueue = []

export function showModal(options) {
  const o = {
    title: '',
    content: '',
    showCancel: true,
    cancelText: '取消',
    cancelColor: '#000000',
    confirmText: '确定',
    confirmColor: '#576B95',
    editable: false,
    placeholderText: '',
    ...options,
  }
  return new Promise((resolve) => {
    modalQueue.push({ o, resolve })
    if (!modal.visible) nextModal()
  })
}

function nextModal() {
  const item = modalQueue.shift()
  if (!item) {
    modal.visible = false
    modal.current = null
    return
  }
  modal.current = item
  modal.inputValue = item.o.editable ? String(item.o.content || '') : ''
  modal.visible = true
  item.layer = pushLayer(() => answerModal(false))
}

export function answerModal(confirm) {
  const item = modal.current
  if (!item) return
  modal.current = null
  modal.visible = false
  popLayer(item.layer)
  const res = { confirm: !!confirm, cancel: !confirm }
  if (item.o.editable) res.content = confirm ? modal.inputValue : null
  const r = callbackSync('showModal', item.o, true, res)
  item.resolve(r)
  if (modalQueue.length) setTimeout(nextModal, 0)
}

// ---------------------------------------------------------------- action sheet
export const actionSheet = reactive({ visible: false, current: null })

export function showActionSheet(options) {
  return new Promise((resolve, reject) => {
    if (actionSheet.current) answerActionSheet(-1)
    const item = { o: { itemColor: '#000000', alertText: '', itemList: [], ...options }, resolve, reject }
    actionSheet.current = item
    actionSheet.visible = true
    item.layer = pushLayer(() => answerActionSheet(-1))
  })
}

export function answerActionSheet(index) {
  const item = actionSheet.current
  if (!item) return
  actionSheet.current = null
  actionSheet.visible = false
  popLayer(item.layer)
  if (index >= 0) item.resolve(callbackSync('showActionSheet', item.o, true, { tapIndex: index }))
  else item.reject(callbackSync('showActionSheet', item.o, false, 'cancel'))
}

// ---------------------------------------------------------------- 底部滚轮选择器（picker selector / 月份）
// columns: [[label, ...], ...]  value: [index, ...]
// anchor：触发它的那个框的位置（电脑上单列选择器做成贴在它下面的下拉列表）
export const pickerSheet = reactive({ visible: false, columns: [], value: [], title: '', current: null, anchor: null })

export function openPickerSheet({ columns, value, title = '', anchor = null }) {
  return new Promise((resolve) => {
    if (pickerSheet.current) closePickerSheet(null)
    const item = { resolve }
    pickerSheet.current = item
    pickerSheet.columns = columns
    pickerSheet.value = columns.map((col, i) => Math.min(Math.max(Number(value && value[i]) || 0, 0), Math.max(col.length - 1, 0)))
    pickerSheet.title = title
    pickerSheet.anchor = anchor
    pickerSheet.visible = true
    item.layer = pushLayer(() => closePickerSheet(null))
  })
}

export function closePickerSheet(result) {
  const item = pickerSheet.current
  if (!item) return
  pickerSheet.current = null
  pickerSheet.visible = false
  popLayer(item.layer)
  item.resolve(result)
}

// ---------------------------------------------------------------- 图片 / 视频预览
export const preview = reactive({ visible: false, items: [], index: 0, layer: null })

export function openPreview(items, index = 0) {
  if (!items.length) return
  preview.items = items
  preview.index = Math.min(Math.max(index, 0), items.length - 1)
  preview.visible = true
  if (preview.layer) popLayer(preview.layer)
  preview.layer = pushLayer(() => closePreview())
}

export function closePreview() {
  if (!preview.visible) return
  preview.visible = false
  popLayer(preview.layer)
  preview.layer = null
}

// ---------------------------------------------------------------- 扫码
export const scanner = reactive({ visible: false, formats: [], current: null })

export function openScanner(formats) {
  return new Promise((resolve, reject) => {
    if (scanner.current) closeScanner(null)
    const item = { resolve, reject }
    scanner.current = item
    scanner.formats = formats
    scanner.visible = true
    item.layer = pushLayer(() => closeScanner(null))
  })
}

/** result: { text, format } 或 null（取消） */
export function closeScanner(result) {
  const item = scanner.current
  if (!item) return
  scanner.current = null
  scanner.visible = false
  popLayer(item.layer)
  if (result) item.resolve(result)
  else item.reject({ errMsg: 'scanCode:fail cancel' })
}
