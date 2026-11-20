import fs from 'node:fs'
import path from 'node:path'
import { MP_ROOT, DESKTOP_ROOT, readLogical, existsLogical } from './paths.js'

// WXSS → CSS
// 1. @import 就地展开（小程序的 @import 是文本包含，不是 CSS 的运行时导入）
// 2. rpx → calc(N * var(--rpx))：--rpx 在 base.css 里按 750 设计宽定义，跟屏宽走，和小程序一致
//    vh → --mp-vh：小程序的 100vh 是导航栏以下的高度，H5 的视口里还多一条导航栏
// 3. 标签选择器换成 H5 里对应的元素：view → wx-view，page → wx-page，自定义组件宿主 → wx-<名字>
// 4. placeholder-class 用到的类，额外生成一条 .wx-ph--类名::placeholder
// 5. h5/src/desktop/ 下有同名文件（电脑端补充样式）就接在后面，同样换单位、同样 scoped

const BUILTIN_TAGS = {
  page: 'wx-page',
  view: 'wx-view',
  text: 'wx-text',
  image: 'wx-image',
  button: 'wx-button',
  input: '.wx-input',
  textarea: '.wx-textarea',
  picker: 'wx-picker',
  switch: 'wx-switch',
  'scroll-view': 'wx-scroll-view',
  video: 'wx-video',
  'picker-view': 'wx-picker-view',
  'picker-view-column': 'wx-picker-view-column',
  navigator: 'wx-navigator',
  icon: 'wx-icon',
}

const NUM = String.raw`(-?(?:\d+\.?\d*|\.\d+))`
const RPX_RE = new RegExp(String.raw`(?<![\w.#-])` + NUM + String.raw`rpx\b`, 'g')
const VH_RE = new RegExp(String.raw`(?<![\w.#-])` + NUM + String.raw`vh\b`, 'g')

export function convertUnits(text) {
  // 跳过字符串和 url(...)，只换其余部分
  return text.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|url\([^)]*\))|([^"'u]+|u)/g, (m, skip, body) => {
    if (skip) return skip
    return body
      .replace(RPX_RE, (_, n) => `calc(${n} * var(--rpx))`)
      .replace(VH_RE, (_, n) => `calc(${n} * var(--mp-vh, 1vh))`)
  })
}

function tagRegex(names) {
  const sorted = [...names].sort((a, b) => b.length - a.length).map((n) => n.replace(/[-]/g, '\\-'))
  return new RegExp(String.raw`(^|[\s>+~,(])(` + sorted.join('|') + String.raw`)(?=$|[\s>+~,.:#\[)])`, 'g')
}

function mapSelector(selector, tagMap, tagRe) {
  return selector.replace(tagRe, (m, pre, name) => pre + tagMap[name])
}

