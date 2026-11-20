"use strict";
/**
 * 群控桌面端 - 启动加载器(安装包的入口,永不变更)。
 *
 * 热更新机制:应用逻辑(main.js/preload.js/renderer/)全部可被 userData/code/ 下的
 * 新版本替换。启动时优先加载 userData/code/main.js;不存在或加载失败(新版损坏)
 * 自动回退安装包内置版本,保证永远能起得来。
 *
 * 发新版只需把代码文件传到服务器静态目录 + 更新 desktop-code-version.json,
 * 客户端后台下载后提示重启生效,无需重新打安装包。
 */
const { app } = require("electron");
const path = require("path");
const fs = require("fs");

const UPDATED_MAIN = () => path.join(app.getPath("userData"), "code", "main.js");

function loadMain() {
  const updated = UPDATED_MAIN();
  try {
    if (fs.existsSync(updated)) {
      require(updated);
      return;
    }
  } catch (e) {
    // 热更新副本损坏:回退内置版本,并把坏文件挪走(避免每次启动都撞)
    console.error("[loader] 热更新版本加载失败,回退内置版本:", e);
    try {
      fs.renameSync(updated, updated + ".broken-" + Date.now());
    } catch (_) { /* 忽略 */ }
  }
  require(path.join(__dirname, "main.js"));
}

loadMain();
