// 构建前体检：把 miniprogram/ 的每个页面、组件、样式、脚本都过一遍 H5 编译器，
// 再扫一遍用到的 wx.* 接口和组件标签，H5 没实现的列出来。
// 编译失败 → 退出码 1（构建中止）；只是用了 H5 没实现的接口 → 打印警告，不拦构建。
import fs from 'node:fs'
import path from 'node:path'
import { compileTemplate, compileStyle } from '@vue/compiler-sfc'
import { DESKTOP_ROOT, MP_ROOT, OVERRIDE_ROOT, existsLogical, loadPatches, logicalOf, physical, readJsonLogical, readLogical, scopeIdOf } from '../compiler/paths.js'
import { DELIMITERS, compileWxml, scanPlaceholderClasses } from '../compiler/wxml.js'
import { compileWxss } from '../compiler/wxss.js'
import { transformCjs } from '../compiler/cjs.js'
import { WX_APIS } from '../src/runtime/wx/names.js'

const KNOWN_TAGS = new Set([
  'view', 'text', 'image', 'input', 'textarea', 'button', 'picker', 'switch', 'scroll-view', 'video',
  'picker-view', 'picker-view-column', 'navigator', 'block', 'template', 'wxs', 'slot',
])

function walk(dir, ext, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(full, ext, out)
    else if (ent.name.endsWith(ext)) out.push(full)
  }
  return out
}

const errors = []
const warnings = []
const appJson = readJsonLogical('app.json')
const aliases = appJson.resolveAlias || {}

const placeholderClasses = new Set()
for (const f of walk(MP_ROOT, '.wxml')) scanPlaceholderClasses(fs.readFileSync(f, 'utf8'), placeholderClasses)

// 页面 + 组件
const views = new Set(appJson.pages.map((p) => ({ base: p, kind: 'page' })).map((v) => JSON.stringify(v)))
for (const f of walk(MP_ROOT, '.json')) {
  const logical = logicalOf(f)
  if (!logical.startsWith('components/') && !logical.startsWith('custom-tab-bar/')) continue
  views.add(JSON.stringify({ base: logical.replace(/\.json$/, ''), kind: 'component' }))
}

const hostOfTag = { 'custom-tab-bar': 'custom-tab-bar' }
for (const v of views) {
  const { base } = JSON.parse(v)
  const json = readJsonLogical(`${base}.json`)
  for (const [tag, spec] of Object.entries({ ...(appJson.usingComponents || {}), ...(json.usingComponents || {}) })) {
    hostOfTag[tag] = path.posix.basename(spec) === 'index' ? path.posix.basename(path.posix.dirname(spec)) : path.posix.basename(spec)
  }
}

