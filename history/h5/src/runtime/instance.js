import { nextTick } from 'vue'
import { convertStyle, parsePath, warnOnce } from './util.js'

// 挂到每个页面 / 组件实例上的方法（app.config.globalProperties），以及编译产物里用到的模板辅助函数。

// ---------------------------------------------------------------- setData

// 输入框回显：处理函数 setData 了一个和输入不同的值（比如金额被截成两位小数），
// 但这个值和改之前一样、Vue 不会重渲染——输入框里会残留用户多打的字。
// 这里把一次事件处理期间 setData 写过的值记下来，输入框据此决定要不要回写。
let capture = null
export function beginCapture() { capture = new Set() }
export function endCapture() {
  const c = capture
  capture = null
  return c || new Set()
}

export function setData(obj, cb) {
  if (obj && typeof obj === 'object') {
    const data = this.$data
    for (const key of Object.keys(obj)) {
      const value = obj[key]
      const path = parsePath(key)
      if (!path.length) continue
      let target = data
      for (let i = 0; i < path.length - 1; i++) {
        const k = path[i]
        if (target[k] == null || typeof target[k] !== 'object') target[k] = typeof path[i + 1] === 'number' ? [] : {}
        target = target[k]
      }
      target[path[path.length - 1]] = value
      if (capture && (typeof value === 'string' || typeof value === 'number')) capture.add(String(value))
    }
  }
  if (typeof cb === 'function') nextTick(() => cb.call(this))
}

// ---------------------------------------------------------------- 事件

function touchesOf(list) {
  if (!list) return []
  return Array.from(list, (t) => ({
    identifier: t.identifier, pageX: t.pageX, pageY: t.pageY, clientX: t.clientX, clientY: t.clientY, force: t.force,
  }))
}

export function makeEvent(type, dataset, domEvent, detail, id) {
  const target = { id: id || '', dataset: dataset || {}, offsetLeft: 0, offsetTop: 0 }
  const ev = {
    type,
    timeStamp: domEvent && domEvent.timeStamp ? Math.round(domEvent.timeStamp) : Math.round(performance.now()),
    target,
    currentTarget: target,
    detail: detail === undefined ? {} : detail,
    mark: {},
  }
  if (domEvent && (domEvent.touches || domEvent.changedTouches)) {
    ev.touches = touchesOf(domEvent.touches)
    ev.changedTouches = touchesOf(domEvent.changedTouches)
  }
  return ev
}

function resolveHandler(vm, handler, quiet) {
  if (typeof handler === 'function') return handler
  if (!handler) return null
  const fn = vm[handler]
  if (typeof fn === 'function') return fn
  if (!quiet) warnOnce(`${vm.route || vm.is || '页面'}：没有方法 ${handler}`)
  return null
}

/** 原生元素上的 bindtap / bindtouchstart 等 */
export function $mpEv(e, type, handler, dataset) {
  const fn = resolveHandler(this, handler)
  if (!fn) return undefined
  let detail = {}
  if (type === 'tap' || type === 'longpress') {
    detail = { x: e && e.pageX != null ? e.pageX : 0, y: e && e.pageY != null ? e.pageY : 0 }
  } else if (e && e.detail != null && typeof e.detail === 'object') {
    detail = e.detail
  }
  const id = e && e.currentTarget && e.currentTarget.id
  return fn.call(this, makeEvent(type, dataset, e, detail, id))
}

/** 组件事件：内置组件（input/picker…）和自定义组件 triggerEvent 都走这里 */
export function $mpCE(detail, type, handler, dataset, domEvent) {
  const fn = resolveHandler(this, handler)
  if (!fn) return undefined
  return fn.call(this, makeEvent(type, dataset, domEvent, detail))
}

export function insideScrollable(el, boundary) {
  for (let n = el; n && n !== boundary && n.nodeType === 1; n = n.parentElement) {
    const s = getComputedStyle(n)
    if (/(auto|scroll)/.test(s.overflowY + s.overflowX) && (n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1)) return true
  }
  return false
}

/** catchtouchmove：遮罩层挡住页面滚动，但遮罩里能滚的列表照常滚 */
export function $mpTouchCatch(e, handler, dataset) {
  e.stopPropagation()
  if (e.cancelable && !insideScrollable(e.target, e.currentTarget)) e.preventDefault()
  const fn = resolveHandler(this, handler, true)
  if (fn) fn.call(this, makeEvent('touchmove', dataset, e, {}))
}

// ---------------------------------------------------------------- 模板辅助

/** wx:for 的遍历对象：数组照旧；数字 n → 0..n-1；字符串按字；对象按值（index 是键） */
export function $mpList(v) {
  if (v == null) return []
  if (Array.isArray(v)) return v
  if (typeof v === 'number') return Array.from({ length: Math.max(0, Math.floor(v)) }, (_, i) => i)
  if (typeof v === 'string') return v.split('')
  return v
}

/** 带上下标的 key：小程序允许 wx:key 重复，Vue 不允许 */
export function $mpKey(item, index, key) {
  if (key === '*this') return `${index}\u0001${typeof item === 'object' ? '' : String(item)}`
  const k = item != null && typeof item === 'object' ? item[key] : undefined
  return `${index}\u0001${k == null ? '' : String(k)}`
}