// 找到与 open 处 '{' 匹配的 '}'，跳过字符串和注释
function matchBrace(css, open) {
  let depth = 0
  for (let i = open; i < css.length; i++) {
    const c = css[i]
    if (c === '"' || c === "'") {
      i = skipString(css, i)
    } else if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      i = end < 0 ? css.length : end + 1
    } else if (c === '{') {
      depth++
    } else if (c === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return css.length - 1
}

function skipString(css, i) {
  const q = css[i]
  for (let j = i + 1; j < css.length; j++) {
    if (css[j] === '\\') { j++; continue }
    if (css[j] === q) return j
  }
  return css.length - 1
}

// 读到下一个 '{' 或 ';'（顶层，跳过字符串/注释/括号）
function readPrelude(css, i) {
  let paren = 0
  for (let j = i; j < css.length; j++) {
    const c = css[j]
    if (c === '"' || c === "'") j = skipString(css, j)
    else if (c === '/' && css[j + 1] === '*') {
      const end = css.indexOf('*/', j + 2)
      j = end < 0 ? css.length : end + 1
    } else if (c === '(') paren++
    else if (c === ')') paren--
    else if (paren === 0 && (c === '{' || c === ';' || c === '}')) return j
  }
  return css.length
}

const NESTED_AT = new Set(['media', 'supports', 'document', 'container', 'layer'])

function transformRules(css, opts) {
  let out = ''
  let i = 0
  while (i < css.length) {
    const c = css[i]
    if (/\s/.test(c)) { out += c; i++; continue }
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      const stop = end < 0 ? css.length : end + 2
      out += css.slice(i, stop)
      i = stop
      continue
    }
    if (c === '}') { i++; continue } // 多余的右括号，丢掉
    const stop = readPrelude(css, i)
    const prelude = css.slice(i, stop)
    if (stop >= css.length) { out += prelude; break }
    if (css[stop] === ';' || css[stop] === '}') {
      out += prelude + (css[stop] === ';' ? ';' : '')
      i = stop + 1
      continue
    }
    const close = matchBrace(css, stop)
    const inner = css.slice(stop + 1, close)
    if (prelude.trim().startsWith('@')) {
      const name = (prelude.trim().match(/^@([\w-]+)/) || [])[1] || ''
      const head = convertUnits(prelude)
      if (NESTED_AT.has(name)) out += `${head}{${transformRules(inner, opts)}}`
      else out += `${head}{${convertUnits(inner)}}`
    } else {
      const decls = convertUnits(inner)
      out += `${mapSelector(prelude, opts.tagMap, opts.tagRe)}{${decls}}`
      if (opts.placeholderClasses.size) {
        for (const sel of prelude.split(',')) {
          const m = sel.trim().match(/^\.([\w-]+)$/)
          if (m && opts.placeholderClasses.has(m[1])) out += `\n.wx-ph--${m[1]}::placeholder{${decls}}`
        }
      }
    }
    i = close + 1
  }
  return out
}

const IMPORT_RE = /@import\s+(?:url\()?\s*(['"])([^'"]+)\1\s*\)?\s*;?/g

/**
 * 展开 @import。替换件里可以写 @import "mp:pages/bind/index.wxss"; 取小程序原文件（绕过替换件），
 * 方便只在原样式上追加几条。
 */
export function inlineImports(logical, seen = new Set(), raw = false, deps = []) {
  const key = (raw ? 'mp:' : '') + logical
  if (seen.has(key)) return ''
  seen.add(key)
  let css
  if (raw) {
    const file = path.join(MP_ROOT, logical)
    css = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    deps.push(file)
  } else {
    if (!existsLogical(logical)) throw new Error(`找不到样式文件 ${logical}`)
    css = readLogical(logical)
    deps.push(logical)
  }
  return css.replace(IMPORT_RE, (m, q, spec) => {
    if (spec.startsWith('mp:')) return inlineImports(spec.slice(3), seen, true, deps)
    let target = spec.startsWith('/') ? spec.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(logical), spec))
    if (!path.posix.extname(target)) target += '.wxss'
    return inlineImports(target, seen, false, deps)
  })
}

export function compileWxss(logical, { componentTags = [], placeholderClasses = new Set(), hostOfTag = {} } = {}) {
  const deps = []
  // 小程序那边没有这份样式、只有电脑版补充样式的页面：原样式当空的
  const desktop = path.join(DESKTOP_ROOT, logical)
  let source = existsLogical(logical) || !fs.existsSync(desktop) ? inlineImports(logical, new Set(), false, deps) : ''
  if (fs.existsSync(desktop)) {
    source += '\n' + fs.readFileSync(desktop, 'utf8').replace(/^\uFEFF/, '')
    deps.push(desktop)
  }
  const tagMap = { ...BUILTIN_TAGS }
  for (const t of componentTags) tagMap[t] = `wx-${hostOfTag[t] || t}`
  const css = transformRules(source, { tagMap, tagRe: tagRegex(Object.keys(tagMap)), placeholderClasses })
  return { css, deps }
}
