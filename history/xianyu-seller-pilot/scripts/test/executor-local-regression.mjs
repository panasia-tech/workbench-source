// 本机代理不在时，执行端由行情台直接起停（src/main/executor-local.js）。
//
// 代理不是必须项：它不在只该失去跨进程节流与归属保护，不该让「登录闲鱼」「启动执行端」
// 失灵。这里钉死几条最容易做歪的：
//   1. 和代理读写**同一本台账** run/supervisor.json，格式照 supervisor.py——别的条目
//      （包括代理自己的 ::broker）一个字都不能丢；
//   2. 已在跑就不再拉第二个（两个执行端会抢同一个浏览器），但浏览器要再确认一次；
//   3. 先开浏览器再拉进程：AdsPower 的错当场报，不埋进执行端日志；
//   4. 起来就退的进程要当场说出来，不能回一句「已拉起」；
//   5. 台账读坏了宁可报错也不覆盖；
//   6. 停止要记「人工停止」，看门狗见了就不再拉起。
// 最后用一个真进程（假执行端）把拉起、脱离、存活判断、停止整条走一遍。
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  inspectEmbeddedExecutor,
  createLocalExecutor,
  executorAlive,
  executorDirCandidates,
  inspectExecutorDir,
  localExecutorStatus,
  startLocalExecutor,
  stopLocalExecutor
} from '../../src/main/executor-local.js'

const made = []
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}

/** 一个打包形态的执行端文件夹：gc-ads 程序 + config.yaml。 */
function packagedHome(state = null, program = '#!/bin/sh\nexit 0\n') {
  const root = tempDir('gc-ads-')
  writeFileSync(join(root, 'gc-ads'), program)
  chmodSync(join(root, 'gc-ads'), 0o755)
  writeFileSync(join(root, 'config.yaml'), 'server: {}\n')
  if (state) {
    mkdirSync(join(root, 'run'))
    writeFileSync(join(root, 'run', 'supervisor.json'), JSON.stringify(state, null, 1))
  }
  const found = inspectExecutorDir(root, { platform: 'darwin' })
  assert.ok(found.ok, found.reason)
  return found
}

const readState = (home) => JSON.parse(readFileSync(join(home.root, 'run', 'supervisor.json'), 'utf8'))

/** 假 spawn：记下怎么被叫的，回一个可以手动触发 exit 的假子进程。 */
function fakeSpawn({ pid = 4242, exitWith = null } = {}) {
  const calls = []
  const spawn = (program, args, options) => {
    calls.push({ program, args, options })
    const child = new EventEmitter()
    child.pid = pid
    child.unref = () => { child.unrefed = true }
    if (exitWith !== null) setTimeout(() => child.emit('exit', exitWith), 5)
    calls.at(-1).child = child
    return child
  }
  return { spawn, calls }
}

const noSleep = async () => {}
const fixedNow = () => new Date(2026, 9, 6, 13, 5, 9)

// --- 0. 认文件夹 ------------------------------------------------------------
{
  assert.equal(inspectExecutorDir('').ok, false)
  assert.match(inspectExecutorDir('/definitely/not/here').reason, /找不到这个文件夹/)

  const empty = tempDir('gc-empty-')
  assert.match(inspectExecutorDir(empty).reason, /没有执行端/, '空文件夹不能当执行端')

  // 源码形态：main.py + .venv
  const source = tempDir('gc-src-')
  writeFileSync(join(source, 'main.py'), '')
  mkdirSync(join(source, '.venv', 'bin'), { recursive: true })
  writeFileSync(join(source, '.venv', 'bin', 'python'), '')
  assert.match(inspectExecutorDir(source).reason, /缺 config\.yaml/, '没有 config.yaml 的执行端起来就退，选的时候就要拦')
  writeFileSync(join(source, 'config.yaml'), '')
  const src = inspectExecutorDir(source, { platform: 'darwin' })
  assert.equal(src.kind, 'source')
  assert.equal(src.program, join(source, '.venv', 'bin', 'python'))

  // Windows 上找的是 gc-ads.exe
  const win = tempDir('gc-win-')
  writeFileSync(join(win, 'gc-ads.exe'), '')
  writeFileSync(join(win, 'config.yaml'), '')
  assert.equal(inspectExecutorDir(win, { platform: 'win32' }).kind, 'packaged')
  assert.equal(inspectExecutorDir(win, { platform: 'darwin' }).ok, false)
}

