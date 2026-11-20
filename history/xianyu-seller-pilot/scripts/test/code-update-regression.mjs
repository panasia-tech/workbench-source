// 代码热更新回归：清单校验、路径越界、下载落位与回滚。
// 全部用注入的 fetch 和临时目录跑，不碰真服务器、不碰真 userData。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertSafeRelPath,
  downloadCodeUpdate,
  parseCodeManifest,
  readCurrentVersion,
  rollbackCodeUpdate,
  shouldUpdate
} from '../../src/main/code-update.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const md5 = (value) => createHash('md5').update(value).digest('hex')

// ---- 清单是不可信输入：缺字段、假 MD5、越界路径全部拒绝 ----
const good = { versionName: '0.2.3', codeVersion: 2, files: { 'main/index.js': md5('main') } }
assert.equal(parseCodeManifest(good).codeVersion, 2)
assert.equal(parseCodeManifest(JSON.stringify(good)).versionName, '0.2.3')
assert.throws(() => parseCodeManifest({ ...good, codeVersion: 0 }), /codeVersion/)
assert.throws(() => parseCodeManifest({ ...good, versionName: '' }), /versionName/)
assert.throws(() => parseCodeManifest({ ...good, files: {} }), /没有文件/)
assert.throws(() => parseCodeManifest({ ...good, files: { 'main/index.js': 'not-a-md5' } }), /MD5/)

// 一份被改过的清单不能靠路径把文件写到 userData 之外
for (const evil of ['../evil.js', '/etc/passwd', 'C:\\evil.js', 'a\\b.js', 'a/../../b.js', '', './x.js']) {
  assert.throws(() => assertSafeRelPath(evil), Error, `必须拒绝越界路径: ${evil}`)
}
assert.equal(assertSafeRelPath('renderer/assets/index-abc.js'), 'renderer/assets/index-abc.js')

// ---- 只认 codeVersion 严格变大；versionName 的字典序不参与判断 ----
assert.equal(shouldUpdate({ codeVersion: 1 }, { codeVersion: 2 }), true)
assert.equal(shouldUpdate({ codeVersion: 2 }, { codeVersion: 2 }), false)
assert.equal(shouldUpdate({ codeVersion: 3 }, { codeVersion: 2 }), false)
assert.equal(
  shouldUpdate({ versionName: '0.2.9', codeVersion: 9 }, { versionName: '0.2.10', codeVersion: 10 }),
  true,
  'codeVersion 递增即可，不能退化成字符串比较'
)

// ---- 下载落位 ----
const workdir = mkdtempSync(join(tmpdir(), 'wb-code-'))
const payload = { 'main/index.js': 'console.log("v2")', 'renderer/index.html': '<html>v2</html>' }
const manifest = parseCodeManifest({
  versionName: '0.2.3',
  codeVersion: 2,
  files: Object.fromEntries(Object.entries(payload).map(([rel, body]) => [rel, md5(body)]))
})
const fakeFetch = (bodies) => async (url) => {
  const rel = url.replace(/^https?:\/\/[^/]+\/[^?]*?([^/]+(?:\/[^/]+)*)$/, '$1')
  const key = Object.keys(bodies).find((name) => url.endsWith(name))
  if (!key) throw new Error(`未预期的下载: ${rel}`)
  const body = bodies[key]
  if (body instanceof Error) throw body
  return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(body) }
}

// 先放一份"旧代码"，用来验证成功后被替换、失败后原封不动
mkdirSync(join(workdir, 'code', 'main'), { recursive: true })
writeFileSync(join(workdir, 'code', 'main', 'index.js'), 'console.log("v1")')
writeFileSync(join(workdir, 'code', 'code-version.json'), JSON.stringify({ versionName: '0.2.2', codeVersion: 1 }))

const ok = await downloadCodeUpdate({ manifest, userDataDir: workdir, fetchImpl: fakeFetch(payload), baseUrl: 'https://example.test/code/' })
assert.equal(ok.ok, true)
assert.equal(ok.codeVersion, 2)
assert.equal(readFileSync(join(workdir, 'code', 'main', 'index.js'), 'utf8'), 'console.log("v2")')
assert.equal(readCurrentVersion({ userDataDir: workdir, appDir: workdir }).codeVersion, 2, '副本要自带版本号')
assert.equal(readFileSync(join(workdir, 'code-prev', 'main', 'index.js'), 'utf8'), 'console.log("v1")', '上一版要留着可回滚')
assert.equal(existsSync(join(workdir, 'code-tmp')), false, '暂存目录要清干净')

