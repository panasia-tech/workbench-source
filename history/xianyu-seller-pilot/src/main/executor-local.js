// 执行端的本机直控：本机代理不在时，启动 / 停止 / 查看执行端走这里。
//
// 执行端进程原本只能经本机代理（manage.py broker 的 /broker/executor/*）控制，
// 代理一不在，「登录闲鱼」「启动执行端」就全失灵。可代理不是必须项——它不在只该
// 失去跨进程节流与归属保护（见 adspower.js 顶部），不该让执行端起不来。
//
// 为什么不去调执行端自己的命令行（gc-ads start / status）：
//   1. 打包版每跑一次非执行端命令，都会留下热更新的 boot-pending 标记，而只有执行端
//      入口会删它；下一次调用就会把热更新代码当坏版本隔离（gc_ads/hot_code.py）。
//      界面每刷新一次就调一次 status，等于亲手把热更新关掉。
//   2. manage.py start 只起它「认领」清单里的环境；AdsPower 免费版枚举不了环境时，
//      清单退回 config.yaml，通常是空的——命令行一个都起不了，代理那条路却能起。
//
// 所以这里做的就是代理做的那件事（gc_ads/supervisor.py 的 start_one / stop_one），
// 并且**照它的格式读写同一本台账 run/supervisor.json**：看门狗、代理、命令行都认这
// 一份，谁起的进程谁都看得见、停得掉，不会冒出第二个执行端去抢同一个浏览器。
//
// ⚠️ 台账格式、拉起命令、日志文件名都是 supervisor.py 定的，那边改了这里要跟着改。
import { execFile, spawn as nodeSpawn } from 'child_process'
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { homedir, uptime } from 'os'
import { join } from 'path'

// supervisor.BROKER_KEY：代理自己在台账里的条目，不是环境
const BROKER_KEY = '::broker'
// supervisor.stop_one：先 SIGTERM，等它自己退（30 × 0.2 秒），还在再 SIGKILL
const STOP_POLLS = 30
const STOP_POLL_MS = 200
// 拉起后看它一眼。配置缺失、依赖坏了这类错误一两秒内就会退出；不看的话界面说
// 「已拉起」，进程其实早没了，人只会觉得点了没反应。
const BOOT_WATCH_MS = 1_500
// 启动时热更新放的 boot-pending 标记要等它撤掉再起下一个：紧接着起的旧版执行端看见标记，
// 会把好好的新代码当坏版本隔离（gc_ads/hot_code.activate）。
const BOOT_SETTLE_MS = 20_000
const BOOT_SETTLE_POLL_MS = 300

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 执行端放在固定位置，不让人去选，而且放在项目自己的文件夹里、不直接摊在盘符根下
 * （2026-10-06 用户：「直接固定位置，win 就放 C 盘」，随后又定「放在 c:/xianyu 这样
 * 自己用项目命名的文件夹下，而不是直接裸目录」）。
 *   Windows：C:\xianyu\gc-ads     Mac：~/xianyu/gc-ads
 * 另外认几处老位置：同一天短暂用过的 C:\gc-ads（~/gc-ads）；守护端「装机」页以前一键安装
 * 到它自己的数据目录里（打包后目录名是「群控守护」还是 groupcontrol-desktop 取决于打包
 * 配置，两个都认）；开发机跑源码时，执行端就在仓库里行情台的隔壁。
 */
export function executorDirCandidates({ platform = process.platform, home = homedir(), appData = '', devRoot = '' } = {}) {
  const win = platform === 'win32'
  const fixed = win ? 'C:\\xianyu\\gc-ads' : join(home, 'xianyu', 'gc-ads')
  const list = [fixed, win ? 'C:\\gc-ads' : join(home, 'gc-ads')]
  if (appData) for (const name of ['群控守护', 'groupcontrol-desktop']) list.push(join(appData, name, 'gc-ads'))
  if (devRoot) list.push(devRoot)
  return { fixed, list }
}