export function $s(v) {
  return v == null ? '' : String(v)
}

export function $rpx(v) {
  return convertStyle(v)
}

// ---------------------------------------------------------------- 组件相关

export function triggerEvent(name, detail) {
  const on = this.$props && this.$props.mpOn
  const fn = on && on[name]
  if (typeof fn === 'function') return fn(detail === undefined ? {} : detail)
  return undefined
}

function matches(vm, selector) {
  const sel = String(selector || '').trim()
  if (!sel) return false
  const el = vm.$el
  if (sel.startsWith('#')) return (vm.$attrs && vm.$attrs.id === sel.slice(1)) || (el && el.id === sel.slice(1))
  if (sel.startsWith('.')) return !!(el && el.classList && el.classList.contains(sel.slice(1)))
  return vm.is === sel || (el && el.tagName && el.tagName.toLowerCase() === `wx-${sel}`)
}

export function selectAllComponents(selector) {
  const host = this.__mpHost
  if (!host) return []
  return [...host.components].filter((c) => c !== this && matches(c, selector))
}

export function selectComponent(selector) {
  return selectAllComponents.call(this, selector)[0] || null
}

export function getTabBar() {
  const host = this.__mpHost
  return host && host.tabBar ? host.tabBar() : null
}

// ---------------------------------------------------------------- 指令

function parseTime(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** hover-class：按下 hover-start-time 后加类，抬起 hover-stay-time 后去掉 */
export const hoverDirective = {
  mounted(el, binding) {
    el.__mpHover = binding.value || {}
    let startTimer = null
    let stayTimer = null
    let sx = 0
    let sy = 0
    const classes = () => {
      const c = el.__mpHover.cls
      return !c || c === 'none' ? [] : String(c).split(/\s+/).filter(Boolean)
    }
    const clear = () => {
      clearTimeout(startTimer)
      const list = classes()
      if (!list.length) return
      clearTimeout(stayTimer)
      stayTimer = setTimeout(() => el.classList.remove(...list), parseTime(el.__mpHover.stay, 400))
    }
    const down = (e) => {
      if (e.__mpHoverHandled) return
      if (el.__mpHover.stop) e.__mpHoverHandled = true
      const list = classes()
      if (!list.length) return
      sx = e.clientX
      sy = e.clientY
      clearTimeout(stayTimer)
      startTimer = setTimeout(() => el.classList.add(...list), parseTime(el.__mpHover.start, 50))
    }
    const move = (e) => {
      if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) clear()
    }
    el.__mpHoverOff = () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', clear)
      el.removeEventListener('pointercancel', clear)
      el.removeEventListener('pointerleave', clear)
    }
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', clear)
    el.addEventListener('pointercancel', clear)
    el.addEventListener('pointerleave', clear)
  },
  updated(el, binding) {
    el.__mpHover = binding.value || {}
  },
  beforeUnmount(el) {
    if (el.__mpHoverOff) el.__mpHoverOff()
  },
}

/** bindlongpress：按住 350ms 触发，触发后这一次的 tap 不再派发 */
export const longpressDirective = {
  mounted(el, binding) {
    el.__mpLp = binding.value || {}
    let timer = null
    let fired = false
    let sx = 0
    let sy = 0
    let pointerType = ''
    const cancel = () => clearTimeout(timer)
    const down = (e) => {
      fired = false
      pointerType = e.pointerType
      sx = e.clientX
      sy = e.clientY
      clearTimeout(timer)
      timer = setTimeout(() => {
        fired = true
        if (el.__mpLp.stop) e.stopPropagation()
        if (typeof el.__mpLp.fn === 'function') el.__mpLp.fn(e)
      }, 350)
    }
    const move = (e) => {
      if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) cancel()
    }
    const click = (e) => {
      if (fired) {
        fired = false
        e.stopImmediatePropagation()
        e.preventDefault()
      }
    }
    // 电脑上鼠标右键 = 长按（删除、看大图这些原本要按住的操作）。只认鼠标：触屏长按也会冒出
    // contextmenu，那时计时器已经触发过了，不能再来一次
    const ctx = (e) => {
      e.preventDefault()
      if (pointerType !== 'mouse' || fired) return
      clearTimeout(timer)
      if (el.__mpLp.stop) e.stopPropagation()
      if (typeof el.__mpLp.fn === 'function') el.__mpLp.fn(e)
    }
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', cancel)
    el.addEventListener('pointercancel', cancel)
    el.addEventListener('click', click, true)
    el.addEventListener('contextmenu', ctx)
    el.__mpLpOff = () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', cancel)
      el.removeEventListener('pointercancel', cancel)
      el.removeEventListener('click', click, true)
      el.removeEventListener('contextmenu', ctx)
    }
  },
  updated(el, binding) {
    el.__mpLp = binding.value || {}
  },
  beforeUnmount(el) {
    if (el.__mpLpOff) el.__mpLpOff()
  },
}
