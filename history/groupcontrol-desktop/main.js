"use strict";
/**
 * 群控桌面端 - 主进程。
 * 职责:adb 设备检测、保活(防息屏/白名单/拉活)、按设备拉起 scrcpy 独立投屏窗口。
 * 逻辑移植自 groupcontrol-adb/gc_adb(keepalive.py / monitor.py / daemon.py)。
 */
const { app, BrowserWindow, ipcMain, screen, dialog, safeStorage } = require("electron");
const { execFile, exec, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const os = require("os");

// ---- 目标 app 与常量(与 groupcontrol-adb/config.example.yaml 对齐) ----
const PKG = "com.erp.groupcontrol";
const MAIN_ACTIVITY = ".ui.MainActivity";
const XY_PKG = "com.taobao.idlefish";
const XY_LOCKED_VERSION = "7.25.80"; // 发布流程坐标按此版本校准,各机必须统一
const NEVER_SLEEP_MS = 2147483647; // int32 上限 ≈ 永不息屏
const POLL_INTERVAL = 5000;

// ---- 群控 App(执行端)在线更新:版本清单与 APK 托管在服务器静态目录 ----
const APP_VERSION_URL = "http://127.0.0.1:8000";
const XIANYU_VERSION_URL = "http://127.0.0.1:8000";
const APP_UPDATE_CHECK_MS = 30 * 60 * 1000; // 启动查一次,之后每 30 分钟复查

// ---- 可执行文件定位:env > 缓存 > 打包资源目录 > 应用 vendor > 仓库内分发包 > PATH ----
// 解析一次后缓存到内存 + 本地配置文件,避免每条 adb 命令都重复扫盘(移植自另一台设备的版本)
const CONFIG_FILE = () => path.join(app.getPath("userData"), "gc-paths.json");
let cachedPaths = null; // { adb, scrcpy }

function loadCachedPaths() {
  if (cachedPaths) return cachedPaths;
  try {
    const p = CONFIG_FILE();
    if (fs.existsSync(p)) {
      cachedPaths = JSON.parse(fs.readFileSync(p, "utf8"));
      // 缓存的路径必须真实存在,否则重新解析
      if (cachedPaths.adb && !fs.existsSync(cachedPaths.adb)) cachedPaths.adb = null;
      if (cachedPaths.scrcpy && !fs.existsSync(cachedPaths.scrcpy)) cachedPaths.scrcpy = null;
      return cachedPaths;
    }
  } catch (_) { /* 配置文件损坏就当没有 */ }
  cachedPaths = { adb: null, scrcpy: null };
  return cachedPaths;
}

function saveCachedPaths() {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE()), { recursive: true });
    fs.writeFileSync(CONFIG_FILE(), JSON.stringify(cachedPaths, null, 2), "utf8");
  } catch (e) {
    log(`保存路径缓存失败: ${e.message}`);
  }
}

function firstExisting(candidates) {
  for (const p of candidates) {
    if (!p) continue;
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) { /* ignore */ }
  }
  return null;
}

function binCandidates(name) {
  const c = [];
  if (process.resourcesPath) c.push(path.join(process.resourcesPath, "scrcpy", name)); // 打包后
  c.push(path.join(__dirname, "vendor", "scrcpy", name)); // 开发期 vendor
  c.push(path.join(__dirname, "..", "groupcontrol-adb", "群控守护", "scrcpy", name)); // 仓库内分发包
  return c;
}

function adbBin() {
  if (process.env.GC_ADB) return process.env.GC_ADB;
  const cache = loadCachedPaths();
  if (cache.adb) return cache.adb;
  cache.adb = firstExisting(binCandidates("adb.exe")) || "adb";
  saveCachedPaths();
  return cache.adb;
}

function scrcpyBin() {
  if (process.env.GC_SCRCPY) return process.env.GC_SCRCPY;
  const cache = loadCachedPaths();
  if (cache.scrcpy) return cache.scrcpy;
  cache.scrcpy = firstExisting(binCandidates("scrcpy.exe")) || "scrcpy";
  saveCachedPaths();
  return cache.scrcpy;
}

// 在线更新下载的 APK 存放处(userData:打包后也可写,优先级高于随包旧版)
function downloadedApkPath() {
  return path.join(app.getPath("userData"), "apk", "gc-app.apk");
}

// 随包 APK 定位:env > 在线更新下载(userData) > 打包资源目录 > 应用 vendor > 仓库内 gradle 构建产物(开发期)
// (ASCII 文件名优先,兼容中文名——避免 Windows 解压 zip 时中文名乱码)
function apkPath() {
  if (process.env.GC_APK && fs.existsSync(process.env.GC_APK)) return process.env.GC_APK;
  const dl = downloadedApkPath();
  if (fs.existsSync(dl)) return dl;
  const names = ["gc-app.apk", "群控执行端.apk"];
  const dirs = [];
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, "app"));
  dirs.push(path.join(__dirname, "vendor", "app"));
  for (const dir of dirs) for (const n of names) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  return firstExisting([path.join(__dirname, "..", "groupcontrol-app", "app", "build", "outputs", "apk", "release", "app-release.apk")]);
}

// 闲鱼统一版本 APK(流程按 7.25.80 校准,机型/版本锁定是坐标级流程的前提)
// 优先级:env > 在线预下载(userData,打包后也可写) > 打包资源目录 > 应用 vendor
function xianyuApkPath() {
  if (process.env.GC_XY_APK && fs.existsSync(process.env.GC_XY_APK)) return process.env.GC_XY_APK;
  const dl = downloadedXianyuPath();
  if (fs.existsSync(dl)) return dl;
  const names = ["xianyu.apk", "闲鱼.apk"];
  const dirs = [];
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, "app"));
  dirs.push(path.join(__dirname, "vendor", "app"));
  for (const dir of dirs) for (const n of names) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---- adb 封装 ----
function runAdb(args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile(adbBin(), args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

// 容错执行:不因非零退出码 reject,用于 kill/taskkill 等清理动作
function execTolerant(cmd, args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

function execShell(cmdline, timeout = 10000) {
  return new Promise((resolve) => {
    exec(cmdline, { timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

// 谁在占用 5037(仅 Windows 诊断,帮用户定位冲突的手机助手类软件)
async function port5037Owner() {
  if (process.platform !== "win32") return "";
  const n = await execShell('netstat -ano | findstr ":5037" | findstr "LISTENING"');
  const m = n.stdout.match(/(\d+)\s*$/m);
  if (!m) return "";
  const t = await execShell(`tasklist /FI "PID eq ${m[1]}" /FO CSV /NH`);
  const name = (t.stdout.match(/^"([^"]+)"/) || [])[1];
  return name ? `${name} (PID ${m[1]})` : `PID ${m[1]}`;
}

// adb server 自愈:kill 残留进程 → 重启 server → 失败则诊断 5037 占用者
let recovering = false;
let lastRecoveryAt = 0;
async function recoverAdb(reason) {
  const now = Date.now();
  if (recovering || now - lastRecoveryAt < 30000) return; // 30 秒防抖,避免每轮轮询都触发
  recovering = true;
  lastRecoveryAt = now;
  try {
    // 等当前轮询收尾(最长15s):否则 taskkill 会把正在执行的 adb 命令一并杀掉,
    // 误报"Command failed(空错误)/device not found"
    for (let waited = 0; polling && waited < 15000; waited += 250) {
      await new Promise((r) => setTimeout(r, 250));
    }
    log(`adb server 异常(${reason}),尝试自动恢复…`);
    await execTolerant(adbBin(), ["kill-server"]);
    if (process.platform === "win32") {
      await execTolerant("taskkill", ["/F", "/IM", "adb.exe"]); // 清掉卡死/残留的 adb 进程
    }
    await new Promise((r) => setTimeout(r, 1200));
    const r = await execTolerant(adbBin(), ["start-server"], 25000);
    if (r.ok) {
      log("adb server 已恢复");
    } else {
      const owner = await port5037Owner();
      const tail = (r.stderr || r.stdout || "").trim().split(/\r?\n/).pop() || "未知错误";
      log(
        `adb 恢复失败: ${tail};` +
          (owner
            ? `5037 端口被 ${owner} 占用,请退出该软件(应用宝/360/华为/小米手机助手等)后点重试`
            : "请关闭其它手机助手类软件后重启本程序")
      );
    }
  } finally {
    recovering = false;
  }
}

function shell(serial, cmd, timeout = 15000) {
  return runAdb(["-s", serial, "shell", cmd], timeout);
}

async function listDevices() {
  const out = await runAdb(["devices"]);
  const devices = [];
  for (const line of out.split(/\r?\n/).slice(1)) {
    const m = line.match(/^(\S+)\s+(device|unauthorized|offline)\s*$/);
    if (m) devices.push({ serial: m[1], state: m[2] });
  }
  return devices;
}

// ---- 健康检测(移植 monitor.py / keepalive.py) ----
async function foregroundPackage(serial) {
  const out = await shell(
    serial,
    "dumpsys activity activities | grep -E 'mResumedActivity|ResumedActivity|topResumedActivity' | head -1"
  );
  for (const tok of out.replace(/[{}]/g, " ").split(/\s+/)) {
    if (tok.includes("/") && tok.split("/")[0].includes(".")) return tok.split("/")[0];
  }
  return "";
}

async function serviceRunning(serial) {
  const out = await shell(serial, `dumpsys activity services ${PKG}`);
  return out.includes("GcService");
}

// 静态信息按 serial 缓存(型号不会变),减少 adb 往返
const modelCache = new Map();
const installedCache = new Map(); // serial -> { value, at }

async function deviceModel(serial) {
  if (modelCache.has(serial)) return modelCache.get(serial);
  try {
    const model = (await shell(serial, "getprop ro.product.model")).trim();
    modelCache.set(serial, model);
    return model;
  } catch (_) {
    return "";
  }
}

// 群控 App 是否已安装(未安装的设备拉活无意义,界面直接标「未装App」)
async function appInstalled(serial) {
  const cached = installedCache.get(serial);
  if (cached && Date.now() - cached.at < 30000) return cached.value; // 30s 缓存
  try {
    const out = await shell(serial, `pm path ${PKG}`);
    const value = out.includes("package:");
    installedCache.set(serial, { value, at: Date.now() });
    return value;
  } catch (_) {
    return true; // 查询失败时不误判为未安装(避免跳过保活)
  }
}

// 读该机当前登录的闲鱼昵称:群控 App 每次上报 identity 会把 {nick,model} 落到外部私有目录,
// 桌面直接 cat(免服务端映射)。读不到(旧版 App/未装/scoped storage 限制)返回 ""。
async function readNick(serial) {
  try {
    const out = await shell(serial, `cat /sdcard/Android/data/${PKG}/files/gc_identity.json`, 8000);
    const m = out.match(/"nick"\s*:\s*"([^"]*)"/); // nick 为 null 时不匹配 → ""
    return m ? m[1] : "";
  } catch (_) {
    return "";
  }
}

// ---- 闲鱼昵称缓存(持久化到 userData/gc-names.json,重启不丢;移植自另一台设备) ----
// gc_identity.json 是主通道(新版 App);旧版 App 读不到文件时,趁执行端在前台的窗口期用
// uiautomator dump 抓界面上的「闲鱼账号:xxx」兜底(执行端前台时自动化不在闲鱼页操作,不冲突)。
const NAMES_FILE = () => path.join(app.getPath("userData"), "gc-names.json");
let nameCache = null; // serial -> { name, at }
const lastNickTry = new Map(); // serial -> 上次抓取尝试时间(失败节流)

function loadNames() {
  if (nameCache) return nameCache;
  nameCache = new Map();
  try {
    const obj = JSON.parse(fs.readFileSync(NAMES_FILE(), "utf8"));
    for (const [k, v] of Object.entries(obj)) nameCache.set(k, v);
  } catch (_) { /* 没有缓存文件或损坏:空缓存 */ }
  return nameCache;
}

function saveNames() {
  try {
    fs.writeFileSync(NAMES_FILE(), JSON.stringify(Object.fromEntries(nameCache), null, 2), "utf8");
  } catch (e) {
    log(`保存昵称缓存失败: ${e.message}`);
  }
}

async function fetchNickname(serial) {
  const last = lastNickTry.get(serial) || 0;
  if (Date.now() - last < 60000) return ""; // 失败节流:1 分钟最多抓一次
  lastNickTry.set(serial, Date.now());
  const out = await shell(
    serial,
    "uiautomator dump /sdcard/gc_uidump.xml >/dev/null 2>&1; cat /sdcard/gc_uidump.xml; rm -f /sdcard/gc_uidump.xml",
    20000
  );
  const m = out.match(/闲鱼账号[:：]\s*([^"<·\s]+)/);
  return m ? m[1].trim() : "";
}

function nicknameOf(serial) {
  const c = loadNames().get(serial);
  return c ? c.name : "";
}

// ---- 员工登录 ----
// 2026-10-06 起群控的管理接口要凭据(以前 nginx 把 /gc/ 整段转给群控、群控又不验,
// 建任务、改账号公网谁都能做)。守护端用员工账号登录,带主 ERP 签的令牌去调:
// - 不放服务器地址(员工不该看见也不该去改),账号密码记在本机,密码用系统钥匙串加密;
// - 令牌 7 天过期,剩不到 3 天自动续;记住了密码的开机自动登录——守护端常驻,
//   不该等人来输密码;
// - 群控回 401 = 没带或令牌失效:清掉并让界面弹登录。
// 令牌仍存在 userData/gc-server.json(以前预留的就是这个文件,手工放的 {"token"} 照认)。
const ERP_API_BASE = "http://127.0.0.1:8000";
const AUTH_FILE = () => path.join(app.getPath("userData"), "gc-server.json");

function readAuth() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE(), "utf8")) || {};
  } catch (_) {
    return {};
  }
}

function writeAuth(data) {
  try {
    fs.writeFileSync(AUTH_FILE(), JSON.stringify(data, null, 2));
  } catch (e) {
    log(`保存登录信息失败: ${e.message}`);
  }
}

function canSeal() {
  try { return safeStorage.isEncryptionAvailable(); } catch (_) { return false; }
}
function seal(text) {
  return text && canSeal() ? safeStorage.encryptString(String(text)).toString("base64") : null;
}
function unseal(b64) {
  if (!b64 || !canSeal()) return "";
  try { return safeStorage.decryptString(Buffer.from(b64, "base64")); } catch (_) { return ""; }
}

function serverToken() {
  const a = readAuth();
  return unseal(a.tokenEnc) || a.token || "";
}

// 令牌加密存;系统钥匙串用不了才退回明文——它 7 天就过期,密码可从不明文落盘
function saveToken(token, staff) {
  const a = readAuth();
  const enc = seal(token);
  a.tokenEnc = enc || undefined;
  a.token = enc ? undefined : token;
  a.staff = staff || a.staff || null;
  writeAuth(a);
}

function clearToken() {
  const a = readAuth();
  delete a.tokenEnc;
  delete a.token;
  delete a.staff;
  writeAuth(a);
}

function tokenExpiresAt(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
    return payload.exp ? payload.exp * 1000 : 0;
  } catch (_) {
    return 0;
  }
}

function authState() {
  const tok = serverToken();
  const exp = tok ? tokenExpiresAt(tok) : 0;
  const loggedIn = Boolean(tok) && (!exp || exp > Date.now());
  return { loggedIn, staff: loggedIn ? readAuth().staff || null : null, expiresAt: exp || null };
}

// 记住的账号密码:{username, password} / {off:true}(上次特意没勾) / null(从没登过)
function rememberedLogin() {
  const r = readAuth().remember;
  if (r && r.off) return { off: true };
  if (!r || !r.username) return null;
  return { username: r.username, password: unseal(r.passwordEnc) };
}

// 返回密码是否真的记下了:加密不了就只记账号
function setRemembered(username, password, on) {
  const a = readAuth();
  if (!on) {
    a.remember = { off: true };
    writeAuth(a);
    return false;
  }
  const passwordEnc = seal(password);
  a.remember = { username, passwordEnc };
  writeAuth(a);
  return Boolean(passwordEnc);
}

// 打主 ERP;回 {status, data}。网络错误照常 reject——调方据此分辨「断网」和「被拒」
function erpJson(method, apiPath, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(ERP_API_BASE + apiPath);
    const data = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
    const headers = {};
    if (data) Object.assign(headers, { "Content-Type": "application/json", "Content-Length": data.length });
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = https.request(
      { method, hostname: u.hostname, path: u.pathname + u.search, headers, timeout: 15000 },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          let parsed = null;
          try { parsed = JSON.parse(d); } catch (_) { parsed = null; }
          resolve({ status: res.statusCode, data: parsed });
        });
      }
    );
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("连不上服务器")));
    if (data) r.write(data);
    r.end();
  });
}