/**
 * 认一个文件夹是不是执行端：打包版里有 gc-ads(.exe)，源码版有 main.py 和 .venv。
 * 两种都得有 config.yaml——没有它执行端不知道连哪台服务器，起来就退。
 */
export function inspectExecutorDir(dir, { platform = process.platform } = {}) {
  const root = String(dir || '').trim()
  if (!root) return { ok: false, missing: true, reason: '没有执行端位置' }
  if (!isDirectory(root)) return { ok: false, missing: true, root, reason: `找不到这个文件夹：${root}` }
  const exe = join(root, platform === 'win32' ? 'gc-ads.exe' : 'gc-ads')
  const python = [join(root, '.venv', 'Scripts', 'python.exe'), join(root, '.venv', 'bin', 'python')]
    .find((candidate) => existsSync(candidate))
  let home = null
  if (existsSync(exe)) home = { root, kind: 'packaged', program: exe, packageVersion: readPackageVersion(root) }
  else if (python && existsSync(join(root, 'main.py'))) home = { root, kind: 'source', program: python }
  if (!home) return { ok: false, root, reason: '这个文件夹里没有执行端：应当有 gc-ads 程序，或者源码的 main.py 和 .venv' }
  if (!existsSync(join(root, 'config.yaml'))) {
    return { ok: false, root, needsConfig: true, reason: '执行端文件夹里缺 config.yaml，它不知道该连哪台服务器' }
  }
  return { ok: true, ...home }
}

/**
 * 内嵌在安装包里的执行端：程序在安装目录（升级时整个换掉），config.yaml、设备身份、台账、
 * 日志和热更新代码都在 dataDir（2026-11-01 用户：「直接把执行端内嵌进去，不需要单独目录了」）。
 * 老安装包里没有程序，返回 missing，继续走固定位置那一套。
 */
export function inspectEmbeddedExecutor({ programDir = '', dataDir = '' } = {}, { platform = process.platform } = {}) {
  const program = programDir ? join(programDir, platform === 'win32' ? 'gc-ads.exe' : 'gc-ads') : ''
  if (!program || !dataDir || !existsSync(program)) return { ok: false, missing: true, reason: '安装包里没有执行端' }
  const home = {
    root: dataDir,
    kind: 'packaged',
    program,
    embedded: true,
    internal: join(programDir, '_internal'),
    env: { GC_ADS_HOME: dataDir }
  }
  home.packageVersion = readPackageVersion(dataDir, home.internal)
  if (!existsSync(join(dataDir, 'config.yaml'))) return { ...home, ok: false, needsConfig: true, reason: '执行端数据目录里缺 config.yaml' }
  return { ...home, ok: true }
}

/**
 * 把老目录搬进内嵌的数据目录：配置、设备身份、台账（开机自恢复靠它）。已有的不覆盖。
 * 先改名再拷：改名失败（还被占着）就什么都没动，下次再搬。老目录留作 .migrated，新的跑不起来还能换回去。
 */
export function migrateLegacyExecutor(legacyRoot, dataDir, { rename = renameSync } = {}) {
  const moved = `${legacyRoot}.migrated`
  rmSync(moved, { recursive: true, force: true })
  rename(legacyRoot, moved)
  mkdirSync(join(dataDir, 'run'), { recursive: true })
  for (const name of readdirSync(moved)) {
    if (name === 'config.yaml' || /^device_identity.*\.json$/i.test(name)) {
      cpSync(join(moved, name), join(dataDir, name), { force: false })
    }
  }
  const ledger = join(moved, 'run', 'supervisor.json')
  if (existsSync(ledger)) cpSync(ledger, join(dataDir, 'run', 'supervisor.json'), { force: false })
  return moved
}

/**
 * 包里内置代码的版本（打包时写进 _internal/builtin-code-version.json）。
 * 09-10 那批老包没有这个文件，按 0 算——正好比任何新包都旧。
 */
export function readPackageVersion(root, internal = join(root, '_internal')) {
  try {
    const data = JSON.parse(readFileSync(join(internal, 'builtin-code-version.json'), 'utf8'))
    return Number(data?.codeVersion) || 0
  } catch {
    return 0
  }
}

