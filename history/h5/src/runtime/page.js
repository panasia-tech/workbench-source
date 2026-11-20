import { deepClone } from './util.js'
import { bindVm, isTop } from './router.js'
import { isDesktop } from './viewport.js'

// Page({...}) 的配置 → Vue 组件。
// 生命周期对照：onLoad/onShow 在 created（首次渲染前，和小程序一样 onLoad 里 setData 不闪），
// onReady 在 mounted，onHide/onShow 由路由在页面被盖住/露出来时调，onUnload 在出栈时调。

export const MP_HOST = Symbol('mp-host')

export function safeCall(vm, name, arg) {
  const fn = vm[name]
  if (typeof fn !== 'function') return undefined
  try {
    return fn.call(vm, arg)
  } catch (e) {
    console.error(`[${vm.route || vm.is || 'mp'}] ${name} 出错：`, e)
    return undefined
  }
}

const pageInternals = {
  __mpShow() {
    if (this.__mpUnloaded || this.__mpShown) return
    this.__mpShown = true
    safeCall(this, 'onShow')
    const host = this.__mpHost
    if (host) for (const c of host.components) c.__mpPageLifetime && c.__mpPageLifetime('show')
  },
  __mpHide() {
    if (this.__mpUnloaded || !this.__mpShown) return
    this.__mpShown = false
    safeCall(this, 'onHide')
    const host = this.__mpHost
    if (host) for (const c of host.components) c.__mpPageLifetime && c.__mpPageLifetime('hide')
  },
  __mpUnload() {
    if (this.__mpUnloaded) return
    this.__mpUnloaded = true
    safeCall(this, 'onUnload')
  },
}

/** 模板引用了、初始 data 里没有的字段补成 undefined，让 Vue 从一开始就追踪它们 */
export function withDataKeys(data, keys, skip) {
  for (const k of keys || []) {
    if (!(k in data) && !(skip && k in skip)) data[k] = undefined
  }
  return data
}

// 电脑版（src/desktop/ 下的 .desktop.js）里的生命周期：接在原页面的同名函数后面调，不顶替
const CHAINED_HOOKS = ['onLoad', 'onShow', 'onReady', 'onHide', 'onUnload', 'onPullDownRefresh', 'onReachBottom']

function chain(a, b) {
  if (typeof a !== 'function') return b
  return function chained(arg) {
    const r = a.call(this, arg)
    b.call(this, arg)
    return r
  }
}

/** 页面配置并上电脑版的数据和方法：data 合并，方法同名的电脑版优先（原方法以 __mobile_名字 留着），生命周期串起来 */
function applyDesktopMixin(opts, mixin) {
  if (!mixin) return opts
  const merged = { ...opts, data: { ...(opts.data || {}), ...(mixin.data || {}) } }
  for (const [k, fn] of Object.entries(mixin.methods || {})) {
    if (typeof opts[k] === 'function') merged[`__mobile_${k}`] = opts[k]
    merged[k] = fn
  }
  for (const k of CHAINED_HOOKS) {
    if (typeof mixin[k] === 'function') merged[k] = chain(opts[k], mixin[k])
  }
  return merged
}

export function definePage({ route, def, render, scopeId, wxs, components, json, dataKeys, desktop }) {
  if (!def || def.type !== 'page') throw new Error(`miniprogram/${route}.js 没有调用 Page()`)
  const opts = applyDesktopMixin(def.options, desktop && desktop.mixin)
  const methods = {}
  const fields = {}
  for (const key of Object.keys(opts)) {
    if (key === 'data') continue
    if (typeof opts[key] === 'function') methods[key] = opts[key]
    else fields[key] = opts[key]
  }
  // 电脑版模板：≥1024 宽时换它渲染，同一个页面实例、同一份数据。两套模板的渲染缓存分开放
  const dk = desktop && desktop.view
  const allKeys = dk ? [...new Set([...(dataKeys || []), ...(dk.dataKeys || [])])] : dataKeys
  const pick = dk
    ? function pickRender(ctx, cache, ...rest) {
      if (!isDesktop.value) return render(ctx, cache, ...rest)
      const inst = ctx.$
      return dk.render(ctx, inst.__mpDkCache || (inst.__mpDkCache = []), ...rest)
    }
    : render
  return {
    name: `mp-page-${route.replace(/[^\w]+/g, '-')}`,
    __scopeId: scopeId,
    __mpJson: json,
    __mpDesktop: !!dk,
    render: pick,
    components: dk ? { ...dk.components, ...components } : components,
    inject: { __mpHost: { from: MP_HOST, default: null } },
    setup() {
      return dk ? { ...dk.wxs, ...wxs } : wxs
    },
    data() {
      return withDataKeys(deepClone(opts.data || {}), allKeys)
    },
    methods: { ...methods, ...pageInternals },
    created() {
      const host = this.__mpHost
      for (const k of Object.keys(fields)) this[k] = deepClone(fields[k])
      this.data = this.$data
      this.route = route
      // 小程序里 this.options（页面参数）和 data.options 互不相干；Vue 里是同一个名字，
      // 页面 data 自己有 options 时（盘点记录的筛选项）不能拿参数把它盖掉
      if (!('options' in this.$data)) this.options = host ? { ...host.entry.query } : {}
      this.__mpShown = false
      this.__mpUnloaded = false
      if (host) {
        host.pageVm = this
        bindVm(host.entry, this)
      }
      safeCall(this, 'onLoad', this.options)
      if (host && isTop(host.entry) && document.visibilityState !== 'hidden') this.__mpShow()
    },
    mounted() {
      safeCall(this, 'onReady')
    },
    beforeUnmount() {
      this.__mpUnload()
    },
  }
}
