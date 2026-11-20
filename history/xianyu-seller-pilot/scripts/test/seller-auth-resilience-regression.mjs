// 巡航台登录态收口：单实例、401 自动回登录页、配置写失败不卡退出登录。
// 这些行为跨主进程/preload/渲染层，静态契约测试比启动 Electron 更稳定。
// 跑法：node scripts/test/seller-auth-resilience-regression.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8')

const instance = read('main/instance.js')
const main = read('main/index.js')
const store = read('main/store.js')
const preload = read('preload/index.js')
const renderer = read('renderer/src/main.js')

assert.match(instance, /requestSingleInstanceLock\(\)/, '主进程必须拿单实例锁')
assert.match(instance, /focusMainWindow/, '第二个实例要把第一个窗口叫到前面')
assert.match(main, /second-instance/, '主进程要处理 second-instance')
assert.match(main, /if \(!isPrimaryInstance\) return/, '第二个实例不能启动第二个窗口/调度')
assert.match(main, /webContents\.send\('auth:expired'/, '401 要通知所有窗口')
assert.match(main, /error\?\.response\?\.status === 401/, 'gcCall 要识别 401')
assert.match(main, /登录已过期，请重新登录/, '401 要给人话')
assert.match(main, /hasToken: !!token && !!staff/, 'token 和 staff 同时在才算已登录')
assert.match(preload, /onAuthExpired/, 'preload 要暴露 401 事件订阅')
assert.match(renderer, /auth:expired|onAuthExpired/, '渲染层要订阅 401 事件')
assert.match(renderer, /router\.replace\('\/login'\)/, '401 后要自动回登录页')
assert.match(store, /makeResilientStore/, '配置写盘要走重试封装')
assert.match(store, /authMemoryCleared/, '写盘失败时内存里也要按未登录处理')
assert.match(store, /return \{ ok: false, reason: errors\[0\]\.message \}/, '退出登录要返回明确失败原因')
assert.match(store, /closeAuth|clearAuth/, '退出登录要有统一入口')

console.log('seller-auth-resilience-regression: PASS')