// --- 1. 拉起：命令行、工作目录、台账格式都照 supervisor ------------------------
{
  const home = packagedHome({
    '::broker': { pid: 1, log: '/x/broker.log', started_at: '2026-09-15 20:13:40', stopped: false },
    other: { pid: 2, log: '/x/executor_other.log', started_at: '2026-09-14 02:58:10', stopped: true }
  })
  const opened = []
  const { spawn, calls } = fakeSpawn()
  const result = await startLocalExecutor(home, 'k1new', {
    spawn, alive: async () => false, sleep: noSleep, now: fixedNow, bootWatchMs: 0,
    openBrowser: async (id) => opened.push(id)
  })
  assert.equal(result.ok, true)
  assert.match(result.note, /pid=4242/)
  assert.deepEqual(opened, ['k1new'], '拉进程前要先开浏览器')

  const [call] = calls
  assert.equal(call.program, join(home.root, 'gc-ads'))
  assert.deepEqual(call.args, ['executor', '--config', 'config.yaml', '--user-id', 'k1new'],
    '拉起命令要和 supervisor._executor_cmd 一字不差，看门狗靠命令行认进程')
  assert.equal(call.options.cwd, home.root, '执行端按工作目录找 config.yaml 和身份文件')
  assert.equal(call.options.detached, true, '行情台退出后执行端要照跑')
  assert.equal(call.child.unrefed, true)

  const state = readState(home)
  assert.deepEqual(state.k1new, {
    pid: 4242,
    log: join(home.root, 'logs', 'executor_k1new.log'),
    started_at: '2026-10-06 13:05:09',
    stopped: false
  })
  assert.equal(state['::broker'].pid, 1, '代理自己的条目不能被抹掉')
  assert.equal(state.other.stopped, true, '别的环境的「人工停止」不能被抹掉')
}

// --- 2. 源码形态用 .venv 里的 python 跑 main.py ------------------------------
{
  const root = tempDir('gc-src2-')
  writeFileSync(join(root, 'main.py'), '')
  writeFileSync(join(root, 'config.yaml'), '')
  mkdirSync(join(root, '.venv', 'bin'), { recursive: true })
  writeFileSync(join(root, '.venv', 'bin', 'python'), '')
  const home = inspectExecutorDir(root, { platform: 'darwin' })
  const { spawn, calls } = fakeSpawn()
  await startLocalExecutor(home, 'k1src', {
    spawn, alive: async () => false, sleep: noSleep, bootWatchMs: 0, openBrowser: async () => {}
  })
  assert.equal(calls[0].program, join(root, '.venv', 'bin', 'python'))
  assert.deepEqual(calls[0].args, ['main.py', '--config', 'config.yaml', '--user-id', 'k1src'])
}

// --- 3. 已在跑：不拉第二个，但浏览器要再确认 ----------------------------------
{
  const home = packagedHome({ k1run: { pid: 777, log: '', started_at: '', stopped: false } })
  const opened = []
  const { spawn, calls } = fakeSpawn()
  const result = await startLocalExecutor(home, 'k1run', {
    spawn, sleep: noSleep, bootWatchMs: 0,
    alive: async (pid, uid) => pid === 777 && uid === 'k1run',
    openBrowser: async (id) => opened.push(id)
  })
  assert.equal(calls.length, 0, '两个执行端会抢同一个浏览器的标签页')
  assert.deepEqual(opened, ['k1run'], '执行端在跑 ≠ 浏览器在跑，浏览器被手动关掉时要能开回来')
  assert.match(result.note, /已在跑/)

  // 人工停过的不算在跑：再点启动就该真的拉起来
  const stopped = packagedHome({ k1run: { pid: 777, log: '', started_at: '', stopped: true } })
  const again = fakeSpawn({ pid: 778 })
  await startLocalExecutor(stopped, 'k1run', {
    spawn: again.spawn, sleep: noSleep, bootWatchMs: 0,
    alive: async () => true, openBrowser: async () => {}
  })
  assert.equal(again.calls.length, 1)
  assert.equal(readState(stopped).k1run.stopped, false)
  assert.equal(readState(stopped).k1run.pid, 778)
}

