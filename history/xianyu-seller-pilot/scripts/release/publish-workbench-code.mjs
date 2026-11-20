#!/usr/bin/env node
// 生成「闲鱼行情工作台」代码热更新包：把 out/ 打成带 MD5 清单的静态目录。
//
// 产物落在 release-workbench/code/，目录结构就是服务器静态目录该有的样子：
//   market-workbench-code-version.json   清单（客户端只认这一个入口）
//   main/index.js  preload/index.js  renderer/**   与安装包内 out/ 一一对应
//
// 用法：
//   node scripts/release/publish-workbench-code.mjs --notes "这版改了什么"
//   node scripts/release/publish-workbench-code.mjs --code-version 3 --version-name 0.2.3
//
// codeVersion 必须严格递增：客户端只比它，versionName 只是给人看的。
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const OUT_DIR = join(root, 'out')
const STAGE_DIR = join(root, 'release-workbench', 'code')
const MANIFEST_NAME = 'market-workbench-code-version.json'

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

function walk(dir, base = dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(full, base))
    // 清单里的路径统一用正斜杠：客户端要拿它拼 URL，也要按 '/' 切开落盘
    else if (entry.isFile()) files.push(relative(base, full).split(sep).join('/'))
  }
  return files
}

const builtin = JSON.parse(readFileSync(join(root, 'code-version.json'), 'utf8'))
const versionName = arg('version-name', builtin.versionName)
const codeVersion = Number(arg('code-version', builtin.codeVersion))
const notes = arg('notes', '')

if (!Number.isInteger(codeVersion) || codeVersion <= 0) {
  console.error('codeVersion 必须是正整数')
  process.exit(1)
}
try {
  statSync(OUT_DIR)
} catch {
  console.error('out/ 不存在，先跑 npm run build')
  process.exit(1)
}

rmSync(STAGE_DIR, { recursive: true, force: true })
mkdirSync(STAGE_DIR, { recursive: true })

const files = {}
let bytes = 0
for (const rel of walk(OUT_DIR).sort()) {
  const buf = readFileSync(join(OUT_DIR, rel))
  files[rel] = createHash('md5').update(buf).digest('hex')
  bytes += buf.length
  const target = join(STAGE_DIR, rel)
  mkdirSync(dirname(target), { recursive: true })
  cpSync(join(OUT_DIR, rel), target)
}

const manifest = { product: '闲鱼行情工作台 代码热更新', versionName, codeVersion, updatedAt: new Date().toISOString().slice(0, 10), notes, files }
writeFileSync(join(STAGE_DIR, MANIFEST_NAME), JSON.stringify(manifest, null, 2))
// 同步安装包内置版本号，保证「新装的包」不会立刻又提示更新
writeFileSync(join(root, 'code-version.json'), JSON.stringify({ versionName, codeVersion }, null, 2) + '\n')

console.log(`代码包已生成：${STAGE_DIR}`)
console.log(`  版本 ${versionName}（codeVersion ${codeVersion}）· ${Object.keys(files).length} 个文件 · ${(bytes / 1048576).toFixed(1)}MB`)
// 不带 --delete：老客户端点「下载更新」用的是启动时取的旧清单（下载前现取清单是后补的），发版时
// 把旧文件删掉，开着没重启的那批就会 404（2026-10-06 v26 上线时实测）。文件名带
// 内容哈希，留着旧的不会和新版冲突，攒多了再手工清。
// 分两步、清单最后传：main/index.js 等几个文件名每版不变，清单先到的话，正好这时来取的
// 客户端会拿新清单去下旧文件，MD5 对不上。
console.log('上传（先文件、后清单）：')
console.log(`  rsync -rc --exclude='${MANIFEST_NAME}' release-workbench/code/ erp-txy:/www/wwwroot/gc-app/market-workbench-code/`)
console.log(`  rsync -c release-workbench/code/${MANIFEST_NAME} erp-txy:/www/wwwroot/gc-app/market-workbench-code/`)