/** 拉起命令：同 supervisor._executor_cmd。 */
function executorCommand(home, userId) {
  const entry = home.kind === 'packaged' ? ['executor'] : ['main.py']
  return [home.program, ...entry, '--config', 'config.yaml', '--user-id', userId]
}

function statePath(root) {
  return join(root, 'run', 'supervisor.json')
}

/**
 * 读台账。读坏了不能当它是空的：supervisor 是直接覆盖写的，赶上它写到一半会读到
 * 半截 JSON——当成空表写回去，别的环境的条目就全没了。等一下再读，还坏就停手。
 */
async function loadState(root, sleep) {
  const file = statePath(root)
  for (let attempt = 1; ; attempt++) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return {}
      throw error
    }
    try {
      const data = JSON.parse(text)
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
    } catch {
      if (attempt >= 3) {
        if (!text.trim()) return {}
        throw new Error(`执行端台账读不出来（${file}），没敢改它`)
      }
      await sleep(200)
    }
  }
}

/** 写台账：先写临时文件再改名，别让 Python 那边读到写了一半的文件。 */
function saveState(root, state) {
  const file = statePath(root)
  mkdirSync(join(root, 'run'), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(state, null, 1), 'utf8')
  renameSync(temp, file)
}

// 台账时间只到秒，开机后系统时钟还可能被校准一下，留 2 分钟余量
const BOOT_SLACK_MS = 2 * 60_000

/** 这次开机的时刻（毫秒）。 */
export function systemBootTime() {
  return Date.now() - uptime() * 1000
}

/**
 * pid 是不是这个环境的执行端（同 supervisor._pid_alive）。
 *
 * pid 会被系统复用，所以活着还不够，还要看命令行里有没有这个环境的 --user-id。
 * Windows 上没有 ps，和 supervisor 一样只看 pid 在不在——所以先看台账记的启动时间：
 * 早于这次开机的进程不可能还活着，那个 pid 是重启后被别的程序复用了（不挡的话，开机
 * 自恢复会当它「已在跑」不拉起，停止还会去杀那个不相干的程序）。
 */
export async function executorAlive(pid, userId, { platform = process.platform, startedAt = '', bootTime = systemBootTime() } = {}) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  const started = parseStamp(startedAt)
  if (Number.isFinite(started) && started < bootTime - BOOT_SLACK_MS) return false
  try {
    process.kill(n, 0)
  } catch (error) {
    if (error?.code !== 'EPERM') return false
  }
  if (!userId || platform === 'win32') return true
  try {
    const command = await new Promise((resolve, reject) => {
      execFile('ps', ['-p', String(n), '-o', 'command='], { timeout: 5_000 },
        (error, stdout) => (error ? reject(error) : resolve(String(stdout))))
    })
    return command.includes(userId) && (command.includes('main.py') || command.includes(' executor'))
  } catch (error) {
    // ps 退出码 1 = 刚好在这一瞬间退出了；别的错（查不动）就信 pid，同 supervisor
    return error?.code !== 1
  }
}