// --- 4. 浏览器开不了：报 AdsPower 的原话，不拉进程 ----------------------------
{
  const home = packagedHome()
  const { spawn, calls } = fakeSpawn()
  await assert.rejects(
    () => startLocalExecutor(home, 'k1gone', {
      spawn, alive: async () => false, sleep: noSleep, bootWatchMs: 0,
      openBrowser: async () => { throw new Error('Profile does not exist') }
    }),
    /Profile does not exist/
  )
  assert.equal(calls.length, 0)
  assert.equal(existsSync(join(home.root, 'run', 'supervisor.json')), false, '没起来就不该记账')
}

// --- 5. 起来就退：当场说出来，带上它最后说的话 --------------------------------
{
  const home = packagedHome()
  mkdirSync(join(home.root, 'logs'))
  writeFileSync(join(home.root, 'logs', 'executor_k1bad.out.log'),
    'Traceback (most recent call last):\nFileNotFoundError: config.yaml\n')
  const { spawn } = fakeSpawn({ exitWith: 1 })
  await assert.rejects(
    () => startLocalExecutor(home, 'k1bad', {
      spawn, alive: async () => false, bootWatchMs: 1_000, openBrowser: async () => {}
    }),
    (error) => /一起来就退出了（退出码 1）/.test(error.message) && /FileNotFoundError/.test(error.message),
    '回一句「已拉起」而进程早没了，人只会觉得点了没反应'
  )
}

// --- 6. 台账读坏了：宁可报错，不覆盖 ------------------------------------------
{
  const home = packagedHome()
  mkdirSync(join(home.root, 'run'))
  writeFileSync(join(home.root, 'run', 'supervisor.json'), '{"k1a": {"pid": 1')
  const { spawn, calls } = fakeSpawn()
  await assert.rejects(
    () => startLocalExecutor(home, 'k1b', {
      spawn, alive: async () => false, sleep: noSleep, bootWatchMs: 0, openBrowser: async () => {}
    }),
    /台账读不出来/
  )
  assert.equal(calls.length, 0)
  assert.equal(readFileSync(join(home.root, 'run', 'supervisor.json'), 'utf8'), '{"k1a": {"pid": 1',
    '当成空表写回去，别的环境的条目就全没了')
}

// --- 7. 停止：先停进程再关浏览器，记「人工停止」 ------------------------------
{
  const home = packagedHome({
    k1stop: { pid: 900, log: '/x/executor_k1stop.log', started_at: '2026-10-06 10:00:00', stopped: false },
    '::broker': { pid: 1, stopped: false }
  })
  const order = []
  let living = true
  const result = await stopLocalExecutor(home, 'k1stop', {
    stopBrowser: true,
    sleep: noSleep,
    alive: async () => living,
    kill: (pid, signal) => { order.push(`${signal}:${pid}`); living = false },
    closeBrowser: async (id) => order.push(`close:${id}`)
  })
  assert.deepEqual(order, ['SIGTERM:900', 'close:k1stop'],
    '顺序不能反：先关浏览器的话，执行端的自愈几秒内就把它重开')
  assert.match(result.note, /已停止/)
  const state = readState(home)
  assert.equal(state.k1stop.stopped, true, '看门狗认这个记号：人工停的不再拉起')
  assert.equal(state.k1stop.pid, 900)
  assert.equal(state.k1stop.log, '/x/executor_k1stop.log')
  assert.ok(state['::broker'])

  // SIGTERM 不理就 SIGKILL（同 supervisor）
  const stubborn = packagedHome({ k1hard: { pid: 901, stopped: false } })
  const signals = []
  await stopLocalExecutor(stubborn, 'k1hard', {
    sleep: noSleep,
    alive: async () => !signals.includes('SIGKILL'),
    kill: (_pid, signal) => signals.push(signal),
    closeBrowser: async () => {}
  })
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])

  // 本就没在跑：照样记上「人工停止」
  const idle = packagedHome()
  const note = await stopLocalExecutor(idle, 'k1idle', {
    sleep: noSleep, alive: async () => false, kill: () => assert.fail('没在跑不该发信号')
  })
  assert.match(note.note, /本就没在跑/)
  assert.equal(readState(idle).k1idle.stopped, true)
}

