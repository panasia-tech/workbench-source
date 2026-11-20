'use strict'
/**
 * 闲鱼行情工作台 —— 启动加载器（安装包入口，永不变更）。
 *
 * 热更新机制：应用代码（out/main、out/preload、out/renderer）整体可被
 * userData/code/ 下的新版本替换。启动时优先加载 userData/code/main/index.js，
 * 不存在或加载失败就回退安装包内置版本，保证永远起得来。
 *
 * 发新版 = 把 out/ 传到服务器静态目录 + 更新 market-workbench-code-version.json，
 * 客户端后台下载后重启即换新，不用重打 dmg。
 *
 * 这个文件是唯一不能被热更新的部分，改它必须重新打包，所以尽量别改。
 */
const { app } = require('electron')
const path = require('path')
const fs = require('fs')
const Module = require('module')

const HOT_CODE_DIR = () => path.join(app.getPath('userData'), 'code')
const HOT_MAIN = () => path.join(HOT_CODE_DIR(), 'main', 'index.js')
// 上一次启动是否走到「窗口起来了」。主进程在 ready 后删掉它；
// 启动时还在，说明上一版热更新代码加载成功却没能跑起来（更阴的一类坏版本）。
const BOOT_PENDING = () => path.join(app.getPath('userData'), 'code-boot-pending')

/**
 * 热更新副本在 userData 下，Node 从那里向上找不到安装包 asar 里的 node_modules，
 * require('axios') 这类外部依赖会直接解析失败（构建用了 externalizeDepsPlugin，
 * 依赖不进 bundle）。这里把安装包的 node_modules 补进模块查找路径。
 *
 * 注意别用 Module.globalPaths.push：那个数组是初始化时的副本，改它对解析没有任何
 * 影响（实测过）。真正生效的是 NODE_PATH + Module._initPaths()。_initPaths 是内部
 * API，所以再挂一层 _resolveFilename 兜底——loader 是唯一不能热更新的文件，
 * 它要是失手，只能靠重新打包救。
 */
function exposeBundledModules() {
  const bundled = path.join(__dirname, 'node_modules')
  try {
    process.env.NODE_PATH = [process.env.NODE_PATH, bundled].filter(Boolean).join(path.delimiter)
    Module._initPaths()
  } catch (e) {
    console.error('[loader] NODE_PATH 注入失败，改用解析兜底：', e)
  }
  try {
    if (Module.__bundledFallbackInstalled) return
    const originalResolve = Module._resolveFilename
    Module._resolveFilename = function (request, parent, isMain, options) {
      try {
        return originalResolve.call(this, request, parent, isMain, options)
      } catch (err) {
        if (err && err.code === 'MODULE_NOT_FOUND') {
          return originalResolve.call(this, request, parent, isMain, { ...(options || {}), paths: [bundled] })
        }
        throw err
      }
    }
    Module.__bundledFallbackInstalled = true
  } catch (_) { /* 兜底装不上就让内置版本接管 */ }
}

function quarantine(dir, why) {
  try {
    fs.renameSync(dir, `${dir}.broken-${Date.now()}`)
    console.error(`[loader] 热更新副本已隔离（${why}）`)
  } catch (_) { /* 隔离失败也要继续启动 */ }
}

function loadMain() {
  // 开发态永远跑源码构建产物，不受本机热更新副本干扰。
  if (!app.isPackaged) return require(path.join(__dirname, 'out', 'main', 'index.js'))
  // 内置 code-version.json 就是「这个构建启不启用热更新」的开关：只有行情工作台
  // 的 electron-builder 配置会打包它。巡航台共用同一份代码，但它依赖 asar 里的
  // resources/，而热更副本跑在 userData 下会把模块相对路径解析到别处，所以那边
  // 保持整包分发。
  if (!fs.existsSync(path.join(__dirname, 'code-version.json'))) {
    return require(path.join(__dirname, 'out', 'main', 'index.js'))
  }

  const codeDir = HOT_CODE_DIR()
  const hotMain = HOT_MAIN()
  const pending = BOOT_PENDING()
  try {
    if (fs.existsSync(hotMain)) {
      if (fs.existsSync(pending)) {
        // 上一次用这份代码启动没能走到窗口就绪，别再撞第二次。
        quarantine(codeDir, '上次启动未能就绪')
        fs.rmSync(pending, { force: true })
      } else {
        fs.mkdirSync(path.dirname(pending), { recursive: true })
        fs.writeFileSync(pending, new Date().toISOString())
        exposeBundledModules()
        require(hotMain)
        return
      }
    }
  } catch (e) {
    console.error('[loader] 热更新版本加载失败，回退内置版本：', e)
    quarantine(codeDir, e && e.message ? e.message : String(e))
    try { fs.rmSync(pending, { force: true }) } catch (_) { /* 忽略 */ }
  }
  require(path.join(__dirname, 'out', 'main', 'index.js'))
}

loadMain()