// ---- MD5 对不上：整批放弃，现有代码一个字节都不能动 ----
const tampered = parseCodeManifest({ versionName: '0.2.4', codeVersion: 3, files: { 'main/index.js': md5('说好的内容') } })
await assert.rejects(
  downloadCodeUpdate({ manifest: tampered, userDataDir: workdir, fetchImpl: fakeFetch({ 'main/index.js': '换掉的内容' }), baseUrl: 'https://example.test/code/' }),
  /MD5 校验失败/
)
assert.equal(readFileSync(join(workdir, 'code', 'main', 'index.js'), 'utf8'), 'console.log("v2")', '校验失败不能污染现有副本')
assert.equal(existsSync(join(workdir, 'code-tmp')), false)

// ---- 下到一半断网：同样不能留下半份代码 ----
const halfway = parseCodeManifest({
  versionName: '0.2.5',
  codeVersion: 4,
  files: { 'main/index.js': md5('新 main'), 'renderer/index.html': md5('新 html') }
})
await assert.rejects(
  downloadCodeUpdate({
    manifest: halfway,
    userDataDir: workdir,
    fetchImpl: fakeFetch({ 'main/index.js': '新 main', 'renderer/index.html': new Error('socket hang up') }),
    baseUrl: 'https://example.test/code/'
  })
)
assert.equal(readFileSync(join(workdir, 'code', 'main', 'index.js'), 'utf8'), 'console.log("v2")', '半份代码比旧代码更糟，必须整批回退')
assert.equal(existsSync(join(workdir, 'code-tmp')), false)

// ---- 回滚 ----
const rolled = rollbackCodeUpdate({ userDataDir: workdir })
assert.equal(rolled.ok, true)
assert.equal(rolled.to, 'previous')
assert.equal(readFileSync(join(workdir, 'code', 'main', 'index.js'), 'utf8'), 'console.log("v1")')
const toBuiltin = rollbackCodeUpdate({ userDataDir: workdir })
assert.equal(toBuiltin.to, 'builtin')
assert.equal(existsSync(join(workdir, 'code')), false, '回到内置版本就是删掉热更新副本')
rmSync(workdir, { recursive: true, force: true })

// ---- loader.js 是安装包里唯一不能热更新的文件，它的几条契约用源码钉住 ----
const loader = readFileSync(join(root, 'loader.js'), 'utf8')
assert.match(loader, /if \(!app\.isPackaged\)/, '开发态必须直接跑 out/，不受本机热更副本干扰')
assert.match(loader, /Module\._initPaths\(\)/, '热更副本要能解析到安装包内的 node_modules')
// 只匹配真正的调用形式，别把注释里那句「别用 globalPaths」也算进去
assert.doesNotMatch(loader, /Module\.globalPaths\.push\(/, 'globalPaths 是初始化时的副本，push 它对模块解析无效')
assert.match(loader, /Module\._resolveFilename = function/, '_initPaths 是内部 API，要有解析兜底')
assert.match(loader, /code-boot-pending/, '要有启动待确认标记，挡住"能加载但跑不起来"的坏版本')
assert.match(loader, /quarantine\(codeDir/, '坏副本要隔离而不是原地重试')
assert.match(loader, /require\(path\.join\(__dirname, 'out', 'main', 'index\.js'\)\)/, '任何失败都要回退内置版本')

// code-version.json 是「这个构建启不启用热更新」的开关：工作台带、巡航台不带。
// 但两个构建都必须打包 loader.js，否则 package.json 的 main 会指向缺失文件、直接起不来。
assert.match(loader, /if \(!fs\.existsSync\(path\.join\(__dirname, 'code-version\.json'\)\)\)/)
const sellerPilotConfig = readFileSync(join(root, 'electron-builder.seller-pilot.yml'), 'utf8')
assert.match(sellerPilotConfig, /- loader\.js/, 'main 指向 loader.js，任何构建都得带上它')
assert.doesNotMatch(sellerPilotConfig, /- code-version\.json/, '巡航台走整包分发，不该启用热更新')

// 入口必须是 loader.js，否则热更新整套机制不生效
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
assert.equal(pkg.main, './loader.js')
const builderConfig = readFileSync(join(root, 'electron-builder.workbench.yml'), 'utf8')
assert.match(builderConfig, /- loader\.js/)
assert.match(builderConfig, /- code-version\.json/)

// 主进程要在窗口就绪后清标记，否则每次启动都会误判上一版跑不起来
const mainIndex = readFileSync(join(root, 'src/main/index.js'), 'utf8')
assert.match(mainIndex, /clearBootPendingMarker\(\)/)
assert.match(mainIndex, /ipcMain\.handle\('code-update:download'/)
assert.match(mainIndex, /ipcMain\.handle\('code-update:rollback'/)

console.log('code update regression: passed (manifest/path/atomicity/rollback/loader contracts)')
