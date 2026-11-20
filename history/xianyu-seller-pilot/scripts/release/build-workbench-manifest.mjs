#!/usr/bin/env node
// 生成安装包分发清单 market-workbench-version.json（下载页和「换机重装」用）。
// 代码热更新有自己的清单，见 publish-workbench-code.mjs——两者互不相干：
// 这份管 dmg，那份管免重装的代码更新。
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const BASE = 'http://127.0.0.1:8000'

const arches = [
  { key: 'darwin-arm64', suffix: 'arm64', latest: 'market-workbench-latest-arm64.dmg' },
  { key: 'darwin-x64', suffix: 'x64', latest: 'market-workbench-latest-x64.dmg' }
]

const files = {}
for (const arch of arches) {
  const local = join(root, 'release-workbench', `闲鱼行情工作台-${version}-${arch.suffix}.dmg`)
  const buf = readFileSync(local)
  files[arch.key] = {
    file: `market-workbench-${version}-${arch.suffix}.dmg`,
    url: `${BASE}/${arch.latest}`,
    md5: createHash('md5').update(buf).digest('hex'),
    size: statSync(local).size
  }
}

const manifest = {
  app: '闲鱼行情工作台',
  appId: 'com.erp.xianyu.workbench',
  versionName: version,
  platform: 'darwin-x64',
  signed: false,
  url: `${BASE}/market-workbench-latest.dmg`,
  md5: files['darwin-x64'].md5,
  size: files['darwin-x64'].size,
  files,
  builtAt: new Date().toISOString(),
  note: '未签名，首次打开需右键→打开，或 xattr -dr com.apple.quarantine /Applications/闲鱼行情工作台.app；装好后应用内可直接「检查更新」，之后不用再下载安装包'
}
const out = join(root, 'release-workbench', 'market-workbench-version.json')
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n')
console.log(`清单已生成：${out}`)
for (const [key, value] of Object.entries(files)) console.log(`  ${key}  ${value.file}  ${(value.size / 1048576).toFixed(1)}MB  md5=${value.md5}`)
