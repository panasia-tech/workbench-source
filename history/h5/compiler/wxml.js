import path from 'node:path'
import { Parser } from 'htmlparser2'
import { safeExpr, templateDataExpr } from './expr.js'
import { convertUnits } from './wxss.js'

// WXML → Vue 模板字符串。
//
// 映射约定（运行时那一侧见 src/runtime 与 src/components）：
//   view/text            → <wx-view>/<wx-text>（自定义元素，样式里同名映射）
//   image/input/…        → <mp-image>/<mp-input>/…（src/components 下的内置组件）
//   block                → <template>
//   自定义组件            → 原标签名（页面组件里按 usingComponents 注册）
//   wx:if/elif/else      → v-if/v-else-if/v-else
//   wx:for               → v-for + $mpList/$mpKey（数字、对象、null 的遍历语义跟小程序走）
//   bindtap/catchtap     → @click(.stop)，事件对象由 $mpEv 拼成小程序的样子（currentTarget.dataset 等）
//   组件事件 bindinput…  → :mp-on="{ input: … }"，组件内调用，处理函数的返回值能拿到
//   {{表达式}}            → 全部改成可选链，见 expr.js

// 生成的 Vue 模板用默认插值符。表达式里不会出现 '}}'：小程序自己也是遇到第一个 '}}' 就截断的，
// 能在小程序里编译过的表达式都满足这一点。（试过换成 {⟦ ⟧} 这类罕见字符，Vue 的词法器不认非 ASCII 分隔符。）
export const DELIMITERS = ['{{', '}}']

const BUILTIN = {
  view: 'wx-view',
  text: 'wx-text',
  image: 'mp-image',
  input: 'mp-input',
  textarea: 'mp-textarea',
  button: 'mp-button',
  picker: 'mp-picker',
  switch: 'mp-switch',
  'scroll-view': 'mp-scroll-view',
  video: 'mp-video',
  'picker-view': 'mp-picker-view',
  'picker-view-column': 'mp-picker-view-column',
  navigator: 'mp-navigator',
  // 只在 H5 替换件里用（小程序没有 <a>）：备案号这类必须是真链接的地方
  a: 'a',
  // 只在电脑版模板（src/desktop/）里用：真表格，列自动对齐
  table: 'table',
  thead: 'thead',
  tbody: 'tbody',
  tfoot: 'tfoot',
  tr: 'tr',
  th: 'th',
  td: 'td',
  colgroup: 'colgroup',
  col: 'col',
}

// 内置组件自己派发的事件（走 mp-on），其余事件名（tap/longpress/touch*）挂原生监听
const COMPONENT_EVENTS = {
  'mp-input': ['input', 'confirm', 'focus', 'blur', 'keyboardheightchange', 'nicknamereview'],
  'mp-textarea': ['input', 'confirm', 'focus', 'blur', 'linechange', 'keyboardheightchange'],
  'mp-picker': ['change', 'cancel', 'columnchange'],
  'mp-switch': ['change'],
  'mp-scroll-view': ['scroll', 'scrolltoupper', 'scrolltolower', 'dragstart', 'dragging', 'dragend'],
  'mp-video': ['play', 'pause', 'ended', 'timeupdate', 'error', 'fullscreenchange', 'loadedmetadata', 'waiting', 'progress'],
  'mp-image': ['load', 'error'],
  'mp-picker-view': ['change', 'pickstart', 'pickend'],
  'mp-button': ['getphonenumber', 'getuserinfo', 'contact', 'opensetting', 'launchapp', 'chooseavatar', 'error'],
  'mp-navigator': ['success', 'fail', 'complete'],
}

// wx-view / wx-text 上保留下来的普通属性
const NATIVE_KEEP = new Set(['role', 'title', 'href', 'target', 'rel', 'colspan', 'rowspan', 'width'])
const EVENT_RE = /^(capture-bind|capture-catch|mut-bind|bind|catch):?([A-Za-z_][\w-]*)$/
// catchtap="noop" 这类只为挡冒泡的处理函数（弹层内容区），不当成「可点」
const NOOP_TAP = /^(noop|stop|stopPropagation|prevent|preventTap|nothing)$/
const MUSTACHE_RE = /\{\{([\s\S]*?)\}\}/g

