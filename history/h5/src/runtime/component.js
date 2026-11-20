import { deepClone, getByPath } from './util.js'
import { MP_HOST, safeCall, withDataKeys } from './page.js'

// Component({...}) 的配置 → Vue 组件。
//   properties → props（不声明 Vue 的 type，免得 Boolean 强转和小程序的语义打架）
//   this.data  → data 与 properties 合在一起读（小程序里两者同在 this.data 上）
//   observers / property observer → $watch
//   lifetimes：created/attached 在首次渲染前，ready 在 mounted，detached 在卸载前
//   pageLifetimes.show/hide 由所在页面转发

const LIFETIMES = ['created', 'attached', 'ready', 'moved', 'detached', 'error']

function zeroOf(type) {
  if (type === String) return ''
  if (type === Number) return 0
  if (type === Boolean) return false
  if (type === Array) return []
  return null
}

function propOption(spec) {
  let type = spec
  let value
  if (spec === null || (typeof spec === 'object' && !Array.isArray(spec))) {
    type = spec && spec.type
    value = spec ? spec.value : undefined
  }
  if (value === undefined) value = zeroOf(type)
  return value !== null && typeof value === 'object' ? { default: () => deepClone(value) } : { default: value }
}

function dataView(vm) {
  const props = vm.$props
  return new Proxy(vm.$data, {
    get(t, k, r) {
      if (typeof k === 'string' && !(k in t) && k in props) return props[k]
      return Reflect.get(t, k, r)
    },
    has(t, k) {
      return k in t || k in props
    },
    ownKeys(t) {
      return [...new Set([...Reflect.ownKeys(t), ...Reflect.ownKeys(props).filter((k) => k !== 'mpOn')])]
    },
    getOwnPropertyDescriptor(t, k) {
      if (k in t) return Reflect.getOwnPropertyDescriptor(t, k)
      if (k in props) return { configurable: true, enumerable: true, writable: false, value: props[k] }
      return undefined
    },
  })
}

function setupObservers(vm, o) {
  for (const [expr, fn] of Object.entries(o.observers || {})) {
    if (typeof fn !== 'function') continue
    const fields = expr.split(',').map((s) => s.trim()).filter(Boolean)
    const deep = fields.some((f) => f.endsWith('**'))
    const paths = fields.map((f) => f.replace(/\.?\*\*$/, ''))
    vm.$watch(
      () => paths.map((p) => (p ? getByPath(vm.data, p) : vm.$data)),
      (vals) => {
        try { fn.apply(vm, vals) } catch (e) { console.error(`[${vm.is}] observer ${expr} 出错：`, e) }
      },
      { deep },
    )
  }
  for (const [name, spec] of Object.entries(o.properties || {})) {
    const obs = spec && typeof spec === 'object' && spec.observer
    if (!obs) continue
    vm.$watch(
      () => vm.$props[name],
      (n, old) => {
        const f = typeof obs === 'function' ? obs : vm[obs]
        if (typeof f === 'function') f.call(vm, n, old)
      },
    )
  }
}

export function defineMpComponent({ route, def, render, scopeId, wxs, components, host, dataKeys }) {
  if (!def || def.type !== 'component') throw new Error(`miniprogram/${route}.js 没有调用 Component()`)
  const o = def.options
  const props = { mpOn: { default: null } }
  for (const [name, spec] of Object.entries(o.properties || {})) props[name] = propOption(spec)
  const lifetimes = {}
  for (const k of LIFETIMES) if (typeof o[k] === 'function') lifetimes[k] = o[k]
  Object.assign(lifetimes, o.lifetimes || {})
  const pageLifetimes = o.pageLifetimes || {}
  const run = (vm, name) => {
    const f = lifetimes[name]
    if (typeof f !== 'function') return
    try { f.call(vm) } catch (e) { console.error(`[${route}] ${name} 出错：`, e) }
  }

  return {
    name: `mp-${host}`,
    __scopeId: scopeId,
    render,
    components,
    props,
    inject: { __mpHost: { from: MP_HOST, default: null } },
    setup() {
      return wxs
    },
    data() {
      return withDataKeys(deepClone(o.data || {}), dataKeys, props)
    },
    methods: {
      ...(o.methods || {}),
      __mpPageLifetime(name) {
        const f = pageLifetimes[name]
        if (typeof f === 'function') {
          try { f.call(this) } catch (e) { console.error(`[${route}] pageLifetimes.${name} 出错：`, e) }
        }
      },
    },
    created() {
      this.data = dataView(this)
      this.properties = this.$props
      this.is = route
      this.id = (this.$attrs && this.$attrs.id) || ''
      setupObservers(this, o)
      if (this.__mpHost) this.__mpHost.components.add(this)
      run(this, 'created')
      run(this, 'attached')
    },
    mounted() {
      run(this, 'ready')
    },
    beforeUnmount() {
      run(this, 'detached')
      if (this.__mpHost) this.__mpHost.components.delete(this)
    },
  }
}

export { safeCall }