// --- 8. 状态：形状对齐代理给界面的那份，代理条目不算环境 ----------------------
{
  const home = packagedHome({
    '::broker': { pid: 1, stopped: false },
    k1on: { pid: 10, stopped: false },
    k1dead: { pid: 11, stopped: false },
    k1off: { pid: 12, stopped: true }
  })
  const map = await localExecutorStatus(home, { sleep: noSleep, alive: async (pid) => pid === 10 || pid === 12 })
  assert.deepEqual(Object.keys(map).sort(), ['k1dead', 'k1off', 'k1on'])
  assert.equal(map.k1on.executor, '运行中 (pid=10)')
  assert.equal(map.k1dead.executor, '已停止')
  assert.equal(map.k1off.executor, '已停止（人工）', '人工停了的就算 pid 还在也不算在跑')
  // 界面用 /运行中|pid=/ 判断在不在跑
  assert.ok(!/运行中|pid=/.test(map.k1dead.executor) && !/运行中|pid=/.test(map.k1off.executor))
}

// --- 9. 固定位置：Windows C:\gc-ads、Mac ~/gc-ads，老位置兜底，找不到就直说放哪 ---
// 不让人去选「执行端位置」（2026-10-06 用户：「这个执行端位置是个啥？直接固定位置」）。
{
  const win = executorDirCandidates({ platform: 'win32', home: 'C:/Users/op', appData: 'C:/Users/op/AppData/Roaming' })
  assert.equal(win.fixed, 'C:\\xianyu\\gc-ads', '放在项目自己的文件夹里，不摊在盘符根下')
  assert.equal(win.list[0], 'C:\\xianyu\\gc-ads', '固定位置排第一')
  assert.equal(win.list[1], 'C:\\gc-ads', '同一天短暂用过的 C:\\gc-ads 照认')
  assert.ok(win.list.some((dir) => dir.includes('群控守护')) && win.list.some((dir) => dir.includes('groupcontrol-desktop')),
    '守护端以前一键安装到它自己的数据目录，老安装要照样认得')
  const mac = executorDirCandidates({ platform: 'darwin', home: '/Users/op' })
  assert.equal(mac.fixed, join('/Users/op', 'xianyu', 'gc-ads'))
  assert.deepEqual(mac.list, [mac.fixed, join('/Users/op', 'gc-ads')], '没给数据目录和开发目录时只看固定位置和它的老位置')

  const fixed = join(tempDir('gc-none-'), 'gc-ads')   // 不存在的固定位置
  const none = createLocalExecutor([fixed], { fixed })
  assert.equal(none.ready, false)
  await assert.rejects(() => none.start('k1'), (error) => error.message.includes(`请把 gc-ads 文件夹放到 ${fixed}`),
    '没给安装能力时（比如测试），找不到要直接说放哪')
  // 没装也就没在跑：状态给空表、停止只关浏览器，犯不着为这两件事去下几十 MB
  assert.deepEqual(await none.status(), {})
  const closed = []
  const stopper = createLocalExecutor([fixed], { fixed, closeBrowser: async (id) => closed.push(id) })
  assert.match((await stopper.stop('k1', true)).note, /还没装执行端.*浏览器已关/)
  assert.deepEqual(closed, ['k1'])

  const broken = tempDir('gc-broken-')   // 放了文件夹，里面不是执行端
  await assert.rejects(() => createLocalExecutor([broken], { fixed: broken }).start('k1'), /执行端不完整：这个文件夹里没有执行端/)

  // 固定位置没有、老位置有：用老的
  const legacy = packagedHome()
  const found = createLocalExecutor([fixed, legacy.root], { fixed })
  assert.equal(found.ready, true)
  assert.equal(found.root, legacy.root)
}

// --- 9b. 找不到就自己装，装好接着启动（2026-10-06 用户：「找不到就自己下载」）---------
{
  const fixed = join(tempDir('gc-auto-'), 'gc-ads')
  let installs = 0
  const { spawn, calls } = fakeSpawn({ pid: 5151 })
  const local = createLocalExecutor([fixed], {
    fixed, spawn, alive: async () => false, sleep: noSleep, bootWatchMs: 0, openBrowser: async () => {},
    install: async () => {
      installs++
      mkdirSync(fixed, { recursive: true })
      writeFileSync(join(fixed, 'gc-ads'), '#!/bin/sh\nexit 0\n')
      writeFileSync(join(fixed, 'config.yaml'), '')
      return inspectExecutorDir(fixed, { platform: 'darwin' })
    }
  })
  assert.equal(local.ready, false)
  const result = await local.start('k1auto')
  assert.equal(installs, 1, '找不到执行端时，启动要先自己装')
  assert.equal(calls.length, 1, '装好接着启动，不要人再点一次')
  assert.match(result.note, /pid=5151/)
  assert.equal(local.ready, true)
  await local.start('k1auto2')
  assert.equal(installs, 1, '装过一次就不再装')
}