export function splitMustache(str) {
  const parts = []
  let last = 0
  str.replace(MUSTACHE_RE, (m, inner, idx) => {
    if (idx > last) parts.push({ text: str.slice(last, idx) })
    parts.push({ expr: inner })
    last = idx + m.length
    return m
  })
  if (last < str.length) parts.push({ text: str.slice(last) })
  return parts
}

// ---------------------------------------------------------------- 解析

function lineOf(src, index) {
  let n = 1
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === '\n') n++
  return n
}

export function parseWxml(source) {
  const exprs = []
  const src = source
    .replace(/^\uFEFF/, '')
    .replace(MUSTACHE_RE, (m) => {
      exprs.push(m)
      return `__MPX${exprs.length - 1}__`
    })
  const restore = (s) => s.replace(/__MPX(\d+)__/g, (_, i) => exprs[+i])
  const root = { type: 'root', children: [] }
  const stack = [root]
  let attrs = []
  const parser = new Parser(
    {
      onattribute(name, value, quote) {
        attrs.push({ name, value: restore(value || ''), bare: quote === undefined })
      },
      onopentag(name) {
        const el = { type: 'element', name, attrs, children: [], line: lineOf(src, parser.startIndex) }
        attrs = []
        stack[stack.length - 1].children.push(el)
        stack.push(el)
      },
      onclosetag() {
        if (stack.length > 1) stack.pop()
      },
      ontext(text) {
        const parent = stack[stack.length - 1]
        const last = parent.children[parent.children.length - 1]
        const value = restore(text)
        if (last && last.type === 'text') last.value += value
        else parent.children.push({ type: 'text', value })
      },
    },
    { xmlMode: true, decodeEntities: false, recognizeSelfClosing: true },
  )
  parser.write(src)
  parser.end()
  return root
}

// ---------------------------------------------------------------- 生成

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

