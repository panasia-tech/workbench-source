// 执行端（gc-ads）自动安装：找不到就自己装，不弹报错让人去放文件夹。
//
// 2026-10-06 用户：「没找到执行端就不会自己下载吗？还弹一个报错干什么，找不到就自己
// 下载，然后给出下载进度的显示」。
//
// 做的事和守护端「装机」页的一键安装一样（groupcontrol-desktop/main.js 的 adsInstall），
// 装到同一个固定位置 C:\xianyu\gc-ads：下载 Windows 免安装包 → 解压 → 写线上配置。
// 只有 Windows 有现成的包；Mac 只有源码包，要本机有 Python 3.10+ 再联网装依赖，做不到一键。
import { execFile } from 'child_process'
import { once } from 'events'
import { cpSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import { inspectExecutorDir } from './executor-local.js'

export const EXECUTOR_WIN_ZIP_URL = 'http://127.0.0.1:8000'
// 线上那个包的版本（与包里 _internal/builtin-code-version.json 同一套编号），用来判断工位上的旧不旧
export const EXECUTOR_LATEST_URL = 'http://127.0.0.1:8000'

/** 线上执行端包的版本。取不到返回 null（离线、还没发过）——那就当没有新版，照常用本机的。 */
export async function fetchLatestExecutorPackage({ fetchImpl = fetch, url = EXECUTOR_LATEST_URL, timeoutMs = 8000 } = {}) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) return null
  const data = await res.json()
  return Number(data?.codeVersion) > 0 ? data : null
}

// 换新包时从旧目录带过去的东西：配置（可能改过）、设备身份（不带就得重新注册）、台账、日志
const CARRY_OVER = ['config.yaml', 'run', 'logs']
const isIdentityFile = (name) => /^device_identity.*\.json$/i.test(name)

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 目录改名，被占着就等一会儿再试：执行端刚停，它带起来的 playwright 驱动（node.exe）
 * 要一两秒才退干净，杀毒软件扫描新文件也会短暂占着。
 */
async function renameWithRetry(from, to, { rename = renameSync, sleep = delay, attempts = 8 } = {}) {
  for (let i = 1; ; i++) {
    try {
      rename(from, to)
      return
    } catch (error) {
      if (i >= attempts || !['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error
      await sleep(1000)
    }
  }
}

// 线上配置的 server 段，与守护端 adsWriteProdConfig 一字不差（enroll_secret 与群控 App 同一把）
const PROD_SERVER = 'server:\n  base_url: "http://127.0.0.1:8000"\n'
  + '  enroll_secret: "DEMO_ONLY_REDACTED"  # 与群控 App 同一密钥\n'
  + '  mqtt_host: "service.example.invalid"\n  mqtt_port: 8883\n  mqtt_tls: true\n'

/**
 * 以包里的 config.example.yaml 为底，只把 server 段换成线上值。已有 config.yaml 不动——
 * 那可能是操作员改过的（环境清单、分组）。返回是否写了。
 */
export function writeProdConfig(root, internal = join(root, '_internal')) {
  const target = join(root, 'config.yaml')
  if (existsSync(target)) return false
  // 打包形态模板在 _internal/（PyInstaller 的 datas 落点），源码形态在根目录
  const example = [join(root, 'config.example.yaml'), join(internal, 'config.example.yaml')]
    .find((file) => existsSync(file))
  const text = example ? readFileSync(example, 'utf8') : ''
  if (!/server:\n( {2}.*\n)+/.test(text)) return false
  writeFileSync(target, text.replace(/server:\n( {2}.*\n)+/, PROD_SERVER), 'utf8')
  return true
}

/** 流式下载到文件，边下边报进度（包有几十 MB，不整块读进内存）。 */
export async function downloadToFile(url, dest, onProgress, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url)
  if (!res.ok || !res.body) throw new Error(`下载执行端失败（HTTP ${res.status}）`)
  const total = Number(res.headers.get('content-length')) || 0
  mkdirSync(dirname(dest), { recursive: true })
  const out = createWriteStream(dest)
  let received = 0
  let lastTick = 0
  try {
    for await (const chunk of res.body) {
      received += chunk.length
      if (!out.write(chunk)) await once(out, 'drain')
      const now = Date.now()
      if (now - lastTick > 200) {
        lastTick = now
        onProgress?.(received, total)
      }
    }
  } finally {
    await new Promise((resolve) => out.end(resolve))
  }
  onProgress?.(received, total)
  if (total && received !== total) throw new Error('执行端下载不完整，网络可能断过，再点一次')
  return received
}

function run(command, args, timeout) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || error?.message || '') })
    })
  })
}