// --- 9c. 工位上的包比线上旧：一个执行端都没在跑时，启动前顺手换新 -------------------
{
  const fixed = join(tempDir('gc-up-'), 'gc-ads')
  const setVersion = (version) => {
    mkdirSync(join(fixed, '_internal'), { recursive: true })
    writeFileSync(join(fixed, 'gc-ads.exe'), 'MZ')
    writeFileSync(join(fixed, 'config.yaml'), '')
    const file = join(fixed, '_internal', 'builtin-code-version.json')
    if (version) writeFileSync(file, JSON.stringify({ codeVersion: version }))
    else rmSync(file, { force: true })
  }
  setVersion(0)
  assert.equal(inspectExecutorDir(fixed, { platform: 'win32' }).packageVersion, 0, '09-10 的老包没有版本文件，按 0 算')
  const upgrades = []
  const deps = (over = {}) => ({
    fixed, platform: 'win32', spawn: fakeSpawn({ pid: 6161 }).spawn, alive: async () => false, sleep: noSleep,
    bootWatchMs: 0, openBrowser: async () => {},
    latestPackage: async () => ({ codeVersion: 2 }),
    install: async (options) => {
      upgrades.push(options)
      setVersion(2)
      return inspectExecutorDir(fixed, { platform: 'win32' })
    },
    ...over
  })

  await createLocalExecutor([fixed], deps()).start('k1')
  assert.deepEqual(upgrades, [{ upgrade: true }], '旧包、没在跑：启动前先换新')
  await createLocalExecutor([fixed], deps()).start('k1')
  assert.equal(upgrades.length, 1, '已是新版就不再换')

  setVersion(0)
  writeFileSync(join(fixed, 'run', 'supervisor.json'), JSON.stringify({ k1other: { pid: 777 } }))
  await createLocalExecutor([fixed], deps({ alive: async (pid) => pid === 777 })).start('k1')
  assert.equal(upgrades.length, 1, '别的环境的执行端还在跑：这次不换（文件被占着，硬换只会换出半个包）')

  writeFileSync(join(fixed, 'run', 'supervisor.json'), '{}')
  await createLocalExecutor([fixed], deps({ latestPackage: async () => { throw new Error('offline') } })).start('k1')
  assert.equal(upgrades.length, 1, '查不到线上版本就照常用本机的')

  const result = await createLocalExecutor([fixed], deps({ install: async () => { throw new Error('download failed') } })).start('k1')
  assert.match(result.note, /pid=6161/, '换新失败不挡启动：旧版照样起')

  const elsewhere = packagedHome()
  await createLocalExecutor([fixed, elsewhere.root], { ...deps(), fixed: join(tempDir('gc-empty-'), 'gc-ads'), platform: 'darwin' })
    .start('k1')
  assert.equal(upgrades.length, 1, '人放在别处的执行端、Mac 上的源码：不替人换')
}

// --- 10. 真进程：拉起 → 脱离 → 认得出是它 → 停掉 -----------------------------
// 用一个假执行端（node 脚本，命令行和真执行端同形）把整条在本机真跑一遍。
// 假执行端靠 shebang 指向 node，路径里有空格时 shebang 用不了，就跳过这一段。
if (process.platform !== 'win32' && !/\s/.test(process.execPath)) {
  const program = `#!${process.execPath}\nsetInterval(() => {}, 1000)\n`
  const home = packagedHome(null, program)
  const real = await startLocalExecutor(home, 'k1real', { openBrowser: async () => {}, bootWatchMs: 800 })
  const pid = readState(home).k1real.pid
  try {
    assert.match(real.note, new RegExp(`pid=${pid}`))
    assert.equal(await executorAlive(pid, 'k1real'), true, '命令行里有 --user-id 和 executor，应认作该环境的执行端')
    assert.equal(await executorAlive(pid, 'k1other'), false, 'pid 复用防线：别的环境的 id 不能认成它')

    const again = await startLocalExecutor(home, 'k1real', { openBrowser: async () => {} })
    assert.match(again.note, /已在跑/, '真在跑时再点启动不能拉第二个')

    const status = await localExecutorStatus(home)
    assert.equal(status.k1real.executor, `运行中 (pid=${pid})`)

    await stopLocalExecutor(home, 'k1real', { closeBrowser: async () => {} })
    assert.equal(await executorAlive(pid, 'k1real'), false, '停止后进程必须真的没了')
    assert.equal((await localExecutorStatus(home)).k1real.executor, '已停止（人工）')
  } finally {
    try { process.kill(pid, 'SIGKILL') } catch { /* 已经停了 */ }
  }

  // 真进程起来就退：退出码和它最后说的话都要带回来
  const crashing = packagedHome(null, `#!${process.execPath}\nconsole.error('config.yaml 里没填 enroll_secret')\nprocess.exit(3)\n`)
  await assert.rejects(
    () => startLocalExecutor(crashing, 'k1crash', { openBrowser: async () => {}, bootWatchMs: 3_000 }),
    (error) => /退出码 3/.test(error.message) && /enroll_secret/.test(error.message)
  )
}