let viewCount = 0
for (const v of views) {
  const { base, kind } = JSON.parse(v)
  viewCount++
  const where = `miniprogram/${base}`
  try {
    const json = readJsonLogical(`${base}.json`)
    const using = { ...(appJson.usingComponents || {}), ...(json.usingComponents || {}) }
    const out = compileWxml(readLogical(`${base}.wxml`), {
      file: physical(`${base}.wxml`),
      components: Object.keys(using),
      where: `${where}.wxml`,
      rootTag: kind === 'page' ? 'wx-page' : 'wx-x',
    })
    warnings.push(...out.warnings)
    const tpl = compileTemplate({
      source: out.template,
      filename: `${base}.wxml`,
      id: scopeIdOf(base),
      scoped: true,
      compilerOptions: { isCustomElement: (t) => t.startsWith('wx-'), whitespace: 'condense', delimiters: DELIMITERS },
    })
    for (const e of tpl.errors || []) errors.push(`${where}.wxml：${typeof e === 'string' ? e : e.message}`)
  } catch (e) {
    errors.push(e.message)
  }
  if (existsLogical(`${base}.wxss`)) {
    try {
      const { css } = compileWxss(`${base}.wxss`, { componentTags: Object.keys(hostOfTag), placeholderClasses, hostOfTag })
      const res = compileStyle({ source: css, filename: `${base}.wxss`, id: scopeIdOf(base), scoped: true })
      for (const e of res.errors || []) errors.push(`${where}.wxss：${e.message}`)
    } catch (e) {
      errors.push(`${where}.wxss：${e.message}`)
    }
  }
}
// 电脑版模板（src/desktop/**.wxml）：同样过一遍编译器；再对一下模板里绑的事件，页面（或 .desktop.js）里得有这个方法——
// 电脑版只调原页面的方法，小程序那边改了方法名，这里是唯一能提前发现的地方
const pageBases = new Set([...views].map((v) => JSON.parse(v)).filter((v) => v.kind === 'page').map((v) => v.base))
const METHOD_RE = /^\s{2,4}(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:\(|:\s*(?:async\s+)?(?:function\b|\())/gm
const EVENT_ATTR_RE = /\s(?:bind|catch|capture-bind|capture-catch|mut-bind):?[A-Za-z_][\w-]*="([A-Za-z_$][\w$]*)"/g
let desktopCount = 0
for (const f of walk(DESKTOP_ROOT, '.wxml')) {
  const base = path.relative(DESKTOP_ROOT, f).split(path.sep).join('/').replace(/\.wxml$/, '')
  const where = `h5/src/desktop/${base}.wxml`
  desktopCount++
  if (!pageBases.has(base)) {
    errors.push(`${where}：app.json 里没有页面 ${base}（路径写错了？）`)
    continue
  }
  const source = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')
  try {
    const json = readJsonLogical(`${base}.json`)
    const using = { ...(appJson.usingComponents || {}), ...(json.usingComponents || {}) }
    const out = compileWxml(source, { file: f, components: Object.keys(using), where, rootTag: 'wx-page' })
    warnings.push(...out.warnings)
    const tpl = compileTemplate({
      source: out.template,
      filename: `${base}.wxml`,
      id: scopeIdOf(base),
      scoped: true,
      compilerOptions: { isCustomElement: (t) => t.startsWith('wx-'), whitespace: 'condense', delimiters: DELIMITERS },
    })
    for (const e of tpl.errors || []) errors.push(`${where}：${typeof e === 'string' ? e : e.message}`)
  } catch (e) {
    errors.push(e.message)
  }
  const methods = new Set()
  const sources = [readLogical(`${base}.js`)]
  const mixin = path.join(DESKTOP_ROOT, `${base}.desktop.js`)
  if (fs.existsSync(mixin)) {
    sources.push(fs.readFileSync(mixin, 'utf8'))
    // 引进来的公共方法（desktopPager、commonMethods）
    sources.push(fs.readFileSync(path.join(DESKTOP_ROOT, 'lib', 'pager.js'), 'utf8'))
  }
  for (const src of sources) for (const m of src.matchAll(METHOD_RE)) methods.add(m[1])
  for (const m of source.matchAll(EVENT_ATTR_RE)) {
    if (!methods.has(m[1])) warnings.push(`${where}：绑了 ${m[1]}，页面和 .desktop.js 里都没找到这个方法（小程序那边改名了？）`)
  }
}

try {
  compileWxss('app.wxss', { componentTags: Object.keys(hostOfTag), placeholderClasses, hostOfTag })
} catch (e) {
  errors.push(`miniprogram/app.wxss：${e.message}`)
}

// 脚本 + 接口
const usedApis = new Map()
const jsFiles = [...walk(MP_ROOT, '.js'), ...walk(MP_ROOT, '.wxs'), ...walk(OVERRIDE_ROOT, '.js')]
for (const f of jsFiles) {
  const code = fs.readFileSync(f, 'utf8')
  try {
    transformCjs(code, f, aliases, { wxs: f.endsWith('.wxs') })
  } catch (e) {
    errors.push(e.message)
  }
  if (f.startsWith(OVERRIDE_ROOT)) continue
  // 被替换件顶掉的源文件不算（比如 services/auth.js 里的 wx.login）
  if (fs.existsSync(path.join(OVERRIDE_ROOT, logicalOf(f)))) continue
  for (const m of code.matchAll(/\bwx\.([a-zA-Z_]\w*)/g)) {
    if (!usedApis.has(m[1])) usedApis.set(m[1], logicalOf(f))
  }
}
for (const [api, where] of usedApis) {
  if (!WX_APIS.has(api)) warnings.push(`wx.${api}（${where}）H5 没有实现，调用时会提示「H5 暂不支持」`)
}

// 标签
for (const f of walk(MP_ROOT, '.wxml')) {
  const src = fs.readFileSync(f, 'utf8')
  for (const m of src.matchAll(/<([a-z][\w-]*)/g)) {
    const tag = m[1]
    if (!KNOWN_TAGS.has(tag) && !hostOfTag[tag]) warnings.push(`<${tag}>（${logicalOf(f)}）H5 没有对应组件，按 view 渲染`)
  }
}

// 文案补丁：小程序原文改了，补丁就对不上了
for (const p of loadPatches()) {
  const file = path.join(MP_ROOT, p.file)
  if (!fs.existsSync(file) || !fs.readFileSync(file, 'utf8').includes(p.from)) {
    warnings.push(`文案补丁对不上：miniprogram/${p.file} 里已经没有「${p.from}」，看看 src/overrides/patches.json 要不要跟着改`)
  }
}

const uniq = (arr) => [...new Set(arr)]
for (const w of uniq(warnings)) console.warn(`⚠ ${w}`)
if (errors.length) {
  for (const e of uniq(errors)) console.error(`✗ ${e}`)
  console.error(`\n体检没过：${uniq(errors).length} 处编译错误`)
  process.exit(1)
}
console.log(`✓ 体检通过：${viewCount} 个页面/组件，${desktopCount} 个电脑版模板，${jsFiles.length} 个脚本，${usedApis.size} 个 wx 接口`)