async function erpLogin(username, password) {
  const r = await erpJson("POST", "/auth/workbench-login", { username, password });
  if (r.status !== 200 || !r.data || !r.data.token) {
    throw new Error((r.data && r.data.detail) || `登录失败(HTTP ${r.status})`);
  }
  saveToken(r.data.token, r.data.staff);
  return r.data;
}

function notifyAuth(reason) {
  if (win && !win.isDestroyed()) win.webContents.send("auth-changed", { ...authState(), reason: reason || "" });
}

// 群控回 401:令牌没了或失效。清掉、让界面弹登录(只在原本有令牌时提示,免得反复弹)
function onAuthLost() {
  if (!serverToken()) return;
  clearToken();
  log("登录已过期,请重新登录");
  notifyAuth("登录已过期，请重新登录");
}

// 开机与每 6 小时一次:快到期就续,没令牌而记住了密码就自己登上
async function keepLoggedIn() {
  const tok = serverToken();
  if (tok) {
    const left = tokenExpiresAt(tok) - Date.now();
    if (left > 3 * 86400e3) return;
    if (left > 60e3) {
      try {
        const r = await erpJson("POST", "/auth/refresh", null, tok);
        if (r.status === 200 && r.data && r.data.token) {
          saveToken(r.data.token, r.data.staff);
          return;
        }
        if (r.status === 401) clearToken();
      } catch (_) {
        return;   // 断网续不了,下次再续;别因此清掉还能用的令牌
      }
    } else {
      clearToken();
    }
  }
  const saved = rememberedLogin();
  if (saved && saved.username && saved.password) {
    try {
      await erpLogin(saved.username, saved.password);
      log(`已自动登录:${saved.username}`);
    } catch (e) {
      log(`自动登录失败:${e.message}`);
    }
  }
  notifyAuth();
}

// gc 的 401/403 翻成人话;401 顺带触发重新登录
function gcHttpError(status, body) {
  if (status === 401) {
    onAuthLost();
    return new Error("没登录或登录已过期，请先登录");
  }
  if (status === 403) return new Error("这个账号没有群控权限");
  return new Error(String(body || "").slice(0, 200) || `HTTP ${status}`);
}

// ---- 账号风控状态(gc 服务端 API,带员工令牌) ----
let accountMap = new Map(); // nick -> { id, status, riskState, riskNote }
let accountFetchedAt = 0;

async function fetchAccounts() {
  const tok = serverToken();
  if (!tok) return;
  const body = await new Promise((resolve, reject) => {
    const r = https.get(
      { hostname: "service.example.invalid", path: "/gc/accounts", headers: { Authorization: `Bearer ${tok}` }, timeout: 10000 },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => (res.statusCode >= 400 ? reject(gcHttpError(res.statusCode, d)) : resolve(d)));
      }
    );
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("timeout")));
  });
  const list = JSON.parse(body);
  const m = new Map();
  for (const a of list) m.set(a.nick, { id: a.id, status: a.status, riskState: a.risk_state, riskNote: a.risk_note });
  accountMap = m;
  accountFetchedAt = Date.now();
}

// 服务端写操作(解冻等):PATCH /gc/accounts/<id>。不登录只能解冻,改别的要管理员令牌。
function patchAccount(accountId, fields) {
  const tok = serverToken();
  const payload = JSON.stringify(fields);
  const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) };
  if (tok) headers.Authorization = `Bearer ${tok}`;
  return new Promise((resolve, reject) => {
    const r = https.request(
      {
        hostname: "service.example.invalid",
        path: `/gc/accounts/${accountId}`,
        method: "PATCH",
        headers,
        timeout: 10000,
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          if (res.statusCode >= 400) reject(gcHttpError(res.statusCode, d));
          else resolve(d);
        });
      }
    );
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.write(payload);
    r.end();
  });
}

// gc 服务端通用 JSON 请求(GET/POST),失败 reject(Error);登录了就带员工令牌
function gcApiJson(method, apiPath, payload) {
  const tok = serverToken();
  const bodyStr = payload ? JSON.stringify(payload) : null;
  const headers = {};
  if (tok) headers.Authorization = `Bearer ${tok}`;
  if (bodyStr) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(bodyStr);
  }
  return new Promise((resolve, reject) => {
    const r = https.request(
      { hostname: "service.example.invalid", path: apiPath, method, headers, timeout: 10000 },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          if (res.statusCode >= 400) return reject(gcHttpError(res.statusCode, d));
          try { resolve(JSON.parse(d)); } catch (_) { resolve(d); }
        });
      }
    );
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("timeout")));
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

// 设备 id→name 映射(任务列表展示用),缓存 30s
let deviceNameCache = { map: new Map(), at: 0 };
async function fetchDeviceNames() {
  if (Date.now() - deviceNameCache.at < 30000) return deviceNameCache.map;
  const list = await gcApiJson("GET", "/gc/devices");
  const arr = Array.isArray(list) ? list : list.items || [];
  const m = new Map();
  for (const d of arr) m.set(d.id, d.name || d.nickname || String(d.id));
  deviceNameCache = { map: m, at: Date.now() };
  return m;
}

function accountInfoOf(nick) {
  if (!nick) return null;
  const hit = accountMap.get(nick);
  if (hit) return hit;
  // 界面昵称可能被截断,做前后缀容差匹配
  for (const [k, v] of accountMap) {
    if (k && (k.startsWith(nick) || nick.startsWith(k))) return v;
  }
  return null;
}

// ---- 设备硬件信息 adb 兜底采集(SN/双IMEI/手机号)→ gc 服务器 /device-info ----
// App identity 帧是主上报通道(READ_PHONE_STATE,Android10+ 常读不到);本通道只补空字段(服务端语义)。
const GC_API_BASE = "http://127.0.0.1:8000";

// 读 gc_identity.json(App 每次 identity 上报时落外部私有目录):含 device_id/nick/App 已采集的字段
async function readGcIdentity(serial) {
  try {
    const out = await shell(serial, `cat /sdcard/Android/data/${PKG}/files/gc_identity.json`, 8000);
    return JSON.parse(out);
  } catch (_) {
    return null;
  }
}

// service call 的 Parcel 输出解码:每 4 位 hex = 一个 UTF-16 字符,0 为串分隔
function parseParcelStrings(out) {
  const strings = [];
  let cur = "";
  for (const w of out.match(/\b[0-9a-fA-F]{8}\b/g) || []) {
    for (let i = 0; i < 8; i += 4) {
      const code = parseInt(w.substr(i, 4), 16);
      if (code === 0 || code === 65535) {
        if (cur) { strings.push(cur); cur = ""; }
      } else if (code >= 32 && code < 0xd800) {
        cur += String.fromCharCode(code);
      }
    }
  }
  if (cur) strings.push(cur);
  return strings.map((s) => s.trim()).filter(Boolean);
}

// 尽力读 IMEI:iphonesubinfo 前几个交易码逐个试,取 14~16 位纯数字串,去重取前两个(slot0/1)
async function readImeisAdb(serial) {
  const found = [];
  const grab = (out) => {
    for (const s of parseParcelStrings(out)) {
      if (/^\d{14,16}$/.test(s) && !found.includes(s)) found.push(s);
    }
  };
  for (const code of [1, 2, 3, 4]) {
    try { grab(await shell(serial, `service call iphonesubinfo ${code}`, 8000)); } catch (_) { /* 继续 */ }
    if (found.length >= 2) return found.slice(0, 2);
  }
  for (const code of [1, 2, 3, 4]) {
    for (const slot of [0, 1]) {
      try { grab(await shell(serial, `service call iphonesubinfo ${code} i32 ${slot}`, 8000)); } catch (_) { /* 继续 */ }
      if (found.length >= 2) return found.slice(0, 2);
    }
  }
  return found.slice(0, 2);
}

// 尽力读 SIM 本机号码(getLine1Number 各版本交易码):匹配国内手机号;很多卡写不进号码,读不到返回 ""
async function readPhoneNumberAdb(serial) {
  for (const code of [13, 14, 15, 16, 17]) {
    try {
      const out = await shell(serial, `service call iphonesubinfo ${code}`, 8000);
      for (const s of parseParcelStrings(out)) {
        const m = s.replace(/\D/g, "").match(/1\d{10}/);
        if (m) return m[0];
      }
    } catch (_) { /* 继续 */ }
  }
  return "";
}

