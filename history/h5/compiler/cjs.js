import path from 'node:path'
import { RUNTIME_ROOT, existsLogical, logicalOf, physical, toPosix } from './paths.js'

// 小程序的 JS 是 CommonJS：require / module.exports，外加全局的 Page / Component / App / wx / getApp。
// 这里把每个文件包成 ES 模块：
//   - 静态 require('x') 在构建期解析成 import（含 app.json 的 resolveAlias、省略 .js、目录 index.js）
//   - require 改成按需取值的函数，所以 request.js 里那种「函数内延迟 require 防循环」照样成立
//   - Page/Component/App 是本文件内的局部函数，只记下传进来的配置，由页面模块交给运行时
// 包装代码全部挤在第一行，原文件的行号不变，报错栈能直接对回小程序源码。

const REQUIRE_RE = /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g

function matchAlias(spec, aliases) {
  for (const [pattern, target] of Object.entries(aliases || {})) {
    if (pattern.endsWith('/*') && target.endsWith('/*')) {
      const prefix = pattern.slice(0, -1)
      if (spec.startsWith(prefix)) return target.slice(0, -1) + spec.slice(prefix.length)
    } else if (spec === pattern) {
      return target
    }
  }
  return null
}

export function resolveRequire(spec, fromLogical, aliases) {
  let target = matchAlias(spec, aliases)
  if (target == null) {
    if (spec.startsWith('/')) target = spec.slice(1)
    else if (spec.startsWith('.')) target = path.posix.normalize(path.posix.join(path.posix.dirname(fromLogical), spec))
    else return null
  }
  target = target.replace(/^\/+/, '')
  const candidates = path.posix.extname(target) ? [target] : [`${target}.js`, `${target}/index.js`]
  return candidates.find((c) => existsLogical(c)) || null
}

export function transformCjs(code, file, aliases, { wxs = false } = {}) {
  const logical = logicalOf(file)
  const source = code.replace(/^\uFEFF/, '')
  const specs = new Map()
  for (const m of source.matchAll(REQUIRE_RE)) {
    const spec = m[2]
    if (specs.has(spec)) continue
    const target = resolveRequire(spec, logical, aliases)
    if (!target) throw new Error(`${logical}：require('${spec}') 找不到对应文件`)
    specs.set(spec, toPosix(physical(target)) + (target.endsWith('.wxs') ? '?mp-wxs' : ''))
  }
  const globals = toPosix(path.join(RUNTIME_ROOT, 'globals.js'))
  const head = [
    `import { wx, getApp, getCurrentPages, Behavior, getDate, getRegExp } from ${JSON.stringify(globals)};`,
    ...[...specs.values()].map((id, i) => `import __mpReq${i} from ${JSON.stringify(id)};`),
    `const __mpReqs = { ${[...specs.keys()].map((s, i) => `${JSON.stringify(s)}: () => __mpReq${i}`).join(', ')} };`,
    'const module = { exports: {} }; let exports = module.exports;',
    `function require(p) { const g = __mpReqs[p]; if (!g) throw new Error('[H5] require 没能在构建期解析：' + p + '（${logical}）'); return g(); }`,
    'let __mpDef = null;',
    "function Page(o) { __mpDef = { type: 'page', options: o || {} }; }",
    "function Component(o) { __mpDef = { type: 'component', options: o || {} }; }",
    "function App(o) { __mpDef = { type: 'app', options: o || {} }; }",
  ]
  if (wxs) head.push('void getDate; void getRegExp;')
  return `${head.join(' ')}${source}\n;export default module.exports;\nexport const __mp = __mpDef;\n`
}