// --- 9. 开机自恢复：拉起非人工停止的，跳过 broker 和人工停止，单点失败不拖垮 -------
{
  const { resumeLocalExecutors } = await import('../../src/main/executor-local.js')
  const home = packagedHome({
    k1dead: { pid: 111, log: '', started_at: '', stopped: false },   // 进程死了 → 该拉起
    k1live: { pid: 222, log: '', started_at: '', stopped: false },   // 还在跑 → 不再拉第二个，只确认浏览器
    k1off: { pid: 333, log: '', started_at: '', stopped: true },     // 人工停过 → 尊重标记，绝不动
    '::broker': { pid: 444, stopped: false }                          // 代理条目 → 跳过
  })
  const opened = []
  const { spawn, calls } = fakeSpawn({ pid: 555 })
  const results = await resumeLocalExecutors(home, {
    spawn, sleep: noSleep, bootWatchMs: 0,
    alive: async (pid, uid) => pid === 222 && uid === 'k1live',
    openBrowser: async (id) => opened.push(id)
  })
  assert.equal(results.length, 2, '只恢复 k1dead 和 k1live：broker 与人工停止的一个都不能碰')
  assert.equal(calls.length, 1, '在跑的 k1live 不能再拉第二个（两个执行端抢同一个浏览器）')
  assert.deepEqual(opened.sort(), ['k1dead', 'k1live'], '两个环境的浏览器都要确认')
  assert.equal(readState(home).k1dead.pid, 555)
  assert.equal(readState(home).k1off.stopped, true, '人工停止标记原样保留，看门狗语义不破坏')
  assert.ok(results.every((r) => r.ok))

  // 单点失败不拖垮：一个环境浏览器开不了，另一个照常拉起
  const mixed = packagedHome({
    k1bad: { pid: 111, log: '', started_at: '', stopped: false },
    k1good: { pid: 112, log: '', started_at: '', stopped: false }
  })
  const again = fakeSpawn({ pid: 777 })
  const mixedResults = await resumeLocalExecutors(mixed, {
    spawn: again.spawn, sleep: noSleep, bootWatchMs: 0,
    alive: async () => false,
    openBrowser: async (id) => { if (id === 'k1bad') throw new Error('Profile does not exist') }
  })
  assert.equal(mixedResults.length, 2)
  const bad = mixedResults.find((r) => r.user_id === 'k1bad')
  const good = mixedResults.find((r) => r.user_id === 'k1good')
  assert.equal(bad.ok, false)
  assert.match(bad.note, /Profile does not exist/)
  assert.equal(good.ok, true, '一个环境起不来绝不能影响其他环境复工')
  assert.equal(again.calls.length, 1)

  // 全是人工停止/代理：什么都不做
  const quiet = packagedHome({
    k1off: { pid: 333, log: '', started_at: '', stopped: true },
    '::broker': { pid: 444, stopped: false }
  })
  const nobody = fakeSpawn()
  const quietResults = await resumeLocalExecutors(quiet, {
    spawn: nobody.spawn, sleep: noSleep, bootWatchMs: 0,
    alive: async () => false, openBrowser: async () => {}
  })
  assert.equal(quietResults.length, 0)
  assert.equal(nobody.calls.length, 0, '人工停过的机器，开机绝不能替人反悔拉起来')
}