function httpsPostJson(url, obj, timeout = 15000, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(obj), "utf8");
    const u = new URL(url);
    const req = https.request({
      method: "POST", hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      headers: { "Content-Type": "application/json", "Content-Length": data.length, ...extraHeaders }, timeout,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try { resolve(JSON.parse(text)); } catch (_) { resolve({ raw: text }); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// adb 采集 + 上报 gc 服务器(只补空字段)。device_id 取自 App 落地的 gc_identity.json;
// 拿不到也能按 serial 让服务端匹配(ro.serialno 与 adb serial 一致)。
async function reportDeviceInfo(serial) {
  const sn = (await shell(serial, "getprop ro.serialno", 8000)).trim();
  const [imei1, imei2] = await readImeisAdb(serial);
  const phone = await readPhoneNumberAdb(serial);
  const id = await readGcIdentity(serial);
  const body = {
    serial: sn || undefined,
    imei1: imei1 || undefined,
    imei2: imei2 || undefined,
    phone_number: phone || undefined,
  };
  const target = id && id.device_id ? id.device_id : (sn || "");
  if (!target) {
    log(`初始化 ${serial}: 无 device_id 也无 SN,硬件信息未上报`);
    return;
  }
  const tok = serverToken();
  const resp = await httpsPostJson(`${GC_API_BASE}/devices/${target}/device-info`, body, 15000,
    tok ? { Authorization: `Bearer ${tok}` } : {});
  log(`初始化 ${serial}: 硬件信息上报 SN=${sn || "-"} IMEI=${[imei1, imei2].filter(Boolean).join("/") || "-"} 号码=${phone || "-"} → ${JSON.stringify(resp)}`);
}

// 闲鱼版本检查(5 分钟缓存;版本不对=坐标级流程必然崩,标红提示)
const xyVerCache = new Map(); // serial -> { ver, at }
const xyVerWarned = new Set();
async function xianyuVersion(serial) {
  const c = xyVerCache.get(serial);
  if (c && Date.now() - c.at < 300000) return c.ver;
  let ver = "";
  try {
    const out = await shell(serial, `dumpsys package ${XY_PKG} | grep versionName | head -1`);
    ver = (out.match(/versionName=([\d.]+)/) || [])[1] || "";
  } catch (_) { /* 忽略,下轮再试 */ }
  xyVerCache.set(serial, { ver, at: Date.now() });
  if (ver && ver !== XY_LOCKED_VERSION && !xyVerWarned.has(serial + ver)) {
    xyVerWarned.add(serial + ver);
    log(`⚠ ${serial} 闲鱼版本 ${ver} ≠ 锁定版 ${XY_LOCKED_VERSION},点「初始化」统一(未装闲鱼APK时请先把 xianyu.apk 放到 vendor/app)`);
  }
  return ver;
}

// ---- 权限/保活:声明式能力表 + 「检测→缺则补→变化才记日志」 ----
// 服务/输入法组件 id(enabled_accessibility_services 可能存短形式或全限定形式,检测两者都认)
const GC_IME = `${PKG}/.inputmethod.GcInputMethodService`;
const GC_A11Y = `${PKG}/.auto.XianyuAccessibilityService`;
const A11Y_IDS = [GC_A11Y, `${PKG}/${PKG}.auto.XianyuAccessibilityService`];

const keepaliveFailLog = new Map(); // serial -> 上次记录的失败能力签名(去重日志)
const permState = new Map();        // serial -> { missing:[], at }:最近一次全量审计的缺失项(供界面)

// ---- adb 查询/设置小工具 ----
function appopSet(serial, op) {
  return shell(serial, `cmd appops set ${PKG} ${op} allow`);
}
async function appopAllowed(serial, op) {
  const out = await shell(serial, `cmd appops get ${PKG} ${op}`); // 抛错交上层(soft 能力会吞掉)
  return /\ballow\b/.test(out);
}
async function getSecure(serial, key) {
  const v = (await shell(serial, `settings get secure ${key}`)).trim();
  return v === "null" ? "" : v;
}
async function checkA11y(serial) {
  const [list, enabled] = await Promise.all([
    getSecure(serial, "enabled_accessibility_services"),
    getSecure(serial, "accessibility_enabled"),
  ]);
  const items = list.split(":").map((s) => s.trim());
  return enabled === "1" && A11Y_IDS.some((id) => items.includes(id));
}
async function fixA11y(serial) {
  // append 我们的服务(不覆盖用户/其它无障碍),再开总开关
  const list = await getSecure(serial, "enabled_accessibility_services");
  const items = list ? list.split(":").map((s) => s.trim()).filter(Boolean) : [];
  if (!A11Y_IDS.some((id) => items.includes(id))) items.push(GC_A11Y);
  await shell(serial, `settings put secure enabled_accessibility_services ${items.join(":")}`);
  await shell(serial, "settings put secure accessibility_enabled 1");
}

// 判断无障碍服务是否**真的已绑定/连接**(而非仅在设置里被勾选)。
// dumpsys accessibility 里已连接的服务会以 "Service[...]" 块列出;仅出现在 "Enabled services" 集合不算。
// 返回 true=已绑定 / false=已启用但未绑定 / null=该 ROM 无此格式,无法判定(不处理)。
async function checkA11yBound(serial) {
  const out = await shell(serial, "dumpsys accessibility");
  const blocks = out.split("Service[").slice(1);
  if (!blocks.length) return null; // 无 "Service[" 段:格式不认,保守不 toggle
  return blocks.some((seg) => seg.slice(0, 400).includes(PKG));
}

// 强制重绑:置空(保留别人的无障碍)→稍等→写回,迫使系统重新 bind。顺带 revive 保证 app 进程活着可被绑定。
async function forceRebindA11y(serial) {
  const list = await getSecure(serial, "enabled_accessibility_services");
  const items = list ? list.split(":").map((s) => s.trim()).filter(Boolean) : [];
  const others = items.filter((id) => !A11Y_IDS.includes(id)); // 别人的无障碍要保住
  await shell(serial, `settings put secure enabled_accessibility_services ${others.join(":")}`);
  await shell(serial, `settings put secure accessibility_enabled ${others.length ? "1" : "0"}`);
  await new Promise((r) => setTimeout(r, 800));
  others.push(GC_A11Y);
  await shell(serial, `settings put secure enabled_accessibility_services ${others.join(":")}`);
  await shell(serial, "settings put secure accessibility_enabled 1");
  try { await revive(serial); } catch (_) { /* 拉活失败下轮再来 */ }
}

const a11yRebindAt = new Map(); // serial -> 上次强制重绑时刻(节流,防频繁 toggle 打断)
// 顽固态处理:设置里已启用、但实际没绑定 → toggle 强制重绑。每设备 2 分钟最多一次。
async function ensureA11yBound(serial) {
  let settingsOn;
  try { settingsOn = await checkA11y(serial); } catch (_) { return; }
  if (!settingsOn) return; // 设置都没开,交给普通 fixA11y
  const bound = await checkA11yBound(serial).catch(() => null);
  if (bound !== false) return; // true=正常 / null=判不了,都不 toggle
  const now = Date.now();
  if (now - (a11yRebindAt.get(serial) || 0) < 120000) return;
  a11yRebindAt.set(serial, now);
  log(`无障碍 ${serial}: 已启用但未绑定,toggle 强制重绑…`);
  try { await forceRebindA11y(serial); } catch (e) { log(`无障碍 ${serial}: 强制重绑失败 ${(e.message || "").slice(0, 80)}`); }
}
async function isWhitelisted(serial) {
  return (await shell(serial, "dumpsys deviceidle whitelist")).includes(PKG);
}
async function checkImeEnabled(serial) {
  return (await shell(serial, "ime list -s")).includes(GC_IME); // -s 只列已启用的 IME id
}
async function fixNotif(serial) {
  // POST_NOTIFICATIONS 是 A13+ 运行时权限;老系统无此权限,pm grant/appops 均容错
  try { await shell(serial, `pm grant ${PKG} android.permission.POST_NOTIFICATIONS`); } catch (_) { /* <13 无此权限 */ }
  try { await appopSet(serial, "POST_NOTIFICATION"); } catch (_) { /* 部分 ROM 无此 op */ }
}

// 能力表。tier=keepalive:廉价幂等,每轮盲设;tier=perm:检测→缺则补(critical 每轮,其余全量审计才查)。
// soft=true:该 ROM 可能不支持,补不上也不算严重失败(不报警)。
const CAPS = [
  { key: "screen", name: "防息屏", tier: "keepalive", fix: (s) => shell(s, `settings put system screen_off_timeout ${NEVER_SLEEP_MS}`) },
  { key: "stayon", name: "充电常亮", tier: "keepalive", fix: (s) => shell(s, "svc power stayon true") },
  { key: "a11y", name: "无障碍", tier: "perm", critical: true, check: checkA11y, fix: fixA11y },
  { key: "saw", name: "悬浮窗", tier: "perm", check: (s) => appopAllowed(s, "SYSTEM_ALERT_WINDOW"), fix: (s) => appopSet(s, "SYSTEM_ALERT_WINDOW") },
  { key: "idle", name: "电池白名单", tier: "perm", check: isWhitelisted, fix: (s) => shell(s, `dumpsys deviceidle whitelist +${PKG}`) },
  { key: "runbg", name: "后台运行", tier: "perm", check: (s) => appopAllowed(s, "RUN_IN_BACKGROUND"), fix: (s) => appopSet(s, "RUN_IN_BACKGROUND") },
  { key: "runany", name: "任意后台", tier: "perm", check: (s) => appopAllowed(s, "RUN_ANY_IN_BACKGROUND"), fix: (s) => appopSet(s, "RUN_ANY_IN_BACKGROUND"), soft: true },
  { key: "wake", name: "唤醒锁", tier: "perm", check: (s) => appopAllowed(s, "WAKE_LOCK"), fix: (s) => appopSet(s, "WAKE_LOCK") },
  { key: "fg", name: "后台弹界面", tier: "perm", check: (s) => appopAllowed(s, "START_FOREGROUND"), fix: (s) => appopSet(s, "START_FOREGROUND"), soft: true },
  { key: "notif", name: "通知", tier: "perm", check: (s) => appopAllowed(s, "POST_NOTIFICATION"), fix: fixNotif, soft: true },
  { key: "ime", name: "输入法", tier: "perm", check: checkImeEnabled, fix: (s) => shell(s, `ime enable ${GC_IME}`) },
];

// 遍历能力表补齐。full=连非critical的perm项也查;force=不检测直接fix(初始化用)。
// keepaliveOn/permsOn 分别控制两个 tier。返回本轮实际补齐/仍失败的能力名。
async function ensureCaps(serial, { full = false, force = false, permsOn = true, keepaliveOn = true } = {}) {
  const fixedNow = [];
  const failed = [];
  for (const cap of CAPS) {
    if (cap.tier === "keepalive" && !keepaliveOn) continue;
    if (cap.tier === "perm" && !permsOn) continue;
    try {
      if (cap.tier === "keepalive") {
        await cap.fix(serial); // 廉价幂等,盲设
        continue;
      }
      if (!full && !cap.critical && !force) continue; // 非全量:仅 critical(无障碍)
      let ok = force ? false : await cap.check(serial);
      if (ok) continue;
      await cap.fix(serial);
      if (force) { fixedNow.push(cap.name); continue; }
      ok = await cap.check(serial); // 补后复检
      if (ok) fixedNow.push(cap.name);
      else if (!cap.soft) failed.push(cap.name);
    } catch (_) {
      if (!cap.soft) failed.push(cap.name);
    }
  }
  return { fixedNow, failed };
}

// 每设备维护:补齐 + 变化才记日志 + 记录缺失项供界面。full=本轮做全量权限审计。
// 防息屏/常亮(keepalive tier)随「自动补权限」一起做——桌面已不设独立的「自动保活」开关
// (服务保活由 App 自身体系承担),显示设置仍属设备自动化刚需,并入补权限。
async function maintainDevice(serial, full) {
  const { fixedNow, failed } = await ensureCaps(serial, {
    full,
    keepaliveOn: settings.autoPermOn,
    permsOn: settings.autoPermOn,
  });
  // 全量审计时,额外查无障碍是否真的绑定(设置已开但没生效的顽固态 → toggle 强制重绑)
  if (settings.autoPermOn && full) await ensureA11yBound(serial);
  if (fixedNow.length) log(`补权限 ${serial}: 已补 ${fixedNow.join("/")}`);
  const sig = failed.join(",");
  if (failed.length && keepaliveFailLog.get(serial) !== sig) {
    keepaliveFailLog.set(serial, sig);
    log(
      `维护 ${serial}: ${failed.join("/")} 无法自动设置` +
        (failed.includes("防息屏") || failed.includes("无障碍")
          ? "(该机需在开发者选项开「USB 调试(安全设置)」)"
          : "(该 ROM 可能不支持,需手动设置)")
    );
  } else if (!failed.length && keepaliveFailLog.has(serial)) {
    keepaliveFailLog.delete(serial);
    log(`维护 ${serial}: 权限全部就绪`);
  }
  if (full) permState.set(serial, { missing: failed, at: Date.now() });
  return failed;
}

// ---- 无障碍看门狗:掉绑瞬间取证 + 自动重开(移植自另一台设备;与本机 ensureA11yBound 互补) ----
// GcService 拉得活,无障碍被撤了一样全瘫。取证回答「谁撤销的」:冻结类工具(greeze 等)解冻杀进程、
// 系统 am_kill、安全守护撤销,logcat 特征各不同,存一份就能对上号。
// 自动重开能写成功的前提:开发者选项里开了「USB 调试(安全设置)」;没开 settings put 会被拒,日志会明说。
const a11yState = new Map(); // serial -> { restores, nextRestoreAt, lastCaptureAt }

async function captureA11yEvidence(serial) {
  const dir = path.join(app.getPath("userData"), "a11y-evidence");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${serial}-${stamp}.txt`);
  const grab = (cmd) => shell(serial, cmd, 30000).catch((e) => `<采集失败: ${e.message}>`);
  const logcat = await grab("logcat -d -t 800 | grep -iE 'greeze|accessibility|am_kill'");
  const dump = await grab("dumpsys accessibility");
  fs.writeFileSync(
    file,
    `设备: ${serial}\n时间: ${new Date().toLocaleString()}\n\n` +
      `===== logcat(greeze/accessibility/am_kill)=====\n${logcat}\n\n` +
      `===== dumpsys accessibility =====\n${dump}\n`,
    "utf8"
  );
  return file;
}

async function a11yWatchdog(serial) {
  let enabled = "";
  try {
    enabled = (await shell(serial, "settings get secure enabled_accessibility_services")).trim();
  } catch (_) {
    return; // 查询失败(瞬断/unauthorized):这轮跳过,下轮再看
  }
  if (enabled.split(":").some((id) => A11Y_IDS.includes(id.trim()))) {
    a11yState.delete(serial); // 在绑:清掉之前的掉绑记录
    return;
  }
  const st = a11yState.get(serial) || { restores: 0, nextRestoreAt: 0, lastCaptureAt: 0 };
  const now = Date.now();
  // 取证:一场掉绑风波采一次就够(10 分钟内反复掉只采首次,免得磁盘/logcat 被打爆)
  if (now - st.lastCaptureAt > 10 * 60 * 1000) {
    st.lastCaptureAt = now;
    try {
      const file = await captureA11yEvidence(serial);
      log(`无障碍 ${serial} 掉绑,取证已存档: ${file}(有 greeze=冻结工具干的 / am_kill=系统杀 / 都没有=安全守护撤销)`);
    } catch (e) {
      log(`无障碍 ${serial} 取证失败: ${e.message}`);
    }
  }
  // 自动重开:写不动(没开安全设置)时 60s 节流重试,不每轮轰炸
  if (now < st.nextRestoreAt) {
    a11yState.set(serial, st);
    return;
  }
  st.restores += 1;
  st.nextRestoreAt = now + 60000;
  try {
    // 保留机上已有的其它无障碍服务,只把群控的补回列表(:分隔)
    const keep = enabled && enabled !== "null" ? enabled : "";
    await shell(serial, `settings put secure enabled_accessibility_services ${keep ? `${keep}:` : ""}${GC_A11Y}`);
    await shell(serial, "settings put secure accessibility_enabled 1");
    log(`无障碍 ${serial} 掉绑,已自动重开(第${st.restores}次)`);
  } catch (e) {
    const tail = (e.message || "").split(/\r?\n/).filter(Boolean).pop() || "";
    log(`无障碍 ${serial} 掉绑,自动重开失败: ${tail.slice(0, 120)}(该机需开「USB 调试(安全设置)」)`);
  }
  a11yState.set(serial, st);
}

async function revive(serial) {
  await shell(serial, "input keyevent KEYCODE_WAKEUP");
  await shell(serial, `am start -n ${PKG}/${MAIN_ACTIVITY} --ez autostart true`);
}

// ---- 状态与轮询 ----
let win = null;
let polling = false;
let pollCount = 0;           // 轮询计数:决定何时做全量权限审计
let autoTiledDone = false;   // 只自动平铺一次,避免每轮轮询重排打断人工调整

// ---- 界面配置项:默认值 + 本地存储(userData/gc-settings.json)覆盖,重启后保留 ----
// 新增开关:在 SETTINGS_DEFAULTS 里加默认值即可,load/save 自动覆盖全部键。
const SETTINGS_DEFAULTS = {
  autoPermOn: true,  // 权限不足时自动 adb 补齐(无障碍/悬浮窗/白名单/appops/输入法…)
  autoTileOn: true,  // 启动后自动矩阵投屏(见 pollOnce);可由界面开关关闭
};
const SETTINGS_FILE = () => path.join(app.getPath("userData"), "gc-settings.json");
let settings = { ...SETTINGS_DEFAULTS };
function loadSettings() {
  try {
    const obj = JSON.parse(fs.readFileSync(SETTINGS_FILE(), "utf8"));
    for (const k of Object.keys(SETTINGS_DEFAULTS)) {
      if (typeof obj[k] === "boolean") settings[k] = obj[k];
    }
  } catch (_) { /* 首次运行无文件:全用默认值 */ }
}
function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2), "utf8");
  } catch (_) { /* 写失败不影响本次设置生效 */ }
}
let lastState = { adb: "", scrcpy: "", devices: [], scrcpyOpen: [] };
const scrcpyProcs = new Map(); // serial -> ChildProcess
const noAppWarned = new Set(); // 已提示过「未装App」的设备

// 按关键字给日志分级:error/warn 会被界面另投到「错误/告警」区,info 只进日志。
function logLevel(s) {
  if (/失败|出错|无法|✗|错误|abort/i.test(s)) return "error";
  if (/⚠|仍无效|请手动|未设上|不支持|被拒|降为每分钟|未安装|未找到|跳过/.test(s)) return "warn";
  return "info";
}
// 日志同时落盘(userData/gc.log,>2MB 截断重开),出问题时可直接看文件排障
const LOG_FILE = () => path.join(app.getPath("userData"), "gc.log");

function log(msg) {
  const s = String(msg);
  const line = { ts: new Date().toLocaleTimeString(), msg: s, level: logLevel(s) };
  try {
    const f = LOG_FILE();
    if (fs.existsSync(f) && fs.statSync(f).size > 2 * 1024 * 1024) fs.writeFileSync(f, "");
    fs.appendFileSync(f, `[${line.ts}] ${s}\n`);
  } catch (_) { /* 写日志失败不影响主流程 */ }
  if (win && !win.isDestroyed()) win.webContents.send("log", line);
}

// 统一把当前状态(含正在投屏的设备)推给界面,让「打开/关闭屏幕」按钮跟随实际投屏进程。
function pushState() {
  lastState.scrcpyOpen = [...scrcpyProcs.keys()];
  lastState.appUpdate = appUpdateInfo;
  lastState.xianyu = xianyuInfo;
  lastState.codeUpdate = codeUpdateInfo;
  if (win && !win.isDestroyed()) win.webContents.send("state", lastState);
}

// 设备拔出后清理各缓存,防 serial 复用串数据
function cleanupDisconnected(currentSerials) {
  for (const serial of [...modelCache.keys()]) if (!currentSerials.has(serial)) modelCache.delete(serial);
  for (const serial of [...installedCache.keys()]) if (!currentSerials.has(serial)) installedCache.delete(serial);
  for (const serial of [...lastNickTry.keys()]) if (!currentSerials.has(serial)) lastNickTry.delete(serial);
  for (const serial of [...xyVerCache.keys()]) if (!currentSerials.has(serial)) xyVerCache.delete(serial);
  for (const serial of [...keepaliveFailLog.keys()]) if (!currentSerials.has(serial)) keepaliveFailLog.delete(serial);
  for (const serial of [...a11yState.keys()]) if (!currentSerials.has(serial)) a11yState.delete(serial);
  for (const serial of [...noAppWarned]) if (!currentSerials.has(serial)) noAppWarned.delete(serial);
}

async function pollOnce() {
  if (polling) return; // 上一轮没跑完就跳过,避免叠加
  polling = true;
  pollCount++;
  // 全量权限审计不必每 5s(每台 ~8 个 adb get 会拥塞):每 6 轮≈30s 一次,首轮(pollCount=1)即审计。
  // 非审计轮只跑 keepalive(防息屏/常亮)+ critical(无障碍)——无障碍掉了最多 5s 补回。
  const doFullAudit = pollCount % 6 === 1;
  try {
    const raw = await listDevices();
    cleanupDisconnected(new Set(raw.map((d) => d.serial)));

    // 账号风控状态 60s 刷新一次(不阻塞设备检测;未配置 token 时 fetchAccounts 直接返回)
    if (Date.now() - accountFetchedAt > 60000) {
      fetchAccounts().catch((e) => log(`账号状态获取失败: ${e.message}`));
    }

    const devices = [];
    for (const d of raw) {
      const dev = { serial: d.serial, state: d.state, model: "", foreground: "", gcService: false, appInstalled: true };
      if (d.state === "device") {
        try {
          const [fg, installed, model, xyVer, nick] = await Promise.all([
            foregroundPackage(d.serial),
            appInstalled(d.serial),
            deviceModel(d.serial),
            xianyuVersion(d.serial),
            readNick(d.serial),
          ]);
          dev.foreground = fg;
          dev.appInstalled = installed;
          dev.model = model;
          dev.xyVer = xyVer;
          // 昵称:gc_identity.json(新版 App)优先;读不到时回退昵称缓存;
          // 执行端在前台时顺带用 uiautomator 抓一次刷新缓存(旧版 App 的唯一来源)
          let finalNick = nick || nicknameOf(d.serial);
          if (!nick && fg === PKG) {
            const cached = loadNames().get(d.serial);
            if (!cached || Date.now() - cached.at > 10 * 60 * 1000) {
              try {
                const name = await fetchNickname(d.serial);
                if (name) {
                  nameCache.set(d.serial, { name, at: Date.now() });
                  saveNames();
                  finalNick = name;
                }
              } catch (_) { /* 抓取失败,下轮再试 */ }
            }
          }
          // 读到新昵称也顺手更新缓存(保持 gc-names.json 为最新)
          if (nick && (loadNames().get(d.serial) || {}).name !== nick) {
            nameCache.set(d.serial, { name: nick, at: Date.now() });
            saveNames();
          }
          dev.nick = finalNick;
          dev.account = accountInfoOf(finalNick); // 非 ACTIVE 时前端显示封禁/冻结标签
          if (!installed) {
            // 未装群控 App:保活/拉活都无意义,直接跳过并提示(每机只提示一次)
            if (!noAppWarned.has(d.serial)) {
              noAppWarned.add(d.serial);
              log(`${d.serial} 未安装群控 App:先点「装App」再点「初始化」`);
            }
          } else {
            noAppWarned.delete(d.serial);
            dev.gcService = await serviceRunning(d.serial);
            // 权限自动补齐(无障碍/悬浮窗/白名单/appops/输入法…)+ 无障碍掉绑看门狗。
            // 注:服务保活已由 App 自身体系承担(看门狗/开机自启/划卡自救),桌面不再自动拉活;
            // 手动「拉活」按钮保留,用于个别顽固机。
            if (settings.autoPermOn) {
              await maintainDevice(d.serial, doFullAudit);
              await a11yWatchdog(d.serial); // 无障碍掉绑:取证 + 自动重开
            }
            dev.permMissing = (permState.get(d.serial) || {}).missing || [];
          }
        } catch (e) {
          log(`检测 ${d.serial} 出错: ${e.message}`);
        }
      }
      devices.push(dev);
    }
    const summary = {
      total: devices.length,
      running: devices.filter((d) => d.gcService).length,                                  // GcService 在跑=真正在线
      permMissing: devices.filter((d) => (d.permMissing || []).length > 0).length,         // 有权限缺失
      noApp: devices.filter((d) => d.state === "device" && d.appInstalled === false).length,
      offline: devices.filter((d) => d.state !== "device").length,                         // offline/unauthorized
    };
    lastState = { adb: adbBin(), scrcpy: scrcpyBin(), apk: apkPath(), devices, autoPermOn: settings.autoPermOn, autoTileOn: settings.autoTileOn, summary };
    pushState();
    // 启动后首次探到「已连接且装了群控 App」的设备 → 自动矩阵平铺一次(只做一次)
    if (settings.autoTileOn && !autoTiledDone) {
      const eligible = devices.filter((d) => d.state === "device" && d.appInstalled !== false);
      if (eligible.length) {
        autoTiledDone = true;
        setTimeout(tileAllScreens, 800); // 略等界面渲染,再拉起投屏矩阵
      }
    }
  } catch (e) {
    log(`轮询出错(adb 不可用?): ${e.message}`);
    recoverAdb((e.message || "").split(/\r?\n/)[0]); // 后台自愈,下一轮轮询再试
    lastState = { ...lastState, adb: adbBin(), apk: apkPath(), devices: [] };
    pushState();
  } finally {
    polling = false;
  }
}

// ---- 投屏窗口管理 ----
// geom 传入时(矩阵平铺)追加 scrcpy 的 --window-x/y/width/height 精确定位;不传=默认位置。
const closingManually = new Set(); // 用户主动关闭的投屏:退出日志里与崩溃区分开

function openScreen(serial, geom = null) {
  const p = scrcpyProcs.get(serial);
  if (p && p.exitCode === null) return { ok: true, already: true };
  // 窗口标题带昵称(昵称缓存,免多台时对不上号)
  const nick = nicknameOf(serial);
  const title = nick ? `${nick} (${serial})` : serial;
  const args = [scrcpyBin(), "-s", serial, "--stay-awake", "--window-title", title];
  if (geom) {
    // scrcpy 的 --window-width/height 是窗口内容(视频)上限,按手机比例自适应缩放
    args.push(
      `--window-x=${geom.x}`,
      `--window-y=${geom.y}`,
      `--window-width=${geom.w}`,
      `--window-height=${geom.h}`,
    );
  }
  log(`启动投屏: ${args.join(" ")}`);
  try {
    const child = spawn(args[0], args.slice(1), { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8192) stderr = stderr.slice(-8192); // 防缓冲区无限增长
    });
    child.on("error", (e) => {
      log(`投屏启动失败 ${serial}: ${e.message}`);
      scrcpyProcs.delete(serial);
      pushState();
    });
    child.on("exit", (code, signal) => {
      scrcpyProcs.delete(serial);
      const manual = closingManually.delete(serial);
      const tail = stderr.trim().split(/\r?\n/).filter(Boolean).pop() || "";
      if (code !== 0 && code !== null) {
        log(`投屏 ${serial} 已退出(code=${code}${signal ? ` signal=${signal}` : ""})${tail ? `: ${tail.slice(0, 160)}` : ""}`);
      } else if (!manual) {
        // code=0 的静默退出(窗口没出来就消失)也要有记录,否则排障无据可查
        log(`投屏 ${serial} 已关闭${tail ? `: ${tail.slice(0, 160)}` : ""}`);
      }
      pushState();
    });
    scrcpyProcs.set(serial, child);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function closeScreen(serial) {
  const p = scrcpyProcs.get(serial);
  if (p && p.exitCode === null) {
    closingManually.add(serial);
    p.kill();
    scrcpyProcs.delete(serial);
  }
}

// 取设备物理分辨率,作为 scrcpy 默认窗口大小/纵横比依据;读不到回退 1080x2400 竖屏。
async function deviceScreenSize(serial) {
  const r = await execTolerant(adbBin(), ["-s", serial, "shell", "wm", "size"], 5000);
  const m = /(\d{3,5})\s*x\s*(\d{3,5})/.exec(r.stdout || "");
  if (m) {
    let w = +m[1], h = +m[2];
    if (w > h) [w, h] = [h, w]; // 竖屏设备偶尔横报,统一按竖屏排版
    return { w, h };
  }
  return { w: 1080, h: 2400 };
}

// flex 式流式平铺:先按「默认窗口尺寸」从左到右相邻排列、自动换行;
// 整屏放不下时才按比例整体缩小窗口(行高每次 -20 重排),直到放下或到下限。
// GAP=窗口间距;TITLEBAR=给系统标题栏预留的高度(scrcpy 的 height 只算视频区,防竖向重叠)。
function computeFlowLayout(sizes, area) {
  const GAP = 6;
  const TITLEBAR = 34;
  const MIN_H = 260; // 再小就没法操作了,到下限仍放不下就允许溢出屏幕底部
  const n = sizes.length;
  // 默认行高:取设备默认窗口高的最小值(最矮设备不被放大),且不高过工作区
  const defH = Math.min(...sizes.map((s) => s.h), area.height - GAP * 2 - TITLEBAR);

  const layout = (h) => {
    const widths = sizes.map((s) => Math.round((h * s.w) / s.h));
    const pitch = Math.max(...widths) + GAP; // 列距按最宽窗口,保证相邻不重叠
    const cols = Math.max(1, Math.floor((area.width - GAP) / pitch));
    const rows = Math.ceil(n / cols);
    const cells = sizes.map((s, i) => ({
      x: area.x + GAP + (i % cols) * pitch,
      y: area.y + GAP + Math.floor(i / cols) * (h + TITLEBAR + GAP),
      w: widths[i],
      h,
    }));
    return { cells, cols, rows, h, needH: GAP + rows * (h + TITLEBAR + GAP) };
  };

  for (let h = defH; h >= MIN_H; h -= 20) {
    const r = layout(h);
    if (r.needH <= area.height) return { ...r, scaled: h < defH };
  }
  return { ...layout(MIN_H), scaled: true }; // 下限仍放不下:按最小尺寸排,允许溢出
}

// 一键矩阵投屏:取主屏工作区分辨率 → 对所有「已连接且装了群控App」的设备清屏重排成网格。
// 先全关再错峰重开(150ms/台),避免同一序列号 kill/spawn 抢占与 adb 并发拥塞。
let tiling = false;
async function tileAllScreens() {
  if (tiling) return { ok: false, error: "正在平铺中" };
  tiling = true;
  try {
    const disp = screen.getPrimaryDisplay();
    const wa = disp.workArea; // {x,y,width,height},已扣掉任务栏
    const eligible = (lastState.devices || []).filter(
      (d) => d.state === "device" && d.appInstalled !== false
    );
    if (!eligible.length) {
      log("矩阵投屏:没有可投屏的设备(需已连接且装了群控 App)");
      return { ok: false, count: 0 };
    }
    for (const serial of [...scrcpyProcs.keys()]) closeScreen(serial);
    await new Promise((r) => setTimeout(r, 400));
    const sizes = await Promise.all(eligible.map((d) => deviceScreenSize(d.serial)));
    const { cells, cols, rows, h, scaled } = computeFlowLayout(sizes, wa);
    log(
      `矩阵投屏:${eligible.length} 台 → ${cols}列×${rows}行 流式平铺` +
        `(屏幕 ${wa.width}×${wa.height},窗口高约 ${h}${scaled ? ",已整体缩小" : ",默认尺寸"})`
    );
    for (let i = 0; i < eligible.length; i++) {
      openScreen(eligible[i].serial, cells[i]);
      await new Promise((r) => setTimeout(r, 150));
    }
    pushState();
    return { ok: true, count: eligible.length };
  } finally {
    tiling = false;
  }
}

// ---- 窗口与生命周期 ----
// 单实例锁:重复启动时直接退出并聚焦已有窗口。
// 两个主进程并存会互相 kill adb server(recoverAdb),把对方在跑的 adb 命令打断,
// 形成「adb 不可用 → 重启 server → 再互杀」的循环,也会重复投屏。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1060,
    height: 680,
    minWidth: 720,
    minHeight: 480,
    frame: false, // 自绘标题栏(渲染层提供 winMin/winMaxToggle/winClose)
    title: "群控守护",
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(async () => {
  if (!gotLock) return; // 非首个实例:app.quit() 已在路上,不再建窗/起 adb/轮询
  createWindow();
  loadSettings(); // 恢复界面开关(自动平铺等),须在首次 pollOnce 之前
  log(`adb=${adbBin()}`);
  log(`scrcpy=${scrcpyBin()}`);
  const r = await execTolerant(adbBin(), ["start-server"], 25000);
  if (!r.ok) {
    log(`adb server 首次启动失败: ${((r.stderr || r.stdout).trim().split(/\r?\n/).pop()) || "未知"}`);
    await recoverAdb("启动时 server 不可用");
  }
  pollOnce();
  setInterval(pollOnce, POLL_INTERVAL);
  // 群控 App 版本检查:启动查一次,之后每 30 分钟复查(有新版会在界面与日志提示)
  checkAppUpdate();
  setInterval(checkAppUpdate, APP_UPDATE_CHECK_MS);
  // 闲鱼锁定版:启动检查本地是否就绪(未就绪提示预下载,「初始化」才能一键统一版本)
  checkXianyu();
  setInterval(checkXianyu, APP_UPDATE_CHECK_MS);
  // 桌面端本体代码热更新:启动查一次,之后每 30 分钟复查(下载落位后提示重启生效)
  checkCodeUpdate();
  setInterval(checkCodeUpdate, APP_UPDATE_CHECK_MS);
  // 员工登录:启动先续/自动登录一次,之后每 6 小时看一眼令牌
  keepLoggedIn().catch((e) => log(`登录续期异常: ${e.message}`));
  setInterval(() => keepLoggedIn().catch(() => {}), 6 * 3600e3);
});

app.on("window-all-closed", () => {
  for (const serial of [...scrcpyProcs.keys()]) closeScreen(serial);
  app.quit();
});

// ---- 群控 App 在线更新:版本检查 + 一键下载 ----
// 版本清单 version.json 与 APK 同目录托管;装机包版本读 APK 同目录 sidecar(gc-app-version.txt)。
// 下载到 userData 后 apkPath() 自动优先,之后「装App/初始化」装的就是新版。

const appUpdateInfo = {
  checking: false,
  latest: null,          // {versionName, versionCode, url, md5, notes}
  bundled: null,         // 当前装机包版本 {versionName, versionCode}(sidecar 缺失为 null)
  updateAvailable: false,
  downloaded: false,     // userData 已有不旧于 latest 的下载包
  error: "",
};

function httpsGetBuffer(url, timeout = 15000, redirects = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(httpsGetBuffer(new URL(res.headers.location, url).toString(), timeout, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
  });
}

// 读 APK 同目录 sidecar 版本文件(versionCode=3 / versionName=1.2 两行)
function readApkSidecarVersion(apkFile) {
  try {
    const sidecar = path.join(path.dirname(apkFile), "gc-app-version.txt");
    const txt = fs.readFileSync(sidecar, "utf8");
    const code = Number((txt.match(/versionCode\s*[=:]\s*(\d+)/) || [])[1]);
    const name = (txt.match(/versionName\s*[=:]\s*([^\s]+)/) || [])[1] || "";
    return code ? { versionCode: code, versionName: name } : null;
  } catch (_) {
    return null;
  }
}

async function checkAppUpdate(manual = false) {
  if (appUpdateInfo.checking) return appUpdateInfo;
  appUpdateInfo.checking = true;
  appUpdateInfo.error = "";
  pushState();
  try {
    const buf = await httpsGetBuffer(APP_VERSION_URL, 10000);
    const j = JSON.parse(buf.toString("utf8"));
    const latest = {
      versionName: String(j.versionName || ""),
      versionCode: Number(j.versionCode || 0),
      url: String(j.url || ""),
      md5: j.md5 ? String(j.md5) : "",
      notes: j.notes ? String(j.notes) : "",
    };
    if (!latest.versionCode || !latest.url) throw new Error("版本清单缺字段");
    const apk = apkPath();
    const current = apk ? readApkSidecarVersion(apk) : null;
    const downloadedVer = fs.existsSync(downloadedApkPath())
      ? readApkSidecarVersion(downloadedApkPath()) : null;
    appUpdateInfo.latest = latest;
    appUpdateInfo.bundled = current;
    appUpdateInfo.downloaded = !!downloadedVer && downloadedVer.versionCode >= latest.versionCode;
    appUpdateInfo.updateAvailable = !appUpdateInfo.downloaded &&
      (!current || latest.versionCode > current.versionCode);
    if (appUpdateInfo.updateAvailable) {
      log(`发现群控 App 新版 ${latest.versionName}(${latest.versionCode})` +
        (current ? `,当前装机包 ${current.versionName}(${current.versionCode})` : "") +
        " — 点「下载新版」后,装App/初始化即用新版");
    } else if (manual) {
      log(`App 版本检查:已是最新 ${latest.versionName}(${latest.versionCode})`);
    }
  } catch (e) {
    appUpdateInfo.error = e.message || String(e);
    if (manual) log(`App 版本检查失败: ${appUpdateInfo.error}`);
  } finally {
    appUpdateInfo.checking = false;
    pushState();
  }
  return appUpdateInfo;
}

async function downloadAppUpdate() {
  const latest = appUpdateInfo.latest;
  if (!latest || !latest.url) return { ok: false, error: "尚未检查到版本信息" };
  const dest = downloadedApkPath();
  try {
    log(`下载群控 App 新版 ${latest.versionName}…`);
    const buf = await httpsGetBuffer(latest.url, 120000);
    if (latest.md5) {
      const md5 = crypto.createHash("md5").update(buf).digest("hex");
      if (md5 !== latest.md5) throw new Error(`MD5 校验失败(${md5})`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    fs.writeFileSync(
      path.join(path.dirname(dest), "gc-app-version.txt"),
      `versionCode=${latest.versionCode}\nversionName=${latest.versionName}\n`
    );
    appUpdateInfo.downloaded = true;
    appUpdateInfo.updateAvailable = false;
    appUpdateInfo.bundled = { versionCode: latest.versionCode, versionName: latest.versionName };
    pushState();
    log(`新版 ${latest.versionName} 已下载(${Math.round(buf.length / 1024)}KB),「装App/初始化」将安装此版本`);
    return { ok: true };
  } catch (e) {
    log(`下载新版失败: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ---- 闲鱼锁定版 APK:预下载到 userData(未打包进安装包/需刷新时的入口) ----
// 版本清单 xianyu-version.json 与 APK 同目录托管;本地优先级 env > userData 下载 > 随包 vendor。
const xianyuInfo = {
  checking: false,
  locked: null,        // {versionName, versionCode, url, md5}
  local: null,         // 本地 APK 版本 {versionName, versionCode}(找不到 APK 为 null)
  ready: false,        // 本地已有与锁定版一致的 APK(初始化可一键装)
  downloading: false,
  error: "",
};

function downloadedXianyuPath() {
  return path.join(app.getPath("userData"), "apk", "xianyu.apk");
}

// 读闲鱼 APK 同目录的 xianyu-version.txt(「versionName  7.25.80 / versionCode  490」格式)
function readXianyuSidecar(apkFile) {
  try {
    const txt = fs.readFileSync(path.join(path.dirname(apkFile), "xianyu-version.txt"), "utf8");
    const name = (txt.match(/versionName\s*[=:]?\s*([^\s]+)/) || [])[1] || "";
    const code = Number((txt.match(/versionCode\s*[=:]?\s*(\d+)/) || [])[1]);
    return name ? { versionName: name, versionCode: code || 0 } : null;
  } catch (_) {
    return null;
  }
}

async function checkXianyu(manual = false) {
  if (xianyuInfo.checking) return xianyuInfo;
  xianyuInfo.checking = true;
  xianyuInfo.error = "";
  pushState();
  try {
    const buf = await httpsGetBuffer(XIANYU_VERSION_URL, 10000);
    const j = JSON.parse(buf.toString("utf8"));
    const locked = {
      versionName: String(j.versionName || ""),
      versionCode: Number(j.versionCode || 0),
      url: String(j.url || ""),
      md5: j.md5 ? String(j.md5) : "",
    };
    if (!locked.versionName || !locked.url) throw new Error("版本清单缺字段");
    const apk = xianyuApkPath();
    const local = apk ? readXianyuSidecar(apk) : null;
    xianyuInfo.locked = locked;
    xianyuInfo.local = local;
    // 有 APK 但读不到 sidecar 版本时按锁定版对待(随包 vendor 那份本来就是锁定的)
    xianyuInfo.ready = !!apk && (!local || local.versionName === locked.versionName);
    if (!xianyuInfo.ready) {
      log(`闲鱼锁定版 ${locked.versionName} 本地未就绪 — 点「下载闲鱼」预下载后,初始化才能一键统一版本`);
    } else if (manual) {
      log(`闲鱼锁定版 ${locked.versionName}:本地已就绪`);
    }
  } catch (e) {
    xianyuInfo.error = e.message || String(e);
    if (manual) log(`闲鱼版本检查失败: ${xianyuInfo.error}`);
  } finally {
    xianyuInfo.checking = false;
    pushState();
  }
  return xianyuInfo;
}

async function downloadXianyu() {
  const locked = xianyuInfo.locked;
  if (!locked || !locked.url) return { ok: false, error: "尚未检查到版本信息" };
  if (xianyuInfo.downloading) return { ok: false, error: "正在下载中" };
  const dest = downloadedXianyuPath();
  xianyuInfo.downloading = true;
  pushState();
  try {
    log(`下载闲鱼锁定版 ${locked.versionName}(约 84MB)…`);
    const buf = await httpsGetBuffer(locked.url, 300000);
    if (locked.md5) {
      const md5 = crypto.createHash("md5").update(buf).digest("hex");
      if (md5 !== locked.md5) throw new Error(`MD5 校验失败(${md5})`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    fs.writeFileSync(
      path.join(path.dirname(dest), "xianyu-version.txt"),
      `versionName  ${locked.versionName}\nversionCode  ${locked.versionCode}\n`
    );
    xianyuInfo.downloading = false;
    xianyuInfo.ready = true;
    xianyuInfo.local = { versionName: locked.versionName, versionCode: locked.versionCode };
    pushState();
    log(`闲鱼 ${locked.versionName} 已下载(${Math.round(buf.length / 1024 / 1024)}MB),「初始化」将用它统一各机版本`);
    return { ok: true };
  } catch (e) {
    xianyuInfo.downloading = false;
    xianyuInfo.error = e.message || String(e);
    pushState();
    log(`下载闲鱼失败: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ---- 桌面端本体代码热更新:desktop-code-version.json 驱动,逐文件下载+MD5校验,重启生效 ----
// 安装包入口是 loader.js(永不变),启动时优先加载 userData/code/main.js。
// 因此发新版=服务器传代码文件+更新清单,客户端下载后重启即换新,无需重打安装包。
const DESKTOP_CODE_VERSION_URL = "http://127.0.0.1:8000";
const DESKTOP_CODE_BASE_URL = DESKTOP_CODE_VERSION_URL.replace(/\/[^/]*$/, "/");

const codeUpdateInfo = {
  checking: false,
  current: null,       // 正在运行的代码版本 {versionName, codeVersion}
  latest: null,        // 清单里的最新版本 {versionName, codeVersion, files, notes}
  updateAvailable: false,
  readyToApply: false, // 已下载并落位,重启即生效
  downloading: false,
  error: "",
};

// 当前运行的代码版本:热更新副本(userData/code)优先,否则安装包内置
function currentCodeVersion() {
  for (const p of [
    path.join(app.getPath("userData"), "code", "code-version.json"),
    path.join(__dirname, "code-version.json"),
  ]) {
    try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { /* 下一个 */ }
  }
  return { versionName: "?", codeVersion: 0 };
}

async function checkCodeUpdate(manual = false) {
  if (codeUpdateInfo.checking) return codeUpdateInfo;
  codeUpdateInfo.checking = true;
  codeUpdateInfo.error = "";
  pushState();
  try {
    const buf = await httpsGetBuffer(DESKTOP_CODE_VERSION_URL, 10000);
    const j = JSON.parse(buf.toString("utf8"));
    const latest = {
      versionName: String(j.versionName || ""),
      codeVersion: Number(j.codeVersion || 0),
      files: j.files || {},
      notes: j.notes ? String(j.notes) : "",
    };
    if (!latest.codeVersion || !Object.keys(latest.files).length) throw new Error("代码清单缺字段");
    codeUpdateInfo.current = currentCodeVersion();
    codeUpdateInfo.latest = latest;
    // readyToApply 只由 downloadCodeUpdate 落位后置真;重启后 current==latest,自然归位
    codeUpdateInfo.readyToApply = false;
    codeUpdateInfo.updateAvailable = latest.codeVersion > codeUpdateInfo.current.codeVersion;
    if (codeUpdateInfo.updateAvailable) {
      log(`发现桌面端代码新版 ${latest.versionName}(${latest.codeVersion}),当前 ${codeUpdateInfo.current.versionName}(${codeUpdateInfo.current.codeVersion}) — 点「下载更新」`);
    } else if (manual) {
      log(`桌面端代码:已是最新 ${latest.versionName}`);
    }
  } catch (e) {
    codeUpdateInfo.error = e.message || String(e);
    if (manual) log(`桌面端代码检查失败: ${codeUpdateInfo.error}`);
  } finally {
    codeUpdateInfo.checking = false;
    pushState();
  }
  return codeUpdateInfo;
}

async function downloadCodeUpdate() {
  const latest = codeUpdateInfo.latest;
  if (!latest || !latest.files) return { ok: false, error: "尚未检查到版本信息" };
  if (codeUpdateInfo.downloading) return { ok: false, error: "正在下载中" };
  codeUpdateInfo.downloading = true;
  pushState();
  const stage = path.join(app.getPath("userData"), "code-tmp");
  const dest = path.join(app.getPath("userData"), "code");
  try {
    log(`下载桌面端代码新版 ${latest.versionName}(${Object.keys(latest.files).length} 个文件)…`);
    fs.rmSync(stage, { recursive: true, force: true });
    for (const [rel, md5] of Object.entries(latest.files)) {
      const buf = await httpsGetBuffer(DESKTOP_CODE_BASE_URL + rel, 60000);
      const real = crypto.createHash("md5").update(buf).digest("hex");
      if (md5 && real !== md5) throw new Error(`${rel} MD5 校验失败`);
      const fp = path.join(stage, rel);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, buf);
    }
    // 清单本身也落进去(标记热更副本的版本号)
    fs.writeFileSync(
      path.join(stage, "code-version.json"),
      JSON.stringify({ versionName: latest.versionName, codeVersion: latest.codeVersion })
    );
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(stage, dest);
    codeUpdateInfo.downloading = false;
    codeUpdateInfo.updateAvailable = false;
    codeUpdateInfo.readyToApply = true;
    pushState();
    log(`桌面端代码 ${latest.versionName} 已下载,重启应用后生效(投屏窗口会随应用重启关闭)`);
    return { ok: true };
  } catch (e) {
    codeUpdateInfo.downloading = false;
    codeUpdateInfo.error = e.message || String(e);
    fs.rmSync(stage, { recursive: true, force: true });
    pushState();
    log(`下载桌面端代码失败: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ---- AdsPower 群控(浏览器形态执行端):托管本机 gc-ads 运维 CLI ----
// gc-ads 目录两种形态:打包态(gc-ads.exe 旁挂 config.yaml)或源码态(manage.py + .venv)。
// 状态/启停全部走它的 CLI(status --json / start / stop / doctor),日志直接读 logs/ 下文件。
const ADS_API_BASE = "http://127.0.0.1:50325"; // 勿用 local.adspower.net:会被代理 fake-ip 劫持(与 gc_ads/config.py 一致)

function adsRootValid(dir) {
  if (!dir) return false;
  try {
    return fs.existsSync(path.join(dir, process.platform === "win32" ? "gc-ads.exe" : "gc-ads"))
      || fs.existsSync(path.join(dir, "manage.py"));
  } catch (_) { return false; }
}

// gc-ads 的固定位置:项目自己的文件夹,不摊在盘符根下(2026-10-06 用户:「直接固定位置,
// win 就放 C 盘」,随后又定「放在 c:/xianyu 这样自己用项目命名的文件夹下,而不是直接裸目录」)。
// 行情台没有代理时要直接起停执行端,它也认这里——两边必须是同一个地方。
// 同一天短暂用过的 C:\gc-ads(~/gc-ads)在下面的老位置里照认。
function adsFixedDir() {
  return process.platform === "win32"
    ? "C:\\xianyu\\gc-ads"
    : path.join(require("os").homedir(), "xianyu", "gc-ads");
}

// 定位 gc-ads 根目录:env > 缓存 > 固定位置 > 老位置;找不到返回 null(界面引导手动选目录)
function adsRoot() {
  if (process.env.GC_ADS_ROOT && adsRootValid(process.env.GC_ADS_ROOT)) return process.env.GC_ADS_ROOT;
  const cache = loadCachedPaths();
  if (adsRootValid(cache.gcAdsRoot)) return cache.gcAdsRoot;
  const home = require("os").homedir();
  const cands = [
    adsFixedDir(),
    // 以前一键安装落在这里(守护端数据目录);老安装照认,新装一律去固定位置
    path.join(app.getPath("userData"), "gc-ads"),
    path.join(home, "Desktop", "gc-ads"),
    path.join(home, "Desktop", "adspower-executor"),
  ];
  if (process.platform === "win32") {
    cands.push("C:\\gc-ads", "D:\\gc-ads", "C:\\adspower-executor", "D:\\adspower-executor");
  } else {
    cands.push(path.join(home, "gc-ads"), path.join(home, "adspower-executor"));
  }
  const hit = cands.find(adsRootValid) || null;
  if (hit) {
    cache.gcAdsRoot = hit;
    saveCachedPaths();
  }
  return hit;
}

// gc-ads 调用方式:打包态直接跑 exe;源码态跑 .venv 里的 python manage.py。不可用返回 null。
function adsCmd(root) {
  const exe = path.join(root, process.platform === "win32" ? "gc-ads.exe" : "gc-ads");
  if (fs.existsSync(exe)) return { bin: exe, prefix: [], mode: "exe" };
  const py = process.platform === "win32"
    ? path.join(root, ".venv", "Scripts", "python.exe")
    : path.join(root, ".venv", "bin", "python");
  if (fs.existsSync(path.join(root, "manage.py")) && fs.existsSync(py)) {
    return { bin: py, prefix: ["manage.py"], mode: "源码" };
  }
  return null;
}

// 跑 gc-ads 子命令;PYTHONUTF8 强制 utf8,防 Windows 上中文输出乱码导致 JSON 解析失败
function adsRun(args, timeout = 60000) {
  return new Promise((resolve) => {
    const root = adsRoot();
    const cmd = root && adsCmd(root);
    if (!cmd) {
      return resolve({ ok: false, error: "未找到 gc-ads 安装(点「设置目录」选择含 gc-ads.exe 或 manage.py 的文件夹)" });
    }
    execFile(cmd.bin, [...cmd.prefix, ...args], {
      cwd: root, timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    }, (err, stdout, stderr) => {
      if (err) {
        return resolve({ ok: false, error: ((stderr || "") + (stdout || "")).trim().slice(-400) || err.message });
      }
      resolve({ ok: true, out: (stdout || "").trim() });
    });
  });
}

// AdsPower 客户端 Local API 是否在线(客户端已启动且开了 API 服务)
function adsApiAlive() {
  return new Promise((resolve) => {
    const r = http.get(`${ADS_API_BASE}/api/v1/browser/local-active`, { timeout: 5000 }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d).code === 0); } catch (_) { resolve(false); } });
    });
    r.on("error", () => resolve(false));
    r.on("timeout", () => { r.destroy(); resolve(false); });
  });
}

async function adsDetect() {
  const root = adsRoot();
  const cmd = root && adsCmd(root);
  return {
    root: root || "",
    mode: cmd ? cmd.mode : "",
    hasConfig: !!(root && fs.existsSync(path.join(root, "config.yaml"))),
    apiAlive: await adsApiAlive(),
  };
}

// ---- gc-ads 一键安装:Windows 免安装包(自带 Python 运行时)下载 → 解压 → 自动写线上配置 ----
const GC_ADS_WIN_ZIP_URL = "http://127.0.0.1:8000";

// 一键安装装到固定位置,不再装进守护端自己的数据目录——那里行情台找不到
function adsInstallDir() {
  return adsFixedDir();
}

// 流式下载到文件(带进度回调,zip 几十 MB 不整块读进内存)
function httpsDownloadToFile(url, dest, onProgress, redirects = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(httpsDownloadToFile(new URL(res.headers.location, url).toString(), dest, onProgress, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const total = Number(res.headers["content-length"] || 0);
      let received = 0;
      const out = fs.createWriteStream(dest);
      res.on("data", (c) => {
        received += c.length;
        if (onProgress) onProgress(received, total);
      });
      res.pipe(out);
      out.on("finish", () => out.close(() => resolve({ received, total })));
      out.on("error", reject);
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

// 解压 zip 到 userData:优先系统自带 tar(Win10+ 内置 bsdtar 直接吃 zip),失败回退 PowerShell Expand-Archive
async function extractZip(zipFile, destDir) {
  // 已存在就别建:一键安装曾解到 C 盘根(C:\),Windows 上对盘符根做递归 mkdir 会直接报 EPERM
  // (2026-10-06 行情台同一段代码现场报错,txy 上 Node 24 复现),不会当作「已存在」放过去。
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  const tar = await execTolerant("tar", ["-xf", zipFile, "-C", destDir], 300000);
  if (tar.ok) return;
  const ps = await execShell(
    `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${destDir}' -Force"`, 300000);
  if (!ps.ok) throw new Error(`解压失败: ${(ps.stderr || ps.stdout || "").trim().slice(-200)}`);
}

// 装完自动生成线上配置:以包内 config.example.yaml 为底,只把 server 段换成线上值;
// 已有 config.yaml 不覆盖(更新场景保留操作员填好的 environments)
function adsWriteProdConfig(root) {
  const cfgPath = path.join(root, "config.yaml");
  if (fs.existsSync(cfgPath)) return false;
  // onedir 打包形态下模板在 _internal/ 里(PyInstaller datas 落点),源码形态在根目录
  const example = ["config.example.yaml", path.join("_internal", "config.example.yaml")]
    .map((f) => path.join(root, f))
    .find((f) => fs.existsSync(f));
  let text = example ? fs.readFileSync(example, "utf8") : "";
  const prodServer =
    'server:\n  base_url: "http://127.0.0.1:8000"\n' +
    '  enroll_secret: "DEMO_ONLY_REDACTED"  # 与群控 App 同一密钥\n' +
    '  mqtt_host: "service.example.invalid"\n  mqtt_port: 8883\n  mqtt_tls: true\n';
  if (!/server:\n(  .*\n)+/.test(text)) return false;
  text = text.replace(/server:\n(  .*\n)+/, prodServer);
  fs.writeFileSync(cfgPath, text, "utf8");
  return true;
}

const adsInstallInfo = { phase: "idle", received: 0, total: 0, error: "" };

// ---- gc-ads 看门狗:常驻前台进程(gc-ads run),崩了拉起 executor、浏览器掉了重开 ----
// 守护端以 detached 拉起并记 pid 到 userData;守护端退出不影响看门狗存活。
const ADS_WATCHDOG_STATE = () => path.join(app.getPath("userData"), "gc-ads-watchdog.json");

function adsWatchdogPid() {
  try {
    const pid = JSON.parse(fs.readFileSync(ADS_WATCHDOG_STATE(), "utf8")).pid;
    if (pid) process.kill(Number(pid), 0); // 存活探测(不发信号)
    return Number(pid);
  } catch (_) {
    return 0;
  }
}

function adsWatchdogStart() {
  if (adsWatchdogPid()) return { ok: true, note: "看门狗已在运行" };
  const root = adsRoot();
  const cmd = root && adsCmd(root);
  if (!cmd) return { ok: false, error: "未找到 gc-ads 安装" };
  const logDir = path.join(root, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const outFd = fs.openSync(path.join(logDir, "watchdog.log"), "a");
  const child = spawn(cmd.bin, [...cmd.prefix, "run"], {
    cwd: root, detached: true, windowsHide: true,
    stdio: ["ignore", outFd, outFd],
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
  });
  child.unref();
  fs.closeSync(outFd);
  fs.writeFileSync(ADS_WATCHDOG_STATE(), JSON.stringify({ pid: child.pid, at: Date.now() }), "utf8");
  log(`gc-ads 看门狗已启动 (pid=${child.pid}):executor 崩溃自动拉起、浏览器掉了自动重开`);
  return { ok: true, pid: child.pid };
}

function adsWatchdogStop() {
  const pid = adsWatchdogPid();
  if (!pid) return { ok: true, note: "看门狗未在运行" };
  try {
    process.kill(pid, "SIGTERM");
  } catch (e) {
    return { ok: false, error: e.message };
  }
  fs.rmSync(ADS_WATCHDOG_STATE(), { force: true });
  log(`gc-ads 看门狗已停止 (pid=${pid});executor 子进程不受影响`);
  return { ok: true };
}

function pushAdsInstall() {
  if (win && !win.isDestroyed()) win.webContents.send("ads-install-progress", { ...adsInstallInfo });
}

// 一键安装/重装:下载 zip → 解压到 userData/gc-ads → 写线上配置 → 让 adsRoot 立即认到
async function adsInstall() {
  if (process.platform !== "win32") {
    return { ok: false, error: "一键安装的是 Windows 免安装包;本机请用「装机」页的源码包(setup.sh)" };
  }
  if (adsInstallInfo.phase === "downloading" || adsInstallInfo.phase === "extracting") {
    return { ok: false, error: "正在安装中" };
  }
  const dir = adsInstallDir();
  const zip = path.join(app.getPath("userData"), "gc-ads-windows.zip");
  Object.assign(adsInstallInfo, { phase: "downloading", received: 0, total: 0, error: "" });
  pushAdsInstall();
  try {
    log("下载 gc-ads Windows 免安装包…");
    await httpsDownloadToFile(GC_ADS_WIN_ZIP_URL, zip, (received, total) => {
      adsInstallInfo.received = received;
      adsInstallInfo.total = total;
      pushAdsInstall();
    });
    adsInstallInfo.phase = "extracting";
    pushAdsInstall();
    log("解压 gc-ads 安装包…");
    // 重装场景:先清旧目录(zip 里是 gc-ads/ 顶层目录)
    fs.rmSync(dir, { recursive: true, force: true });
    // zip 的顶层就是 gc-ads/,解到固定位置的上一级(C:\xianyu)正好落成 C:\xianyu\gc-ads
    await extractZip(zip, path.dirname(dir));
    if (!adsRootValid(dir)) throw new Error("解压后未找到 gc-ads.exe,安装包可能损坏");
    const wroteCfg = adsWriteProdConfig(dir);
    const cache = loadCachedPaths();
    cache.gcAdsRoot = dir;
    saveCachedPaths();
    adsInstallInfo.phase = "done";
    pushAdsInstall();
    log(`gc-ads 安装完成: ${dir}${wroteCfg ? "(已自动写好线上配置,还需在 config.yaml 填 AdsPower 环境 ID)" : "(沿用已有配置)"}`);
    try { fs.rmSync(zip, { force: true }); } catch (_) { /* 清理失败无碍 */ }
    return { ok: true, root: dir, wroteConfig: wroteCfg };
  } catch (e) {
    adsInstallInfo.phase = "error";
    adsInstallInfo.error = e.message || String(e);
    pushAdsInstall();
    log(`gc-ads 安装失败: ${adsInstallInfo.error}`);
    return { ok: false, error: adsInstallInfo.error };
  }
}

// ---- IPC ----
ipcMain.handle("get-state", () => lastState);
// 员工登录(见「员工登录」一节)
ipcMain.handle("auth-state", () => authState());
ipcMain.handle("auth-remembered", () => rememberedLogin());
ipcMain.handle("auth-login", async (_e, { username, password, remember } = {}) => {
  const u = String(username || "").trim();
  const pw = String(password || "");
  if (!u || !pw) return { ok: false, reason: "请填写账号和密码" };
  try {
    const data = await erpLogin(u, pw);
    // 登录成功才记:记一个错的密码,下次就是一次必然失败的自动登录
    const passwordSaved = setRemembered(u, pw, Boolean(remember));
    accountFetchedAt = 0;          // 换了身份,账号与设备名缓存都重取
    deviceNameCache.at = 0;
    log(`已登录:${(data.staff && (data.staff.name || data.staff.username)) || u}`);
    notifyAuth();
    return { ok: true, staff: data.staff, passwordSaved };
  } catch (e) {
    return { ok: false, reason: e.message || "登录失败" };
  }
});
ipcMain.handle("auth-logout", () => {
  clearToken();
  log("已退出登录");
  notifyAuth();
  return { ok: true };
});
// 自绘标题栏(frame:false)的窗口控制
ipcMain.handle("win-min", () => win && win.minimize());
ipcMain.handle("win-max-toggle", () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
});
ipcMain.handle("win-close", () => win && win.close());
// 手动刷新设备列表:立即跑一轮轮询(自动轮询 5s 一轮,此入口用于不想等的时候)
ipcMain.handle("refresh-devices", async () => {
  await pollOnce();
  return { ok: true, count: (lastState.devices || []).length };
});
ipcMain.handle("open-screen", (_e, serial) => {
  const r = openScreen(serial);
  pushState();
  return r;
});
ipcMain.handle("close-screen", (_e, serial) => {
  closeScreen(serial);
  pushState();
  return { ok: true };
});
ipcMain.handle("tile-screens", () => tileAllScreens());   // 手动:一键矩阵投屏(平铺所有)
ipcMain.handle("set-autotile", (_e, on) => {
  settings.autoTileOn = !!on;
  saveSettings(); // 持久化,重启后保留
  log(settings.autoTileOn ? "自动矩阵投屏:开(下次启动/重连时平铺)" : "自动矩阵投屏:关");
  return settings.autoTileOn;
});
ipcMain.handle("revive", async (_e, serial) => {
  try {
    await revive(serial);
    log(`手动拉活 ${serial}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle("set-autoperm", (_e, on) => {
  settings.autoPermOn = !!on;
  saveSettings(); // 持久化,重启后保留
  log(settings.autoPermOn ? "自动补权限:开(检测不足即用 adb 补齐)" : "自动补权限:关");
  return settings.autoPermOn;
});
ipcMain.handle("check-app-update", () => checkAppUpdate(true));
ipcMain.handle("download-app-update", () => downloadAppUpdate());
ipcMain.handle("check-xianyu", () => checkXianyu(true));
ipcMain.handle("download-xianyu", () => downloadXianyu());
ipcMain.handle("check-code-update", () => checkCodeUpdate(true));
ipcMain.handle("download-code-update", () => downloadCodeUpdate());
ipcMain.handle("relaunch-app", () => {
  log("重启应用以应用桌面端代码更新…");
  app.relaunch();
  app.exit(0);
});

// 解冻账号:把 gc 服务端账号恢复为 ACTIVE(风控冻结时手动入口)。
// 按账号 id 解——解冻只是改服务端一条记录,不需要执行端在本机。原来按本机手机序列号
// 反查昵称再找账号,浏览器号(执行端在别的电脑上)就一直没有解冻按钮(2026-10-06)。
// 风控一起清:命中风控时 runner 把 status 和 risk_state 一起冻,调度器两个都看,只改
// status 解不开。
ipcMain.handle("unfreeze-account", async (_e, { accountId, label } = {}) => {
  if (!accountId) return { ok: false, error: "没有账号 id" };
  const who = label || accountId;
  try {
    await patchAccount(accountId, { status: "ACTIVE", risk_state: "NORMAL", risk_note: "" });
    log(`解冻 ${who}: 已恢复 ACTIVE`);
    accountFetchedAt = 0; // 立即刷新账号状态
    await fetchAccounts().catch(() => {});
    pollOnce();
    return { ok: true };
  } catch (e) {
    log(`解冻 ${who} 失败: ${e.message}`);
    return { ok: false, error: e.message };
  }
});

// 任务队列:GET /gc/tasks(带筛选/分页) + /gc/devices 做 id→name 映射;失败返回 {error} 不抛
ipcMain.handle("get-tasks", async (_e, filter = {}) => {
  try {
    const params = new URLSearchParams({ page: String(filter.page || 1), page_size: "50", with_total: "true", exclude_type: "chat_scan" });
    if (filter.status) params.set("status", filter.status);
    if (filter.device_id) params.set("device_id", String(filter.device_id));
    const [data, devMap] = await Promise.all([
      gcApiJson("GET", `/gc/tasks?${params}`),
      fetchDeviceNames().catch(() => new Map()), // 设备映射失败不阻塞任务列表
    ]);
    // gc-server 未升级到带 with_total 的版本时会直接返回数组,这里兜底兼容
    const rawItems = Array.isArray(data) ? data : data.items || [];
    const items = rawItems.map((t) => ({ ...t, device_name: devMap.get(t.device_id) || "" }));
    return { items, total: Array.isArray(data) ? items.length : data.total ?? items.length };
  } catch (e) {
    return { error: e.message || String(e) };
  }
});

// 重发任务:取原任务,按原参数新建一条 source=MANUAL 的任务
ipcMain.handle("retry-task", async (_e, taskId) => {
  try {
    const t = await gcApiJson("GET", `/gc/tasks/${taskId}`);
    await gcApiJson("POST", "/gc/tasks", {
      device_id: t.device_id,
      account_id: t.account_id,
      task_type: t.task_type,
      spec: t.spec,
      source: "MANUAL",
    });
    log(`重发任务 #${taskId}(${t.task_type})`);
    return { ok: true };
  } catch (e) {
    log(`重发任务 #${taskId} 失败: ${e.message}`);
    return { error: e.message || String(e) };
  }
});

// 手机识别异常时手动重启 adb server
ipcMain.handle("restart-adb", async () => {
  log("手动重启 adb server…");
  await execTolerant(adbBin(), ["kill-server"]);
  await new Promise((resolve) => setTimeout(resolve, 800));
  const start = await execTolerant(adbBin(), ["start-server"], 25000);
  if (start.ok) {
    log("adb server 已重启");
    setTimeout(pollOnce, 1000);
    return { ok: true };
  }
  const tail = (start.stderr || start.stdout || "").trim().split(/\r?\n/).pop() || "未知错误";
  log(`adb server 重启失败: ${tail}`);
  return { ok: false, error: tail };
});
// 手动一键:立即对所有已连接且装了 App 的设备做全量权限审计+补齐
ipcMain.handle("fix-perms", async () => {
  const eligible = (lastState.devices || []).filter(
    (d) => d.state === "device" && d.appInstalled !== false
  );
  if (!eligible.length) {
    log("补权限:没有可操作的设备(需已连接且装了群控 App)");
    return { ok: false, count: 0 };
  }
  log(`手动补权限:审计 ${eligible.length} 台…`);
  for (const d of eligible) await maintainDevice(d.serial, true);
  pushState();
  return { ok: true, count: eligible.length };
});

// 一键安装/覆盖安装随包 APK 到指定设备(adb install -r)
ipcMain.handle("install-app", async (_e, serial) => {
  const apk = apkPath();
  if (!apk) {
    log("安装失败: 未找到随包 APK(vendor/app/gc-app.apk)");
    return { ok: false, error: "no apk" };
  }
  log(`安装 App → ${serial}( ${path.basename(apk)} )…`);
  const r = await installApk(serial, apk, ["-r"]);
  if (r.ok) {
    log(`安装 ${serial}: ${r.msg}`);
    return { ok: true };
  }
  log(`安装 ${serial} 失败: ${r.msg.slice(0, 160)}`);
  return { ok: false, error: r.msg };
});

// ---- 一键初始化:新手机接入后点一次,IME/无障碍/权限/防息屏/闲鱼版本全配好 ----
// (GC_IME / GC_A11Y / 能力表 CAPS 定义在上方「权限/保活」区)

// adb install 结果解析:新版 adb 失败走非零退出+stderr,旧版把 "Failure [..]" 打 stdout 仍返回 0,两路都要看
async function installApk(serial, apk, extraArgs = []) {
  const r = await new Promise((resolve) => {
    execFile(adbBin(), ["-s", serial, "install", ...extraArgs, apk],
      { timeout: 300000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ err, out: `${stdout || ""}\n${stderr || ""}` }));
  });
  const tail = r.out.trim().split(/\r?\n/).filter(Boolean).pop() || "";
  if (r.err || /failure|error/i.test(r.out)) return { ok: false, msg: tail };
  return { ok: true, msg: tail || "Success" };
}

// 装闲鱼锁定版:先试 -r -d;高版本降不下来(Android10+ 仅 debuggable 包可 -d)时
// 走「pm uninstall -k(保数据/保登录态) → 重装(仍带-d,MIUI 会记旧版本号)」;
// 仍失败则完整卸载重装(登录态丢失,但保证手机有闲鱼可用)并大字告警。
async function installXianyuLocked(serial, apk) {
  let r = await installApk(serial, apk, ["-r", "-d"]);
  if (r.ok) return log(`初始化 ${serial}: 闲鱼统一版本安装 ${r.msg}`);
  if (!/VERSION_DOWNGRADE/i.test(r.msg)) {
    return log(`初始化 ${serial}: 闲鱼安装失败 ${r.msg.slice(0, 160)}`);
  }
  log(`初始化 ${serial}: 闲鱼为高版本,保数据降级回 ${XY_LOCKED_VERSION}(登录态保留)…`);
  try {
    await shell(serial, `pm uninstall -k ${XY_PKG}`, 60000);
  } catch (e) {
    return log(`初始化 ${serial}: 保数据卸载失败 ${(e.message || "").slice(0, 120)},已中止(不会继续动闲鱼)`);
  }
  r = await installApk(serial, apk, ["-r", "-d"]);
  if (r.ok) return log(`初始化 ${serial}: 闲鱼 ${XY_LOCKED_VERSION} 回装成功(数据/登录态保留)`);
  if (!/VERSION_DOWNGRADE/i.test(r.msg)) {
    return log(`初始化 ${serial}: ⚠ 闲鱼回装失败 ${r.msg.slice(0, 160)} — 该机闲鱼已被卸载,请手动补装!`);
  }
  // MIUI 保数据卸载后仍记旧版本号 → 最后手段:完整卸载(清残留版本记录)再装。登录态丢失!
  log(`初始化 ${serial}: 保数据降级仍被拒,完整卸载重装(⚠ 闲鱼登录态将丢失,需重新登录)…`);
  try {
    await shell(serial, `pm uninstall ${XY_PKG}`, 60000);
  } catch (_) { /* 已卸载也算成功 */ }
  r = await installApk(serial, apk);
  log(r.ok
    ? `初始化 ${serial}: 闲鱼 ${XY_LOCKED_VERSION} 已全新安装(⚠ 登录态已清,需重新登录)`
    : `初始化 ${serial}: ⚠⚠ 闲鱼全新安装仍失败 ${r.msg.slice(0, 160)} — 请手动补装!`);
}

ipcMain.handle("init-device", async (_e, serial) => {
  // 第 0 步:先装群控 App(没装的话后面输入法/无障碍全部设不上)
  const gcApk = apkPath();
  if (gcApk) {
    log(`初始化 ${serial}: 安装群控执行端…`);
    const r = await installApk(serial, gcApk, ["-r"]);
    log(r.ok ? `初始化 ${serial}: 群控执行端安装 ${r.msg}` : `初始化 ${serial}: 群控执行端安装失败 ${r.msg.slice(0, 160)}(继续尝试设置)`);
  } else {
    log(`初始化 ${serial}: 无随包群控 APK(vendor/app/gc-app.apk),跳过安装`);
  }
  // 用能力表全量补齐(force=不检测直接设),再把群控输入法设为默认(平时靠 app 临时切,这里初始化设一次)
  log(`初始化 ${serial}: 配置无障碍/输入法/权限/保活…`);
  const { failed } = await ensureCaps(serial, { full: true, force: true });
  try { await shell(serial, `ime set ${GC_IME}`, 20000); } catch (_) { /* 部分 ROM 需手动切默认输入法 */ }
  const total = CAPS.length;
  const okCount = total - failed.length;
  permState.set(serial, { missing: failed, at: Date.now() });
  if (failed.length) {
    log(`初始化 ${serial}: 权限 ${okCount}/${total} 成功;${failed.join("/")} 未设上(该机需开「USB调试(安全设置)」或 ROM 不支持,请手动补)`);
  } else {
    log(`初始化 ${serial}: 权限 ${okCount}/${total} 全部成功`);
  }
  // 统一闲鱼版本(有随包 APK 才装;高版本自动走保数据降级)
  const xy = xianyuApkPath();
  if (xy) {
    log(`初始化 ${serial}: 安装闲鱼统一版本 ${XY_LOCKED_VERSION}…`);
    await installXianyuLocked(serial, xy);
  } else {
    log(`初始化 ${serial}: 本地无闲鱼 APK,跳过版本统一(点界面「下载闲鱼」预下载后重试)`);
  }
  log(`初始化 ${serial} 完成:权限 ${okCount}/${total} 项成功`);
  // 账号初始化档案:adb 兜底采集 SN/双IMEI/手机号上报 gc 服务器(App 已上报的字段不覆盖)
  try {
    await reportDeviceInfo(serial);
  } catch (e) {
    log(`初始化 ${serial}: 硬件信息上报失败 ${(e.message || "").slice(0, 120)}(不影响初始化结果,可重试)`);
  }
  return { ok: true, passed: okCount, total };
});

// ---- AdsPower 群控(浏览器环境页)IPC ----
ipcMain.handle("ads-detect", () => adsDetect());
ipcMain.handle("ads-install", () => adsInstall());
ipcMain.handle("ads-watchdog-status", () => ({ running: adsWatchdogPid() > 0, pid: adsWatchdogPid() }));
ipcMain.handle("ads-watchdog-start", () => adsWatchdogStart());
ipcMain.handle("ads-watchdog-stop", () => adsWatchdogStop());

ipcMain.handle("ads-choose-root", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "选择 gc-ads 目录(含 gc-ads.exe 或 manage.py)",
    properties: ["openDirectory"],
  });
  if (r.canceled || !r.filePaths.length) return adsDetect();
  const dir = r.filePaths[0];
  if (!adsRootValid(dir)) {
    log(`gc-ads 目录无效: ${dir}(需含 gc-ads.exe,或 manage.py + .venv)`);
    return { ...(await adsDetect()), error: "所选目录里没有 gc-ads.exe 或 manage.py" };
  }
  const cache = loadCachedPaths();
  cache.gcAdsRoot = dir;
  saveCachedPaths();
  log(`gc-ads 目录已设置: ${dir}`);
  return adsDetect();
});

ipcMain.handle("ads-status", async () => {
  const r = await adsRun(["status", "--json"], 45000);
  if (!r.ok) return r;
  try {
    return { ok: true, rows: JSON.parse(r.out || "[]") };
  } catch (_) {
    return { ok: false, error: "gc-ads 版本过旧(不支持 status --json),请到「装机」页下载最新源码包更新", raw: r.out.slice(0, 300) };
  }
});

ipcMain.handle("ads-doctor", async () => {
  log("gc-ads 体检中…");
  const r = await adsRun(["doctor"], 90000);
  log(r.ok ? "gc-ads 体检完成" : `gc-ads 体检失败: ${r.error}`);
  return r;
});

ipcMain.handle("ads-start", async (_e, uids) => {
  const ids = (Array.isArray(uids) ? uids : []).filter((x) => /^[\w-]+$/.test(String(x)));
  log(ids.length ? `gc-ads 启动环境: ${ids.join(", ")}` : "gc-ads 启动全部启用环境…");
  const r = await adsRun(["start", ...ids], 180000);
  log(r.ok ? `gc-ads start: ${r.out.replace(/\r?\n/g, " | ").slice(0, 300)}` : `gc-ads start 失败: ${r.error}`);
  return r;
});

ipcMain.handle("ads-stop", async (_e, uids, withBrowser) => {
  const ids = (Array.isArray(uids) ? uids : []).filter((x) => /^[\w-]+$/.test(String(x)));
  const args = ["stop", ...ids];
  if (withBrowser) args.push("--browser");
  log(ids.length ? `gc-ads 停止环境: ${ids.join(", ")}` : "gc-ads 停止全部环境…");
  const r = await adsRun(args, 120000);
  log(r.ok ? `gc-ads stop: ${r.out.replace(/\r?\n/g, " | ").slice(0, 300)}` : `gc-ads stop 失败: ${r.error}`);
  return r;
});

// 读环境日志尾部(最多 256KB),文件不存在返回空串(环境还没跑过)
ipcMain.handle("ads-tail-log", (_e, uid, bytes = 16384) => {
  if (!/^[\w-]+$/.test(String(uid || ""))) return { ok: false, error: "非法 user_id" };
  const root = adsRoot();
  if (!root) return { ok: false, error: "未找到 gc-ads 安装" };
  const fp = path.join(root, "logs", `executor_${uid}.log`);
  try {
    const size = fs.statSync(fp).size;
    const start = Math.max(0, size - Math.min(Number(bytes) || 16384, 256 * 1024));
    const fd = fs.openSync(fp, "r");
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return { ok: true, out: buf.toString("utf8"), path: fp, truncated: start > 0 };
  } catch (_) {
    return { ok: true, out: "", path: fp };
  }
});

// ==================== 执行单元(账号为主体,真机与浏览器共表)====================
// 数据源是服务端 GET /gc/units 的聚合结果:账号 + 它当前的执行端 + 今日配额 + 在跑任务。
// 桌面端不自己拼这个 join——账号↔设备的权威在服务端,本地 adb 只知道插了哪几根线。
let unitsCache = { list: [], at: 0, error: "" };

ipcMain.handle("get-units", async (_e, force) => {
  if (!force && Date.now() - unitsCache.at < 15000 && unitsCache.list.length) {
    return { ok: true, units: unitsCache.list, cached: true };
  }
  try {
    const list = await gcApiJson("GET", "/gc/units");
    unitsCache = { list: Array.isArray(list) ? list : [], at: Date.now(), error: "" };
    return { ok: true, units: unitsCache.list };
  } catch (e) {
    unitsCache.error = e.message;
    // 拉不到就把上一次的给界面,总比整页空掉强;error 一并回去让界面标出「数据可能过期」
    return { ok: false, error: e.message, units: unitsCache.list, stale: unitsCache.list.length > 0 };
  }
});

// ---- 本机资源(总览页 KPI)----
// CPU 用两次采样的 idle/total 差值算占用率:os.loadavg() 在 Windows 上恒为 0,不能用。
let lastCpu = null;

function cpuSnapshot() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    for (const k of Object.keys(c.times)) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
}

function cpuPercent() {
  const now = cpuSnapshot();
  if (!lastCpu) { lastCpu = now; return null; }   // 首次没有基准,先不给数
  const dt = now.total - lastCpu.total;
  const di = now.idle - lastCpu.idle;
  lastCpu = now;
  if (dt <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((1 - di / dt) * 100)));
}

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === "IPv4" && !n.internal) return n.address;
    }
  }
  return "";
}

ipcMain.handle("host-metrics", () => {
  const totalMem = os.totalmem();
  return {
    host: os.hostname(),
    ip: lanIp(),
    os: `${os.type() === "Darwin" ? "macOS" : os.type() === "Windows_NT" ? "Windows" : os.type()} ${os.release()}`,
    uptimeSec: Math.floor(process.uptime()),   // 守护端自身运行时长,不是开机时长
    cpu: cpuPercent(),
    memPct: Math.round((1 - os.freemem() / totalMem) * 100),
    memUsedGb: +((totalMem - os.freemem()) / 1073741824).toFixed(1),
    memTotalGb: +(totalMem / 1073741824).toFixed(1),
  };
});
