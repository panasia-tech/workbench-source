// 找不到执行端就自己装（src/main/executor-install.js）。
//
// 2026-10-06 用户：「没找到执行端就不会自己下载吗？还弹一个报错干什么，找不到就自己下载，
// 然后给出下载进度的显示」。这里钉死：
//   1. 真下载、真解压：线上包的样子（顶层 gc-ads/、gc-ads.exe、_internal/config.example.yaml）
//      装完正好落在固定位置，配置写成线上值；
//   2. 进度按「下载 → 解压 → 写配置 → 完成」报，下载带字节数；
//   3. 同时点了几次只下一份；
//   4. 程序在、只缺 config.yaml：不重下几十 MB；
//   5. 已有 config.yaml 不覆盖（操作员可能改过）；
//   6. 没有安装包的平台、下载不完整：说清楚，并报 error 让进度框关掉。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installExecutor, writeProdConfig } from '../../src/main/executor-install.js'

const made = []
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}

const EXAMPLE = 'server:\n  base_url: "http://127.0.0.1:8100/api/gc"\n  enroll_secret: ""\n'
  + 'adspower:\n  api_base: "http://127.0.0.1:50326"\n  env_group: "行情"\n'

// --- 1. 写线上配置 --------------------------------------------------------------
{
  const root = tempDir('gc-cfg-')
  mkdirSync(join(root, '_internal'))
  writeFileSync(join(root, '_internal', 'config.example.yaml'), EXAMPLE)
  assert.equal(writeProdConfig(root), true)
  const cfg = readFileSync(join(root, 'config.yaml'), 'utf8')
  assert.match(cfg, /base_url: "https:\/\/api\.panasia\.fun\/gc"/)
  assert.match(cfg, /enroll_secret: "gc-enroll-/, '和守护端、群控 App 同一把注册口令')
  assert.match(cfg, /mqtt_port: 8883/)
  assert.match(cfg, /env_group: "行情"/, '只换 server 段，其余照模板')

  writeFileSync(join(root, 'config.yaml'), 'operator: edited\n')
  assert.equal(writeProdConfig(root), false)
  assert.equal(readFileSync(join(root, 'config.yaml'), 'utf8'), 'operator: edited\n', '操作员改过的配置不能被覆盖')
  assert.equal(writeProdConfig(tempDir('gc-nocfg-')), false, '没模板就不写')
}

// --- 2. 真下载、真解压：装到固定位置 --------------------------------------------
// 用系统 zip 打一个和线上包同样结构的小包，本地 HTTP 发出去
function buildZip() {
  const src = tempDir('gc-src-')
  mkdirSync(join(src, 'gc-ads', '_internal'), { recursive: true })
  writeFileSync(join(src, 'gc-ads', 'gc-ads.exe'), 'MZ fake exe')
  writeFileSync(join(src, 'gc-ads', '_internal', 'config.example.yaml'), EXAMPLE)
  writeFileSync(join(src, 'gc-ads', '_internal', 'blob.bin'), Buffer.alloc(300_000, 7))
  const zip = join(src, 'pkg.zip')
  execFileSync('zip', ['-qr', zip, 'gc-ads'], { cwd: src })
  return readFileSync(zip)
}

async function serve(handler) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}/gc-ads-windows-latest.zip`, close: () => server.close() }
}

let zipBytes = null
try {
  zipBytes = buildZip()
} catch {
  console.log('（这台机器没有 zip 命令，跳过真下载真解压那一段）')
}

if (zipBytes && process.platform !== 'win32') {
  let hits = 0
  const server = await serve((req, res) => {
    hits++
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': zipBytes.length })
    // 分几块慢慢发，进度才会走几步
    let offset = 0
    const tick = () => {
      if (offset >= zipBytes.length) return res.end()
      res.write(zipBytes.subarray(offset, offset + 60_000))
      offset += 60_000
      setTimeout(tick, 250)
    }
    tick()
  })
  try {
    const parent = tempDir('gc-c-drive-')
    const fixed = join(parent, 'gc-ads')
    const temp = tempDir('gc-temp-')
    const progress = []
    const [a, b] = await Promise.all([
      installExecutor({ fixed, platform: 'win32', tempDir: temp, url: server.url, onProgress: (p) => progress.push(p) }),
      installExecutor({ fixed, platform: 'win32', tempDir: temp, url: server.url, onProgress: () => {} })
    ])
    assert.equal(hits, 1, '同时点了两次，只下一份')
    assert.equal(a.ok, true, a.reason)
    assert.equal(b.root, a.root)
    assert.equal(a.root, fixed, '装到固定位置')
    assert.ok(existsSync(join(fixed, 'gc-ads.exe')))
    assert.match(readFileSync(join(fixed, 'config.yaml'), 'utf8'), /api\.panasia\.fun\/gc/)
    assert.equal(existsSync(join(temp, 'gc-ads-windows.zip')), false, '下载的安装包用完要删')

    const phases = progress.map((p) => p.phase).filter((phase, i, all) => phase !== all[i - 1])
    assert.deepEqual(phases, ['download', 'extract', 'config', 'done'])
    const downloads = progress.filter((p) => p.phase === 'download' && p.total)
    assert.ok(downloads.length >= 2, '下载要一路报进度，不是只报开头结尾')
    assert.equal(downloads.at(-1).received, zipBytes.length)
    assert.equal(downloads.at(-1).total, zipBytes.length)

    // 已经装好：不再下载
    const again = await installExecutor({ fixed, platform: 'win32', tempDir: temp, url: server.url })
    assert.equal(again.ok, true)
    assert.equal(hits, 1)
  } finally {
    server.close()
  }

  // 下载不完整（服务器说有 N 字节，只给了一半就断开）：要报错，不能装半份
  const broken = await serve((req, res) => {
    res.writeHead(200, { 'content-length': zipBytes.length })
    res.write(zipBytes.subarray(0, 1000))
    setTimeout(() => res.destroy(), 50)
  })
  try {
    const fixed = join(tempDir('gc-c-broken-'), 'gc-ads')
    const progress = []
    await assert.rejects(
      () => installExecutor({ fixed, platform: 'win32', tempDir: tempDir('gc-temp-'), url: broken.url, onProgress: (p) => progress.push(p) })
    )
    assert.equal(progress.at(-1).phase, 'error', '失败要报 error，进度框才会关')
    assert.equal(existsSync(join(fixed, 'gc-ads.exe')), false)
  } finally {
    broken.close()
  }
}

// --- 3. 程序在、只缺 config.yaml：补配置，不下载 ---------------------------------
{
  const fixed = join(tempDir('gc-cfgonly-'), 'gc-ads')
  mkdirSync(join(fixed, '_internal'), { recursive: true })
  writeFileSync(join(fixed, 'gc-ads.exe'), 'MZ')
  writeFileSync(join(fixed, '_internal', 'config.example.yaml'), EXAMPLE)
  const progress = []
  const done = await installExecutor({
    fixed, platform: 'win32', tempDir: tempDir('gc-temp-'),
    download: async () => assert.fail('只缺配置不该重下安装包'),
    onProgress: (p) => progress.push(p.phase)
  })
  assert.equal(done.ok, true)
  assert.deepEqual(progress, ['config', 'done'])
}

// --- 4. 没有安装包的平台：说清楚，并报 error ------------------------------------
{
  const fixed = join(tempDir('gc-mac-'), 'gc-ads')
  const progress = []
  await assert.rejects(
    () => installExecutor({ fixed, platform: 'darwin', tempDir: tempDir('gc-temp-'), onProgress: (p) => progress.push(p) }),
    (error) => error.message.includes('只有 Windows 有') && error.message.includes(fixed)
  )
  assert.equal(progress.at(-1).phase, 'error')
}

// --- 5. 换新包：旧目录里的配置、身份、台账、日志带过去，旧包留在 gc-ads.old ------------
// 2026-10-06：工位上是 09-10 的老包（不能热更新），新包要真换上去才到得了工位。
function buildVersionedZip(version) {
  const src = tempDir('gc-src2-')
  mkdirSync(join(src, 'gc-ads', '_internal'), { recursive: true })
  writeFileSync(join(src, 'gc-ads', 'gc-ads.exe'), `MZ new v${version}`)
  writeFileSync(join(src, 'gc-ads', '_internal', 'config.example.yaml'), EXAMPLE)
  writeFileSync(join(src, 'gc-ads', '_internal', 'builtin-code-version.json'), JSON.stringify({ codeVersion: version }))
  const zip = join(src, 'pkg.zip')
  execFileSync('zip', ['-qr', zip, 'gc-ads'], { cwd: src })
  return readFileSync(zip)
}

function oldInstall() {
  const fixed = join(tempDir('gc-old-'), 'gc-ads')
  mkdirSync(join(fixed, '_internal'), { recursive: true })
  mkdirSync(join(fixed, 'logs'))
  mkdirSync(join(fixed, 'run'))
  mkdirSync(join(fixed, 'code'))
  writeFileSync(join(fixed, 'gc-ads.exe'), 'MZ old 0910')
  writeFileSync(join(fixed, '_internal', 'only-in-old.bin'), 'stale')
  writeFileSync(join(fixed, 'config.yaml'), 'operator: edited\n')
  writeFileSync(join(fixed, 'device_identity_k1ho3jr0.json'), '{"device_id":"dev-1"}')
  writeFileSync(join(fixed, 'logs', 'executor_k1ho3jr0.log'), 'old log')
  writeFileSync(join(fixed, 'run', 'supervisor.json'), '{"k1ho3jr0":{"pid":1,"stopped":true}}')
  writeFileSync(join(fixed, 'code', 'gc-ads-code-version.json'), '{"codeVersion":1}')
  return fixed
}

let v2 = null
try {
  v2 = buildVersionedZip(2)
} catch {
  console.log('（这台机器没有 zip 命令，跳过换新包那一段）')
}
if (v2 && process.platform !== 'win32') {
  const server = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': v2.length })
    res.end(v2)
  })
  try {
    // 正常换新
    const fixed = oldInstall()
    const progress = []
    const done = await installExecutor({ fixed, platform: 'win32', tempDir: tempDir('gc-temp-'), url: server.url,
      upgrade: true, onProgress: (p) => progress.push(p) })
    assert.equal(done.ok, true, done.reason)
    assert.equal(done.packageVersion, 2)
    assert.equal(readFileSync(join(fixed, 'gc-ads.exe'), 'utf8'), 'MZ new v2', '程序换成新的')
    assert.equal(readFileSync(join(fixed, 'config.yaml'), 'utf8'), 'operator: edited\n', '配置原样带过去，不按模板重写')
    assert.equal(readFileSync(join(fixed, 'device_identity_k1ho3jr0.json'), 'utf8'), '{"device_id":"dev-1"}', '设备身份带过去，不用重新注册')
    assert.equal(readFileSync(join(fixed, 'logs', 'executor_k1ho3jr0.log'), 'utf8'), 'old log')
    assert.ok(existsSync(join(fixed, 'run', 'supervisor.json')), '台账带过去')
    assert.equal(existsSync(join(fixed, '_internal', 'only-in-old.bin')), false, '新包是干净的，不混旧文件')
    assert.equal(existsSync(join(fixed, 'code')), false, '上一代的热更新不带过去')
    assert.equal(readFileSync(join(`${fixed}.old`, 'gc-ads.exe'), 'utf8'), 'MZ old 0910', '旧包留一份在 gc-ads.old')
    assert.equal(existsSync(`${fixed}.new`), false, '临时目录要清掉')
    const phases = progress.map((p) => p.phase).filter((phase, i, all) => phase !== all[i - 1])
    assert.deepEqual(phases, ['download', 'extract', 'config', 'done'])
    assert.ok(progress.every((p) => p.upgrade === true), '进度都标成「更新」，界面才写「正在更新执行端」')

    // 旧目录被占着（有执行端没停干净）：重试几次还不行就放弃，旧的原样留着
    const busy = oldInstall()
    const progress2 = []
    let tries = 0
    await assert.rejects(
      () => installExecutor({ fixed: busy, platform: 'win32', tempDir: tempDir('gc-temp-'), url: server.url, upgrade: true,
        sleep: async () => {},
        rename: () => { tries++; const e = new Error('busy'); e.code = 'EBUSY'; throw e },
        onProgress: (p) => progress2.push(p) }),
      /还被占着/
    )
    assert.ok(tries > 1, '被占着要等一等再试，不是一次就放弃')
    assert.equal(readFileSync(join(busy, 'gc-ads.exe'), 'utf8'), 'MZ old 0910', '换不了就保持原样')
    assert.equal(existsSync(`${busy}.new`), false)
    assert.equal(progress2.at(-1).phase, 'error', '失败要报 error，进度框才会关')
  } finally {
    server.close()
  }
}

for (const dir of made) rmSync(dir, { recursive: true, force: true })
console.log('executor-install-regression: PASS')