{
  // 内嵌：程序在安装目录，数据在 dataDir；进程带 GC_ADS_HOME
  const programDir = tempDir('gc-embedded-')
  const dataDir = join(tempDir('gc-data-'), 'executor')
  const exe = join(programDir, process.platform === 'win32' ? 'gc-ads.exe' : 'gc-ads')
  writeFileSync(exe, '#!/bin/sh\n')
  mkdirSync(join(programDir, '_internal'))
  writeFileSync(join(programDir, '_internal', 'builtin-code-version.json'), JSON.stringify({ codeVersion: 11, versionName: '0.3.0' }))
  assert.equal(inspectEmbeddedExecutor({ programDir: tempDir('gc-empty-'), dataDir }).missing, true, '老安装包里没有程序')
  const spawned = []
  const fakeSpawn = (program, args, options) => {
    spawned.push({ program, options })
    const child = new EventEmitter()
    child.pid = 4321
    child.unref = () => {}
    return child
  }
  const local = createLocalExecutor([join(dataDir, 'none')], {
    embedded: { programDir, dataDir },
    prepareEmbedded: (home) => writeFileSync(join(home.root, 'config.yaml'), 'server: {}\n'),
    openBrowser: async () => {},
    spawn: fakeSpawn,
    alive: async () => false,
    bootWatchMs: 1
  })
  await local.start('k9')
  assert.equal(spawned[0].program, exe)
  assert.equal(spawned[0].options.cwd, dataDir)
  assert.equal(spawned[0].options.env.GC_ADS_HOME, dataDir)
  const versions = await local.versions()
  assert.equal(versions.disk.codeVersion, 11, '内置版本从安装目录读')

  // 老目录：有在跑的先不搬；都停了才搬，身份和台账带过来，老目录留作 .migrated
  const legacy = tempDir('gc-legacy-')
  writeFileSync(join(legacy, process.platform === 'win32' ? 'gc-ads.exe' : 'gc-ads'), '#!/bin/sh\n')
  writeFileSync(join(legacy, 'config.yaml'), 'server: legacy\n')
  writeFileSync(join(legacy, 'device_identity_k8.json'), '{"device_id":"d8","hw_id":"k8"}')
  mkdirSync(join(legacy, 'run'))
  writeFileSync(join(legacy, 'run', 'supervisor.json'), JSON.stringify({ k8: { pid: 77, stopped: false } }))
  const data2 = join(tempDir('gc-data2-'), 'executor')
  const options = {
    embedded: { programDir, dataDir: data2 },
    prepareEmbedded: () => { throw new Error('有老配置就不该生成') },
    openBrowser: async () => {},
    spawn: fakeSpawn,
    bootWatchMs: 1
  }
  await createLocalExecutor([legacy], { ...options, alive: async () => true }).start('k8')
  assert.equal(existsSync(legacy), true, '老目录里有在跑的，不能搬')
  spawned.length = 0
  await createLocalExecutor([legacy], { ...options, alive: async () => false }).start('k8')
  assert.equal(existsSync(legacy), false)
  assert.equal(existsSync(`${legacy}.migrated`), true)
  assert.equal(readFileSync(join(data2, 'config.yaml'), 'utf8'), 'server: legacy\n')
  assert.equal(JSON.parse(readFileSync(join(data2, 'device_identity_k8.json'), 'utf8')).device_id, 'd8')
  assert.equal(spawned[0].options.env.GC_ADS_HOME, data2)
  made.push(`${legacy}.migrated`)

  // 老目录被占着：这次不搬，照常用老目录起
  const busy = packagedHome()
  const busyData = join(tempDir('gc-data3-'), 'executor')
  spawned.length = 0
  await createLocalExecutor([busy.root], {
    embedded: { programDir, dataDir: busyData },
    prepareEmbedded: () => {},
    migrate: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }) },
    openBrowser: async () => {},
    spawn: fakeSpawn,
    alive: async () => false,
    bootWatchMs: 1
  }).start('k7')
  assert.equal(spawned[0].options.cwd, busy.root)

  // 启动前先同步代码；同步失败不挡启动；同时点两个也一个个起
  const order = []
  const queued = createLocalExecutor([join(dataDir, 'none')], {
    embedded: { programDir, dataDir },
    syncCode: async () => { order.push('sync'); throw new Error('offline') },
    openBrowser: async (uid) => { order.push(`start ${uid}`) },
    spawn: fakeSpawn,
    alive: async () => false,
    bootWatchMs: 1
  })
  await Promise.all([queued.start('q1'), queued.start('q2')])
  assert.deepEqual(order, ['sync', 'start q1', 'sync', 'start q2'])
}

for (const dir of made) rmSync(dir, { recursive: true, force: true })
console.log('executor-local-regression: PASS')