function escText(s) {
  return String(s).replace(/&(?![a-zA-Z]+;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;').replace(/</g, '&lt;')
}

function camelDataset(name) {
  // 小程序：data-element-type → elementType；data-elementType → elementtype
  return name.toLowerCase().replace(/-([a-z])/g, (_, c) => c.toUpperCase())
}

class Ctx {
  constructor({ file, components, where }) {
    this.file = file
    this.components = new Set(components || [])
    this.templates = new Map()
    this.wxs = []
    this.placeholderClasses = new Set()
    this.usedComponents = new Set()
    this.identifiers = new Set()
    this.scopeNames = new Set()
    this.where = where || file
    this.warnings = []
  }

  at(node) {
    return `${this.where}:${node && node.line ? node.line : '?'} `
  }

  expr(code, node) {
    return safeExpr(code, this.at(node), this.identifiers)
  }

  /** 属性值 → JS 表达式：纯 {{x}} 保留原类型；混排拼字符串；无值的布尔属性 → true */
  value(attr, node) {
    if (attr.bare) return 'true'
    const parts = splitMustache(attr.value)
    if (!parts.length) return '""'
    if (parts.length === 1 && parts[0].expr !== undefined) return `(${this.expr(parts[0].expr, node)})`
    if (parts.every((p) => p.text !== undefined)) return JSON.stringify(attr.value)
    return parts
      .map((p) => (p.text !== undefined ? JSON.stringify(p.text) : `$s(${this.expr(p.expr, node)})`))
      .join(' + ')
  }

  isDynamic(attr) {
    return !attr.bare && /\{\{[\s\S]*?\}\}/.test(attr.value)
  }
}

function collect(root, ctx) {
  // 摘出 <wxs> 与 <template name>，其余原样留在树里
  const walk = (node) => {
    if (!node.children) return
    node.children = node.children.filter((child) => {
      if (child.type !== 'element') return true
      if (child.name === 'wxs') {
        const mod = attrOf(child, 'module')
        const src = attrOf(child, 'src')
        if (!mod) throw new Error(`${ctx.at(child)}<wxs> 缺少 module`)
        if (!src) throw new Error(`${ctx.at(child)}H5 暂不支持内联 <wxs>，请改成 src 引用`)
        ctx.wxs.push({ module: mod, src })
        return false
      }
      if (child.name === 'template' && attrOf(child, 'name') != null) {
        ctx.templates.set(attrOf(child, 'name'), child)
        return false
      }
      if (child.name === 'import' || child.name === 'include') {
        throw new Error(`${ctx.at(child)}H5 暂不支持 <${child.name}>`)
      }
      walk(child)
      return true
    })
  }
  walk(root)
  for (const t of ctx.templates.values()) walk(t)
}

function attrOf(node, name) {
  const a = node.attrs.find((x) => x.name === name)
  return a ? a.value : null
}

function genChildren(children, ctx) {
  return children.map((c) => genNode(c, ctx)).join('')
}

function genNode(node, ctx) {
  if (node.type === 'text') return genText(node.value, ctx, node)
  if (node.type === 'element') return genElement(node, ctx)
  return ''
}

function genText(value, ctx, node) {
  return splitMustache(value)
    .map((p) => (p.text !== undefined ? escText(p.text) : `${DELIMITERS[0]} ${ctx.expr(p.expr, node)} ${DELIMITERS[1]}`))
    .join('')
}

function directives(node, ctx) {
  const get = (n) => node.attrs.find((a) => a.name === n)
  const out = { pre: [], cond: '' }
  const forAttr = get('wx:for') || get('wx:for-items')
  if (forAttr) {
    const item = (get('wx:for-item') || {}).value || 'item'
    const index = (get('wx:for-index') || {}).value || 'index'
    ctx.scopeNames.add(item)
    ctx.scopeNames.add(index)
    const keyAttr = get('wx:key')
    out.for = `(${item}, ${index}) in $mpList(${ctx.value(forAttr, node)})`
    out.key = keyAttr && keyAttr.value
      ? `$mpKey(${item}, ${index}, ${JSON.stringify(keyAttr.value.trim())})`
      : index
  }
  const ifAttr = get('wx:if')
  const elifAttr = get('wx:elif')
  if (ifAttr) out.cond = `v-if="${escAttr(ctx.value(ifAttr, node))}"`
  else if (elifAttr) out.cond = `v-else-if="${escAttr(ctx.value(elifAttr, node))}"`
  else if (get('wx:else')) out.cond = 'v-else'
  return out
}

/** 外层包一层 for（小程序里 wx:for 比 wx:if 先算，if 是逐项判断） */
function wrapDirectives(d, inner) {
  if (!d.for) return inner(d.cond)
  if (!d.cond) return inner(`v-for="${escAttr(d.for)}" :key="${escAttr(d.key)}"`)
  return `<template v-for="${escAttr(d.for)}" :key="${escAttr(d.key)}">${inner(d.cond)}</template>`
}

function genElement(node, ctx) {
  const name = node.name
  const d = directives(node, ctx)

  if (name === 'template') {
    const is = attrOf(node, 'is')
    if (is == null) return ''
    return wrapDirectives(d, (dir) => genTemplateUse(node, ctx, dir))
  }

  if (name === 'slot') {
    const slotName = attrOf(node, 'name')
    return slotName ? `<slot name="${escAttr(slotName)}"></slot>` : '<slot></slot>'
  }

  const isCustom = ctx.components.has(name)
  let tag
  let kind
  if (name === 'block') {
    tag = 'template'
    kind = 'block'
  } else if (isCustom) {
    tag = name
    kind = 'custom'
    ctx.usedComponents.add(name)
  } else if (BUILTIN[name]) {
    tag = BUILTIN[name]
    kind = tag.startsWith('mp-') ? 'builtin' : 'native'
  } else {
    ctx.warnings.push(`${ctx.at(node)}<${name}> 不是 H5 认识的组件，按 view 渲染`)
    tag = 'wx-view'
    kind = 'native'
  }

  const props = []
  const dataset = []
  const mpOn = []
  const hover = {}
  let longpress = null

  for (const attr of node.attrs) {
    const an = attr.name
    if (an.startsWith('wx:')) continue
    if (kind === 'block') continue

    if (an.startsWith('data-')) {
      dataset.push(`${JSON.stringify(camelDataset(an.slice(5)))}: ${ctx.value(attr, node)}`)
      continue
    }

    const ev = an.match(EVENT_RE)
    if (ev) {
      const mode = ev[1]
      const type = ev[2]
      const isCatch = mode.includes('catch')
      const handler = ctx.isDynamic(attr) ? ctx.value(attr, node) : JSON.stringify(attr.value.trim())
      const componentEvent =
        kind === 'custom' || (kind === 'builtin' && (COMPONENT_EVENTS[tag] || []).includes(type))
      if (componentEvent) {
        mpOn.push({ type, handler })
      } else if (type === 'tap') {
        const mods = (isCatch ? '.stop' : '') + (mode.startsWith('capture') ? '.capture' : '')
        props.push(`@click${mods}="$mpEv($event, 'tap', ${escAttr(handler)}, __DS__)"`)
        // 电脑上鼠标移上去变手形（shell.css 的 [mp-tap]）；只为挡住冒泡的空处理函数不算可点
        if (!NOOP_TAP.test(attr.value.trim())) props.push('mp-tap')
      } else if (type === 'longpress' || type === 'longtap') {
        longpress = { handler, isCatch }
      } else if (type === 'touchmove' && isCatch) {
        props.push(`@touchmove="$mpTouchCatch($event, ${escAttr(handler)}, __DS__)"`)
      } else {
        const mods = (isCatch ? '.stop' : '') + (mode.startsWith('capture') ? '.capture' : '')
        props.push(`@${type}${mods}="$mpEv($event, ${JSON.stringify(type).replace(/"/g, "'")}, ${escAttr(handler)}, __DS__)"`)
      }
      continue
    }

    if (an === 'class') {
      if (ctx.isDynamic(attr)) props.push(`:class="${escAttr(ctx.value(attr, node))}"`)
      else if (attr.value.trim()) props.push(`class="${escAttr(attr.value.trim())}"`)
      continue
    }
    if (an === 'style') {
      if (ctx.isDynamic(attr)) props.push(`:style="$rpx(${escAttr(ctx.value(attr, node))})"`)
      else if (attr.value.trim()) props.push(`style="${escAttr(convertUnits(attr.value.trim()))}"`)
      continue
    }
    if (an === 'hidden') {
      props.push(`:hidden="${escAttr(ctx.value(attr, node))}"`)
      continue
    }
    if (an === 'id') {
      props.push(ctx.isDynamic(attr) ? `:id="${escAttr(ctx.value(attr, node))}"` : `id="${escAttr(attr.value)}"`)
      continue
    }

    if (kind === 'native') {
      if (an === 'hover-class') hover.cls = ctx.value(attr, node)
      else if (an === 'hover-start-time') hover.start = ctx.value(attr, node)
      else if (an === 'hover-stay-time') hover.stay = ctx.value(attr, node)
      else if (an === 'hover-stop-propagation') hover.stop = ctx.value(attr, node)
      else if (an === 'aria-role') props.push(`role="${escAttr(attr.value)}"`)
      else if (an.startsWith('aria-') || NATIVE_KEEP.has(an)) {
        props.push(ctx.isDynamic(attr) ? `:${an}="${escAttr(ctx.value(attr, node))}"` : `${an}="${escAttr(attr.value)}"`)
      } else if (name === 'text' && (an === 'user-select' || an === 'selectable')) {
        props.push(`:class="${escAttr(`(${ctx.value(attr, node)}) ? 'wx-text--selectable' : ''`)}"`)
      } else if (name === 'text' && an === 'space') {
        props.push('style="white-space: pre-wrap"')
      }
      // 其余（decode / animation 等）在 H5 里没有对应，丢掉
      continue
    }

    if (an === 'placeholder-class' && attr.value) {
      for (const c of attr.value.split(/\s+/).filter(Boolean)) ctx.placeholderClasses.add(c)
    }
    props.push(`:${an}="${escAttr(ctx.value(attr, node))}"`)
  }

  const ds = dataset.length ? `{ ${dataset.join(', ')} }` : '{}'
  const finalProps = props.map((p) => p.replace(/__DS__/g, escAttr(ds)))
  if (mpOn.length) {
    const entries = mpOn.map(
      ({ type, handler }) => `${JSON.stringify(type)}: (d, e) => $mpCE(d, ${JSON.stringify(type)}, ${handler}, ${ds}, e)`,
    )
    finalProps.push(`:mp-on="${escAttr(`{ ${entries.join(', ')} }`)}"`)
  }
  if (Object.keys(hover).length) {
    const parts = Object.entries(hover).map(([k, v]) => `${k}: ${v}`)
    finalProps.push(`v-mp-hover="${escAttr(`{ ${parts.join(', ')} }`)}"`)
  }
  if (longpress) {
    finalProps.push(
      `v-mp-longpress="${escAttr(`{ stop: ${longpress.isCatch}, fn: (e) => $mpEv(e, 'longpress', ${longpress.handler}, ${ds}) }`)}"`,
    )
  }

  const children = genChildren(node.children, ctx)
  return wrapDirectives(d, (dir) => {
    const head = [tag, dir, ...finalProps].filter(Boolean).join(' ')
    return `<${head}>${children}</${tag}>`
  })
}

function genTemplateUse(node, ctx, dir) {
  const is = attrOf(node, 'is')
  if (/\{\{/.test(is)) throw new Error(`${ctx.at(node)}H5 暂不支持动态 <template is>`)
  const def = ctx.templates.get(is)
  if (!def) throw new Error(`${ctx.at(node)}找不到 <template name="${is}">`)
  const dataAttr = node.attrs.find((a) => a.name === 'data')
  let head = ''
  if (dataAttr && dataAttr.value.trim()) {
    const parts = splitMustache(dataAttr.value.trim())
    if (parts.length !== 1 || parts[0].expr === undefined) {
      throw new Error(`${ctx.at(node)}template data 必须是一个 {{…}}`)
    }
    const { expr, keys, hasSpread } = templateDataExpr(parts[0].expr, ctx.at(node), ctx.identifiers)
    for (const k of keys) ctx.scopeNames.add(k)
    if (hasSpread) throw new Error(`${ctx.at(node)}H5 暂不支持 template data 里的 ...展开`)
    if (keys.length) head = `v-for="${escAttr(`{ ${keys.join(', ')} } in [${expr}]`)}" :key="0"`
  }
  const body = genChildren(def.children, ctx)
  if (!head) return dir ? `<template ${dir}>${body}</template>` : body
  if (!dir) return `<template ${head}>${body}</template>`
  return `<template ${dir}><template ${head}>${body}</template></template>`
}

/**
 * @returns {{ template: string, wxs: {module: string, src: string}[], placeholderClasses: Set<string>, warnings: string[] }}
 */
// 模板里出现、但不是页面数据的名字
const TEMPLATE_GLOBALS = new Set([
  'Infinity', 'undefined', 'NaN', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'decodeURI',
  'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'Math', 'Number', 'Date', 'Array', 'Object',
  'Boolean', 'String', 'RegExp', 'Map', 'Set', 'JSON', 'Intl', 'BigInt', 'console', 'Error', 'Symbol',
])

export function compileWxml(source, { file, components, where, rootTag, rootClass }) {
  const ctx = new Ctx({ file, components, where })
  const root = parseWxml(source)
  collect(root, ctx)
  const body = genChildren(root.children, ctx)
  const cls = rootClass ? ` class="${rootClass}"` : ''
  // 模板用到的数据字段：页面 data 里一开始没有、等 setData 才加的，运行时先占位成 undefined——
  // Vue 追踪不到「后来才加进来的属性」，只加新字段的那次 setData 不会触发重渲染
  const wxsNames = new Set(ctx.wxs.map((w) => w.module))
  const dataKeys = [...ctx.identifiers].filter((n) => !ctx.scopeNames.has(n) && !wxsNames.has(n) && !TEMPLATE_GLOBALS.has(n))
  return {
    template: `<${rootTag}${cls}>${body}</${rootTag}>`,
    wxs: ctx.wxs,
    dataKeys,
    usedComponents: ctx.usedComponents,
    placeholderClasses: ctx.placeholderClasses,
    warnings: ctx.warnings,
  }
}

/** 扫一遍 WXML 拿 placeholder-class，用于给样式补 ::placeholder 规则 */
export function scanPlaceholderClasses(source, out) {
  for (const m of source.matchAll(/placeholder-class\s*=\s*"([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/).filter(Boolean)) out.add(c)
  }
  return out
}

export function resolveWxsPath(fromLogical, src) {
  const target = src.startsWith('/') ? src.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(fromLogical), src))
  return target
}