/** 解压：Windows 10 起自带 tar（认 zip），不行再用 PowerShell。同守护端 extractZip。 */
export async function extractZip(zip, destDir) {
  // 已存在就别建：目标曾是 C 盘根（C:\），而 Windows 上对盘符根做递归 mkdir 会直接报
  // EPERM（2026-10-06 现场「下载完成之后报 mkdir C:\」，txy 上 Node 24 复现），
  // 不会当作「已存在」放过去。
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
  const tar = await run('tar', ['-xf', zip, '-C', destDir], 300_000)
  if (tar.ok) return
  const ps = await run('powershell', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${destDir}' -Force`], 300_000)
  if (!ps.ok) throw new Error(`解压执行端失败：${(ps.stderr || ps.stdout).trim().slice(-200)}`)
}

/**
 * 换新包：解到旁边的 gc-ads.new，带上旧目录的配置、身份、台账、日志，再整个换过去。
 * 旧的留在 gc-ads.old（下次更新时才删），新的起不来还能手工换回去。
 * 不在原地覆盖解压：中途失败会留下半新半旧的一个包，比不更新还糟。
 */
async function upgrade({ fixed, platform, tempDir, onProgress, download, extract, url, rename, sleep }) {
  const report = (progress) => onProgress({ ...progress, upgrade: true })
  const zip = join(tempDir, 'gc-ads-windows.zip')
  const staging = `${fixed}.new`
  const previous = `${fixed}.old`
  rmSync(staging, { recursive: true, force: true })
  report({ phase: 'download', received: 0, total: 0 })
  try {
    await download(url, zip, (received, total) => report({ phase: 'download', received, total }))
    report({ phase: 'extract' })
    await extract(zip, staging)
  } finally {
    rmSync(zip, { force: true })
  }
  const fresh = join(staging, basename(fixed))
  if (!existsSync(join(fresh, platform === 'win32' ? 'gc-ads.exe' : 'gc-ads'))) {
    rmSync(staging, { recursive: true, force: true })
    throw new Error('新的执行端包里没有程序，可能下载坏了，下次启动再试')
  }
  report({ phase: 'config' })
  for (const name of readdirSync(fixed)) {
    if (CARRY_OVER.includes(name) || isIdentityFile(name)) {
      cpSync(join(fixed, name), join(fresh, name), { recursive: true, force: true })
    }
  }
  writeProdConfig(fresh)
  rmSync(previous, { recursive: true, force: true })
  try {
    await renameWithRetry(fixed, previous, { rename, sleep })
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw new Error(`旧的执行端还被占着，这次先不换（${error?.code || error?.message}）`)
  }
  try {
    await renameWithRetry(fresh, fixed, { rename, sleep })
  } catch (error) {
    rename(previous, fixed)
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
  rmSync(staging, { recursive: true, force: true })
  const found = inspectExecutorDir(fixed, { platform })
  if (!found.ok) throw new Error(`执行端换好了但不完整：${found.reason}`)
  report({ phase: 'done' })
  return found
}

async function install({
  fixed,
  platform = process.platform,
  tempDir,
  onProgress = () => {},
  download = downloadToFile,
  extract = extractZip,
  url = EXECUTOR_WIN_ZIP_URL,
  upgrade: replace = false,
  rename = renameSync,
  sleep = delay
}) {
  const present = inspectExecutorDir(fixed, { platform })
  if (replace && present.ok && platform === 'win32') {
    return upgrade({ fixed, platform, tempDir, onProgress, download, extract, url, rename, sleep })
  }
  if (present.ok) return present
  // 程序在、只缺 config.yaml：补上配置就行，不用再下几十 MB
  if (present.needsConfig) {
    onProgress({ phase: 'config' })
    writeProdConfig(fixed)
    const fixedUp = inspectExecutorDir(fixed, { platform })
    if (fixedUp.ok) {
      onProgress({ phase: 'done' })
      return fixedUp
    }
  }
  if (platform !== 'win32') {
    throw new Error(`这台电脑没有现成的执行端安装包（只有 Windows 有）：请把 adspower-executor 文件夹放到 ${fixed}`)
  }
  const zip = join(tempDir, 'gc-ads-windows.zip')
  onProgress({ phase: 'download', received: 0, total: 0 })
  try {
    await download(url, zip, (received, total) => onProgress({ phase: 'download', received, total }))
    onProgress({ phase: 'extract' })
    // zip 的顶层就是 gc-ads/，解到固定位置的上一级（C:\xianyu）正好落成 C:\xianyu\gc-ads
    await extract(zip, dirname(fixed))
  } finally {
    rmSync(zip, { force: true })
  }
  onProgress({ phase: 'config' })
  writeProdConfig(fixed)
  const found = inspectExecutorDir(fixed, { platform })
  if (!found.ok) throw new Error(`执行端装好了但不完整：${found.reason}`)
  onProgress({ phase: 'done' })
  return found
}

let installing = null

/**
 * 装执行端，装好返回它（同 inspectExecutorDir 的结果）。同时点了几次也只下一份：
 * 后来的等前面那次。失败时进度里报 error，原因照常抛给调方。
 */
export function installExecutor(options) {
  if (!installing) {
    installing = install(options)
      .catch((error) => {
        options.onProgress?.({ phase: 'error', message: error?.message || String(error) })
        throw error
      })
      .finally(() => {
        installing = null
      })
  }
  return installing
}