function stamp(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 进程一起来就退时，原因在它的 stdout 日志末尾。取最后几行给人看。 */
function logTail(path, maxBytes = 2_048) {
  let fd
  try {
    const size = statSync(path).size
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    fd = openSync(path, 'r')
    readSync(fd, buffer, 0, length, size - length)
    const lines = buffer.toString('utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    return lines.slice(-3).join(' / ').slice(-300)
  } catch {
    return ''
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// 同一台电脑上的启动排成一队：页面点启动、开机自恢复、更新都走这里，不同时起两个
let startQueue = Promise.resolve()
function inStartQueue(task) {
  const run = startQueue.then(task, task)
  startQueue = run.catch(() => {})
  return run
}

async function waitBootSettled(root, { sleep, exists = existsSync, timeoutMs = BOOT_SETTLE_MS }) {
  const marker = join(root, 'code', '.boot-pending')
  for (let waited = 0; waited < timeoutMs && exists(marker); waited += BOOT_SETTLE_POLL_MS) {
    await sleep(BOOT_SETTLE_POLL_MS)
  }
}

/** 启动一个环境的执行端：先开浏览器，再拉起进程、记进台账。幂等。 */
export async function startLocalExecutor(home, userId, {
  openBrowser,
  spawn = nodeSpawn,
  alive = executorAlive,
  sleep = delay,
  now = () => new Date(),
  bootWatchMs = BOOT_WATCH_MS
} = {}) {
  const uid = String(userId || '').trim()
  if (!uid) throw new Error('缺少环境 ID')
  const { root } = home
  const entry = (await loadState(root, sleep))[uid] || {}
  if (entry.pid && !entry.stopped && await alive(entry.pid, uid, { startedAt: entry.started_at })) {
    // 执行端在跑 ≠ 浏览器在跑。浏览器被手动关掉时，光回一句「已在跑」它就再也开不
    // 回来（supervisor 2026-09-10 实测）。开浏览器是幂等的，开着就只是确认一下。
    await openBrowser(uid)
    return { user_id: uid, ok: true, note: `执行端已在跑 (pid=${entry.pid})，浏览器已确认` }
  }
  // 先开浏览器：环境不存在、套餐并发上限这类错在这里就报出来，不埋进执行端日志
  await openBrowser(uid)

  const logs = join(root, 'logs')
  mkdirSync(logs, { recursive: true })
  // 执行端自己写 executor_<id>.log；这里只接它逃出 logging 的输出（同 supervisor）
  const outPath = join(logs, `executor_${uid}.out.log`)
  const out = openSync(outPath, 'a')
  let child
  try {
    const [program, ...args] = executorCommand(home, uid)
    // detached + unref：行情台退出后执行端照跑，和 supervisor 的 start_new_session 一个意思
    child = spawn(program, args, {
      cwd: root,
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
      ...(home.env ? { env: { ...process.env, ...home.env } } : {})
    })
  } finally {
    closeSync(out)
  }
  const exited = new Promise((resolve) => {
    child.once('exit', (code) => resolve({ code }))
    child.once('error', (error) => resolve({ error }))
  })
  if (!child.pid) {
    const { error } = await exited
    throw new Error(`执行端拉不起来：${error?.message || '未知原因'}`)
  }
  // 先记台账再观察：看门狗每 10 秒巡一次，晚记这一两秒它可能再拉一个出来抢浏览器
  const state = await loadState(root, sleep)
  state[uid] = {
    pid: child.pid,
    log: join(logs, `executor_${uid}.log`),
    started_at: stamp(now()),
    stopped: false
  }
  saveState(root, state)

  const early = await Promise.race([exited, sleep(bootWatchMs).then(() => null)])
  child.unref?.()
  if (early) {
    const why = early.error?.message || logTail(outPath) || `详情在 ${outPath}`
    const code = early.code == null ? '' : `（退出码 ${early.code}）`
    throw new Error(`执行端一起来就退出了${code}：${why}`)
  }
  await waitBootSettled(root, { sleep })
  return { user_id: uid, ok: true, note: `执行端已拉起 (pid=${child.pid})` }
}

/** 停一个环境的执行端，stopBrowser 时连浏览器一起关。顺序不能反：先关浏览器的话，执行端的自愈几秒内就把它重开。 */
export async function stopLocalExecutor(home, userId, {
  stopBrowser = false,
  closeBrowser,
  alive = executorAlive,
  kill = (pid, signal) => process.kill(pid, signal),
  sleep = delay
} = {}) {
  const uid = String(userId || '').trim()
  if (!uid) throw new Error('缺少环境 ID')
  const { root } = home
  const entry = (await loadState(root, sleep))[uid] || {}
  const pid = Number(entry.pid) || null
  const notes = []
  if (pid && await alive(pid, uid, { startedAt: entry.started_at })) {
    try {
      kill(pid, 'SIGTERM')
      for (let i = 0; i < STOP_POLLS && await alive(pid, uid); i++) await sleep(STOP_POLL_MS)
      if (await alive(pid, uid)) kill(pid, 'SIGKILL')
      notes.push(`执行端已停止 (pid=${pid})`)
    } catch (error) {
      notes.push(`停进程失败: ${error?.message || error}`)
    }
  } else {
    notes.push('执行端本就没在跑')
  }
  // 记「人工停止」：看门狗见到它就不再拉起
  const state = await loadState(root, sleep)
  state[uid] = { ...(state[uid] || entry), pid: entry.pid ?? null, stopped: true }
  saveState(root, state)
  if (stopBrowser) {
    try {
      await closeBrowser(uid)
      notes.push('浏览器已关')
    } catch (error) {
      notes.push(`关浏览器失败: ${error?.message || error}`)
    }
  }
  return { user_id: uid, ok: true, note: notes.join('；') }
}

/**
 * 开机自恢复：把台账里「不是人工停止」的环境执行端全部拉起。
 *
 * 用在巡航台（开机自启后）启动时：机器重启 → 巡航台起 → 上次在跑的执行端自动活，
 * 员工零操作。startLocalExecutor 是幂等的（在跑就只确认浏览器），所以全量过一遍
 * 即可；单个环境失败不拖垮其他环境；代理条目（::broker）与人工停止（stopped）跳过——
 * 人工停的要尊重，开机不能替人反悔（同看门狗语义）。
 */
export async function resumeLocalExecutors(home, deps = {}) {
  const state = await loadState(home.root, deps.sleep || delay)
  const results = []
  for (const [uid, entry] of Object.entries(state)) {
    if (uid === BROKER_KEY || entry?.stopped) continue
    try {
      const r = await startLocalExecutor(home, uid, deps)
      results.push({ user_id: uid, ok: true, note: r.note })
    } catch (error) {
      results.push({ user_id: uid, ok: false, note: String(error?.message || error).slice(0, 300) })
    }
  }
  return results
}

/** 台账里每个环境的执行端在不在跑，形状对齐代理 /broker/executor 给界面的那份。 */
export async function localExecutorStatus(home, { alive = executorAlive, sleep = delay } = {}) {
  const state = await loadState(home.root, sleep)
  const map = {}
  for (const [uid, entry] of Object.entries(state)) {
    if (uid === BROKER_KEY || !entry || typeof entry !== 'object') continue
    const running = Boolean(entry.pid) && !entry.stopped && await alive(entry.pid, uid, { startedAt: entry.started_at })
    map[uid] = {
      executor: running ? `运行中 (pid=${entry.pid})` : (entry.stopped ? '已停止（人工）' : '已停止'),
      browser: ''
    }
  }
  return map
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 磁盘上最新的一份执行端代码：热更新 code/ 和包里内置的，取版本号大的（同 hot_code.local_version）。
 * 注意这是「下好了的」，不是「在跑的」——跑着的进程会悄悄把新版下到 code/，但不换自己。
 */
export function diskCodeVersion(home) {
  const builtin = readJson(join(home.internal || join(home.root, '_internal'), 'builtin-code-version.json')) || {}
  const hot = readJson(join(home.root, 'code', 'gc-ads-code-version.json')) || {}
  const pick = (data) => ({ codeVersion: Number(data.codeVersion) || 0, versionName: String(data.versionName || '') })
  const a = pick(hot)
  const b = pick(builtin)
  return a.codeVersion > b.codeVersion ? a : b
}

/** 'YYYY-MM-DD HH:MM:SS'（台账的 started_at，本地时间）→ 毫秒；认不出来给 NaN。 */
function parseStamp(text) {
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)$/.exec(String(text || ''))
  return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : NaN
}

/**
 * 每个在跑的执行端**实际跑的**是哪一版。
 *
 * 执行端启动时写 run/executor_<id>.version.json（hot_code.write_running_marker）。
 * 只认属于当前这个进程的那份：pid 对得上，或者文件是这次启动之后写的（打包形态下
 * 拉起的 pid 与 Python 自报的偶尔不是同一个）。在跑却没有可认的标记 = 这个功能之前
 * 起的老进程，一定比现在任何一版都旧，给 { stale: true }。
 */
export async function runningCodeVersions(home, { alive = executorAlive, sleep = delay, stat = statSync } = {}) {
  const state = await loadState(home.root, sleep)
  const map = {}
  for (const [uid, entry] of Object.entries(state)) {
    if (uid === BROKER_KEY || !entry || typeof entry !== 'object') continue
    if (!entry.pid || entry.stopped || !await alive(entry.pid, uid, { startedAt: entry.started_at })) continue
    const file = join(home.root, 'run', `executor_${uid}.version.json`)
    const marker = readJson(file)
    let mine = false
    if (marker) {
      if (Number(marker.pid) === Number(entry.pid)) mine = true
      else {
        try {
          // 台账时间只到秒，留 5 秒余量
          mine = stat(file).mtimeMs >= parseStamp(entry.started_at) - 5_000
        } catch { /* 读不到就当不是 */ }
      }
    }
    map[uid] = mine
      ? { codeVersion: Number(marker.codeVersion) || 0, versionName: String(marker.versionName || '') }
      : { codeVersion: 0, versionName: '', stale: true }
  }
  return map
}

/**
 * 环境 → 群控设备 id：执行端注册后写在 device_identity_<环境>.json（gc_ads/enroll.py）。
 * 只读 device_id，令牌不碰。没注册过（没文件）或 hw_id 对不上给空。
 */
export function executorDeviceId(home, userId) {
  const data = readJson(join(home.root, `device_identity_${userId}.json`))
  return data && data.hw_id === userId ? String(data.device_id || '') : ''
}

/**
 * 给 adspower.js 用的直控句柄：在候选位置里找第一个像样的执行端。
 *
 * 找不到时，启动不报错让人去放文件夹，而是**自己装**（deps.install，见
 * executor-install.js：下载、解压、写配置，进度推给界面），装好接着启动。
 * 没装也就没在跑：停止只关浏览器，状态给空表——这两件事犯不着为了它去下几十 MB。
 */
export function createLocalExecutor(candidates, deps = {}) {
  const { fixed = '', platform = process.platform, install = null, latestPackage = null, alive = executorAlive, sleep = delay,
    embedded = null, prepareEmbedded = null, migrate = migrateLegacyExecutor } = deps
  const list = (Array.isArray(candidates) ? candidates : [candidates]).filter(Boolean)
  const inspectEmbedded = () => (embedded ? inspectEmbeddedExecutor(embedded, { platform }) : { ok: false, missing: true })
  const hasEmbedded = () => !inspectEmbedded().missing
  // 老目录还在就先用它（里面可能有在跑的执行端），等都停了再搬；否则直接用内嵌的
  const legacy = list.map((dir) => inspectExecutorDir(dir, { platform })).find((home) => home.ok)
  let found = legacy || (hasEmbedded() ? inspectEmbedded() : { ok: false })
  const atFixed = inspectExecutorDir(fixed || list[0], { platform })
  const need = () => new Error(atFixed.missing
    ? `本机代理没在跑，要直接起停执行端，但这台电脑上没找到执行端：请把 gc-ads 文件夹放到 ${fixed || list[0] || 'C:\\xianyu\\gc-ads'}`
    : `本机代理没在跑，要直接起停执行端，但 ${atFixed.root} 里的执行端不完整：${atFixed.reason}`)

  // 已装的包比线上旧，而且这台电脑上一个执行端都没在跑，才在启动前顺手换新：
  // 有在跑的就换不了（Windows 上程序文件被占着），硬换只会换出半个包。
  // 只管自己装的固定位置——别处的（老位置、开发态源码）是人放的，不替人动。
  const anyRunning = async (home) => {
    const state = await loadState(home.root, sleep).catch(() => null)
    if (!state) return true
    for (const [uid, entry] of Object.entries(state)) {
      if (entry?.pid && !entry.stopped && await alive(entry.pid, uid === BROKER_KEY ? '' : uid, { platform, startedAt: entry.started_at })) return true
    }
    return false
  }

  const ensureEmbedded = () => {
    const home = inspectEmbedded()
    if (home.ok || !home.needsConfig) return home
    mkdirSync(home.root, { recursive: true })
    prepareEmbedded?.(home)
    return inspectEmbedded()
  }

  const shouldUpgrade = async () => {
    if (hasEmbedded() || !install || !latestPackage || platform !== 'win32') return false
    if (found.kind !== 'packaged' || !fixed || found.root.toLowerCase() !== fixed.toLowerCase()) return false
    let latest = null
    try {
      latest = await latestPackage()
    } catch {
      return false
    }
    if (!(Number(latest?.codeVersion) > Number(found.packageVersion || 0))) return false
    return !await anyRunning(found)
  }

  const ensure = async () => {
    if (hasEmbedded()) {
      if (found.embedded || !found.ok) {
        found = ensureEmbedded()
        if (!found.ok) throw new Error(`内嵌的执行端起不来：${found.reason}`)
        return found
      }
      if (found.kind === 'packaged' && !await anyRunning(found)) {
        try {
          mkdirSync(embedded.dataDir, { recursive: true })
          migrate(found.root, embedded.dataDir)
          found = ensureEmbedded()
          if (!found.ok) throw new Error(found.reason)
        } catch (error) {
          // 搬不成不挡启动：老目录还能用，下次启动再搬
          console.warn(`[executor] 执行端搬进内嵌目录没成，先用老目录：${error?.message || error}`)
          const again = inspectExecutorDir(found.root, { platform })
          if (again.ok) found = again
          else found = ensureEmbedded()
        }
      }
      return found
    }
    if (found.ok) {
      if (await shouldUpgrade()) {
        try {
          found = await install({ upgrade: true })
        } catch (error) {
          // 更新不成不挡启动：旧版照样能跑，下次启动再试
          console.warn(`[executor] 执行端更新没成，先用旧版：${error?.message || error}`)
          const again = inspectExecutorDir(found.root, { platform })
          if (again.ok) found = again
        }
      }
      return found
    }
    if (!install) throw need()
    found = await install()
    return found
  }
  // 起进程前由桌面端先把新代码下好、坏的修好：执行端看到已是最新就不会各下各的。
  // 连不上服务器不挡启动，本机有什么用什么。
  const syncBeforeStart = async (home) => {
    if (!deps.syncCode || home.kind !== 'packaged') return
    try {
      await deps.syncCode(home, diskCodeVersion(home))
    } catch (error) {
      console.warn(`[executor] 启动前同步代码没成，先用本机的：${error?.message || error}`)
    }
  }

  return {
    get ready() { return found.ok },
    get root() { return found.root || '' },
    start: (userId) => inStartQueue(async () => {
      const home = await ensure()
      await syncBeforeStart(home)
      return startLocalExecutor(home, userId, deps)
    }),
    stop: async (userId, stopBrowser) => {
      if (found.ok) return stopLocalExecutor(found, userId, { ...deps, stopBrowser })
      const notes = ['这台电脑还没装执行端，本就没在跑']
      if (stopBrowser && deps.closeBrowser) {
        try {
          await deps.closeBrowser(userId)
          notes.push('浏览器已关')
        } catch (error) {
          notes.push(`关浏览器失败: ${error?.message || error}`)
        }
      }
      return { user_id: String(userId || ''), ok: true, note: notes.join('；') }
    },
    status: async () => (found.ok ? localExecutorStatus(found, deps) : {}),
    resume: () => inStartQueue(async () => {
      const home = await ensure()
      await syncBeforeStart(home)
      return resumeLocalExecutors(home, deps)
    }),
    // 版本：磁盘上下好的那份 + 每个在跑的执行端实际跑的那份（见 runningCodeVersions）
    versions: async () => (found.ok
      ? { kind: found.kind, root: found.root, disk: diskCodeVersion(found), running: await runningCodeVersions(found, deps) }
      : { kind: '', root: '', disk: null, running: {} }),
    deviceIdOf: (userId) => (found.ok ? executorDeviceId(found, userId) : '')
  }
}
