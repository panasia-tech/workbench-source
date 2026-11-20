import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const H5_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_ROOT = path.resolve(H5_ROOT, '..')
export const MP_ROOT = path.join(REPO_ROOT, 'miniprogram')
// H5 专用替换件：与 miniprogram/ 同构，按文件覆盖（只放 H5 必须不同的那几个文件）
export const OVERRIDE_ROOT = path.join(H5_ROOT, 'src', 'overrides')
export const RUNTIME_ROOT = path.join(H5_ROOT, 'src', 'runtime')
// 电脑端补充样式：与 miniprogram/ 同构，有同名 .wxss 就接在原样式（或替换件）后面一起编译。
// 只放宽屏用的规则（包在 @media (min-width: 1024px) 里），手机上不起作用
export const DESKTOP_ROOT = path.join(H5_ROOT, 'src', 'desktop')

export const toPosix = (p) => p.split(path.sep).join('/')

export function isUnder(file, dir) {
  // Vite/Rolldown 在 Windows 上也传正斜杠，而 path.join 给反斜杠；统一成正斜杠再比。
  const f = toPosix(file)
  const d = toPosix(dir)
  return f === d || f.startsWith(d + '/')
}

/** 小程序源码或替换件（含电脑端补充样式） */
export function isMpSource(file) {
  return isUnder(file, MP_ROOT) || isUnder(file, OVERRIDE_ROOT) || isUnder(file, DESKTOP_ROOT)
}

/** 物理路径 → 小程序内的逻辑路径（'pages/a/index.js'）。替换件按它顶替的那个文件算。 */
export function logicalOf(file) {
  const base = isUnder(file, OVERRIDE_ROOT) ? OVERRIDE_ROOT : MP_ROOT
  return toPosix(path.relative(base, file))
}

export function existsLogical(logical) {
  return fs.existsSync(path.join(OVERRIDE_ROOT, logical)) || fs.existsSync(path.join(MP_ROOT, logical))
}

/** 逻辑路径 → 物理路径：有替换件用替换件，否则用小程序原文件 */
export function physical(logical) {
  const o = path.join(OVERRIDE_ROOT, logical)
  return fs.existsSync(o) ? o : path.join(MP_ROOT, logical)
}

// H5 \u7684\u6587\u6848\u8865\u4E01\uFF08src/overrides/patches.json\uFF09\uFF1A\u6574\u9875\u66FF\u6362\u592A\u91CD\u3001\u53EA\u5DEE\u51E0\u4E2A\u5B57\u7684\u5730\u65B9\u7528\u5B83\uFF0C
// \u6BD4\u5982\u5C0F\u7A0B\u5E8F\u91CC\u5199\u7740\u300C\u91CD\u65B0\u7ED1\u5B9A\u5FAE\u4FE1\u300D\uFF0CH5 \u6CA1\u6709\u5FAE\u4FE1\u3002\u539F\u6587\u6539\u4E86\u5BF9\u4E0D\u4E0A\u65F6 check-compat \u4F1A\u62A5\u3002
const PATCH_FILE = path.join(OVERRIDE_ROOT, 'patches.json')
let patchCache = null

export function loadPatches() {
  if (!patchCache) patchCache = fs.existsSync(PATCH_FILE) ? JSON.parse(fs.readFileSync(PATCH_FILE, 'utf8')) : []
  return patchCache
}

export function resetPatches() {
  patchCache = null
}

export function readLogical(logical) {
  let text = fs.readFileSync(physical(logical), 'utf8').replace(/^\uFEFF/, '')
  for (const p of loadPatches()) {
    if (p.file === logical && text.includes(p.from)) text = text.split(p.from).join(p.to)
  }
  return text
}

export function readJsonLogical(logical, fallback = {}) {
  if (!existsLogical(logical)) return fallback
  try {
    return JSON.parse(readLogical(logical))
  } catch (e) {
    throw new Error(`${logical} 不是合法 JSON：${e.message}`)
  }
}

export function scopeIdOf(logicalBase) {
  return 'data-v-' + crypto.createHash('md5').update(logicalBase).digest('hex').slice(0, 8)
}
