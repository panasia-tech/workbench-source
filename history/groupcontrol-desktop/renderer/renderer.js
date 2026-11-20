"use strict";
/**
 * 群控守护 桌面端 - 渲染层(设计稿「执行单元管理器」结构:标题栏 + rail 五页 + 状态栏)。
 * 视觉/布局按设计稿;数据全部接真实 IPC(window.gc),无模拟数据。
 *
 * 核心是「执行单元」= 一个闲鱼账号 + 它当前的执行端。账号是主体,类型(真机/浏览器)
 * 只是执行端的一个属性,所以两类共一张表——手机坏了换一台,账号不变。
 * 数据源:
 *  - 执行单元:getUnits(服务端 /gc/units 聚合:账号 + 设备 + 今日配额 + 在跑任务)
 *  - 链路实况:getState() + onState(本机 adb)、adsStatus(本机 gc-ads 环境)
 *  - 任务中心:getTasks 10s 轮询 + retryTask
 *  - 告警与日志:onLog
 *  - 本机资源/核心服务:hostMetrics
 */

const XY_LOCKED = "7.25.80"; // 闲鱼锁定版本(与 main.js XY_LOCKED_VERSION 一致)
const PKG_GC = "com.erp.groupcontrol";
const PKG_XY = "com.taobao.idlefish";
// 前台包名 → 友好名(设备表「前台 App」列)
const FG_NAMES = { [PKG_XY]: "闲鱼", [PKG_GC]: "群控助手" };

const $ = (s) => document.querySelector(s);
const toastEl = $("#toast");

/* ================= 工具 ================= */
// 设备/服务器回传文本(nick/error/progress 等)进 innerHTML 前一律转义,防注入
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastEl._h);
  toastEl._h = setTimeout(() => toastEl.classList.remove("show"), 2200);
}
// progress 字段是字符串:能解析出百分数(如 "62%"/"62")才返回数值画进度条,否则 null(只显示文本,不造假)
function parsePct(p) {
  if (p == null || p === "") return null;
  const s = String(p).trim();
  const m = s.match(/(\d+(?:\.\d+)?)\s*%/);
  if (m) return Math.min(100, Math.max(0, parseFloat(m[1])));
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const v = parseFloat(s);
    if (v >= 0 && v <= 100) return v;
  }
  return null;
}
function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ================= 状态 ================= */
let latestState = null;      // 最近一次 onState 推送
const screenOpen = new Set(); // 投屏中的设备(以 state.scrcpyOpen 为准)
let taskItems = [];           // 最近一次 getTasks 的 items(当前页,已按时间倒序)
let latestAppUpdate = null, latestXianyu = null, latestCodeUpdate = null;

/* ================= 主题切换(body.light + localStorage 记忆,默认深色) ================= */
function applyTheme(light) {
  document.body.classList.toggle("light", light);
  $("#btn-theme").textContent = light ? "◑ 深色" : "◐ 浅色";
}
applyTheme(localStorage.getItem("gk-theme") !== "dark");   // 默认亮色(设计稿主形态),已选深色的用户保持深色
$("#btn-theme").addEventListener("click", () => {
  const toLight = !document.body.classList.contains("light");
  localStorage.setItem("gk-theme", toLight ? "light" : "dark");
  applyTheme(toLight);
});

/* ================= rail 页面切换(纯前端显隐) ================= */
function gotoPage(name) {
  document.querySelectorAll(".rail-btn").forEach((x) => x.classList.toggle("active", x.dataset.page === name));
  document.querySelectorAll(".page").forEach((p) => p.classList.toggle("show", p.id === "page-" + name));
  if (name === "overview") renderOverview();
  if (name === "packages") loadAds();   // gc-ads 探测较重,切到装机页才拉
}
document.querySelectorAll(".rail-btn").forEach((b) =>
  b.addEventListener("click", () => gotoPage(b.dataset.page)));

/* ================= 本机 adb 设备的健康判定 ================= */
// 只用于任务页「投屏」这类按 serial 找机器的场景;执行单元的判定见 unitState()
function devState(d) {
  if (d.state !== "device") return { cls: "r", attn: "bad" };
  if (d.appInstalled === false) return { cls: "r", attn: "bad" };
  if (d.account && d.account.status && d.account.status !== "ACTIVE") return { cls: "r", attn: "bad" };
  if ((d.permMissing || []).length) return { cls: "r", attn: "bad" };
  if (d.xyVer && d.xyVer !== XY_LOCKED) return { cls: "r", attn: "bad" };
  if (!d.gcService) return { cls: "y", attn: "warn" };
  return { cls: "g", attn: null };
}

/* ================= 任务按设备归组 ================= */
// state 设备按 serial 标识,任务按服务端 device_id/device_name;
// 二者只能靠 device_name 对上昵称或 serial,对不上就只进任务页,不落到设备行
function tasksOf(dev) {
  const keys = [dev.serial, dev.nick].filter(Boolean);
  const hit = { active: null, pending: 0 };
  for (const t of taskItems) {
    const name = t.device_name || "";
    if (!keys.some((k) => name === k || (k && name.includes(k)))) continue;
    if (t.status === "RUNNING" || t.status === "DISPATCHED") {
      if (!hit.active) hit.active = t; // items 已按时间倒序,第一条即最新
    } else if (t.status === "PENDING") {
      hit.pending++;
    }
  }
  return hit;
}
// 任务 → serial(给任务页「投屏」按钮用;对不上返回 "")
function serialOfTask(t) {
  const devices = (latestState && latestState.devices) || [];
  const name = t.device_name || "";
  const d = devices.find((x) => x.serial === name || (x.nick && (x.nick === name || name.includes(x.nick))) || (name && name.includes(x.serial)));
  return d ? d.serial : "";
}
const devLabel = (t) => t.device_name || (t.device_id != null ? `#${t.device_id}` : "-");
// 任务落在哪台执行端上——设计稿把「真机」「浏览器」并成一列,类型只用图标区分
function execTagHtml(label) {
  const u = units.find((x) => x.nick && (x.nick === label || label.includes(x.nick)));
  const k = u ? kindOf(u) : "none";
  if (k === "none") return escapeHtml(label);
  return `<span class="inline-exec ${k === "browser" ? "b" : "p"}">${k === "browser" ? SVG_BROWSER : SVG_PHONE}${escapeHtml(label)}</span>`;
}

/* ==================================================================
   执行单元:账号为主体,真机与浏览器共表
   服务端 /gc/units 给出「账号 + 它当前的执行端 + 今日配额 + 在跑任务」;
   本地 adb(state.devices)和 gc-ads(adsRows)只补链路实况——
   谁绑谁的权威在服务端,本地只知道插了哪几根线、开了哪几个环境。
   ================================================================== */
let units = [];              // /gc/units 原样
let unitsErr = "";           // 拉取失败时的提示(界面标「数据可能过期」)
let cardFilter = "all";      // 总览卡片筛选
let tblFilter = "all";       // 表筛选
let riskFilter = "";
let searchKey = "";
const selected = new Set();  // 选中的 account_id
let drawerOf = null;         // 抽屉当前展示的 account_id
let drawerTab = "base";

const SVG_PHONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="7" y="2.6" width="10" height="18.8" rx="2.4"/><path d="M10.6 18.6h2.8"/></svg>';
const SVG_BROWSER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2.6" y="4.6" width="18.8" height="14.8" rx="2.2"/><path d="M2.6 9.2h18.8"/></svg>';

const kindOf = (u) => (u.device ? (u.device.kind === "browser" ? "browser" : "phone") : "none");
const kindLabel = (k) => (k === "browser" ? "浏览器" : k === "phone" ? "真机" : "未绑定");

// 本地实况:真机按 serial 对上 adb 扫到的那台,浏览器按环境 id 对上 gc-ads 那行。
// 对不上不是错——机器没插在这台电脑上,或者环境没配进本机 config.yaml。
function localOf(u) {
  const k = kindOf(u);
  if (k === "phone") {
    const devices = (latestState && latestState.devices) || [];
    const sn = u.device.serial;
    return devices.find((d) => sn && d.serial === sn)
        || devices.find((d) => d.nick && d.nick === u.nick)
        || null;
  }
  if (k === "browser") {
    const name = u.device.name || "";
    return adsRows.find((r) => r.user_id && (r.user_id === name || name.includes(r.user_id))) || null;
  }
  return null;
}

// 单元健康度。红=需立刻处理,黄=能跑但不对劲,灰=没绑执行端,绿=正常。
function unitState(u) {
  const k = kindOf(u);
  if (u.status !== "ACTIVE" || u.risk_state === "FROZEN") return { cls: "bad", attn: "bad", text: "账号风控" };
  if (k === "none") return { cls: "", attn: null, text: "未绑执行端" };
  const loc = localOf(u);
  if (k === "phone") {
    if (!loc) return { cls: "", attn: null, text: u.device.status === "ONLINE" ? "在线(不在本机)" : "离线" };
    if (loc.state !== "device") return { cls: "bad", attn: "bad", text: "ADB 掉线" };
    if (loc.appInstalled === false) return { cls: "bad", attn: "bad", text: "未装群控 App" };
    if ((loc.permMissing || []).length) return { cls: "bad", attn: "bad", text: "权限缺失" };
    if (loc.xyVer && loc.xyVer !== XY_LOCKED) return { cls: "bad", attn: "bad", text: "闲鱼版本不符" };
    if (!loc.gcService) return { cls: "warn", attn: "warn", text: "服务未运行" };
  } else {
    if (!loc) return { cls: "", attn: null, text: u.device.status === "ONLINE" ? "在线(不在本机)" : "离线" };
    const exec = String(loc.executor || "");
    if (loc.browser !== "运行中") return { cls: "warn", attn: "warn", text: "浏览器未启动" };
    if (!/^运行中/.test(exec)) return { cls: "warn", attn: "warn", text: "executor 已停止" };
  }
  if (u.risk_state === "WARN") return { cls: "warn", attn: "warn", text: "风控预警" };
  if (u.task) return { cls: "run", attn: null, text: u.task.task_type };
  return { cls: "ok", attn: null, text: "空闲" };
}
const isOnline = (u) => { const st = unitState(u); return st.attn === null && kindOf(u) !== "none" && st.text !== "离线"; };

/* ---- 链路状态:多态列。同一列,真机填 ADB/权限/版本,浏览器填浏览器/executor/环境 ---- */
function sigsHtml(u) {
  const k = kindOf(u);
  const loc = localOf(u);
  const sig = (cls, text, val) =>
    `<span class="sig${cls ? " " + cls : ""}"><i></i>${escapeHtml(text)}${val ? `<span class="v">${escapeHtml(val)}</span>` : ""}</span>`;
  if (k === "none") return `<span class="sig m"><i></i>未绑执行端</span>`;
  if (!loc) {
    // 服务端说它在,但不在这台电脑上——这台机/环境归别的节点管
    const on = u.device.status === "ONLINE";
    return sig(on ? "m" : "e", on ? "由其它节点托管" : "服务端判定离线")
         + (u.device.blocking ? sig("w", u.device.blocking) : "");
  }
  const out = [];
  if (k === "phone") {
    out.push(loc.state === "device" ? sig("", "ADB 已连接") : sig("e", "ADB 掉线"));
    const miss = loc.permMissing || [];
    out.push(miss.length ? sig("w", `缺 ${miss.length} 项`, miss[0]) : sig("", "权限正常"));
    out.push(loc.gcService ? sig("", "群控服务在跑") : sig("w", "服务未运行"));
    if (loc.xyVer) out.push(loc.xyVer === XY_LOCKED ? sig("", "闲鱼", loc.xyVer) : sig("e", "闲鱼须降级", loc.xyVer));
  } else {
    out.push(loc.browser === "运行中" ? sig("", "浏览器已开") : sig("w", "浏览器未启动"));
    const exec = String(loc.executor || "已停止");
    out.push(/^运行中/.test(exec) ? sig("", "executor", exec.replace(/^运行中\s*/, "") || "运行中") : sig("w", "executor 已停止"));
    out.push(sig("m", "环境", loc.user_id || u.device.name));
  }
  return `<span class="sigs">${out.join("")}</span>`;
}

/* ---- 今日配额:发布额度最吃紧,列里只画它,其余两类进抽屉 ---- */
function quotaHtml(u, forCard) {
  const q = (u.quota && u.quota.publish) || null;
  if (!q || !q.limit) return `<span class="${forCard ? "q-none" : "cell-dim"}">发布不限量</span>`;
  const pct = Math.min(100, Math.round((q.used / q.limit) * 100));
  const cls = pct >= 100 ? "full" : kindOf(u) === "browser" ? "b" : "";
  return `<span class="qcell"><span class="qt"><span>发布</span><b>${q.used}/${q.limit}</b></span>
    <span class="meter"><i class="${cls}" style="width:${pct}%"></i></span></span>`;
}

function taskStHtml(u) {
  const st = unitState(u);
  if (u.task) {
    const cls = kindOf(u) === "browser" ? "violetc" : "run";
    return `<span class="st ${cls}"><span class="dot run"></span>${escapeHtml(u.task.task_type)}</span>`;
  }
  if (st.attn === "bad") return `<span class="st badc"><span class="dot bad"></span>${escapeHtml(st.text)}</span>`;
  if (st.attn === "warn") return `<span class="st warnc"><span class="dot warn"></span>${escapeHtml(st.text)}</span>`;
  if (st.cls === "ok") return `<span class="st okc"><span class="dot ok"></span>空闲</span>`;
  return `<span class="st queue"><span class="dot"></span>${escapeHtml(st.text)}</span>`;
}

const kindBadge = (k) =>
  k === "browser" ? `<span class="kind k-browser">${SVG_BROWSER}浏览器</span>`
  : k === "phone" ? `<span class="kind k-phone">${SVG_PHONE}真机</span>`
  : `<span class="kind k-none">未绑定</span>`;

/* ---- 筛选 ---- */
function matchFilter(u, f) {
  if (f === "attn") return unitState(u).attn !== null;
  if (f === "phone" || f === "browser") return kindOf(u) === f;
  return true;
}
function visibleUnits(f) {
  const key = searchKey.trim().toLowerCase();
  return units.filter((u) => {
    if (!matchFilter(u, f)) return false;
    if (riskFilter && u.risk_state !== riskFilter) return false;
    if (!key) return true;
    const hay = [u.nick, u.account_id, u.device && u.device.name, u.device && u.device.serial,
                 u.device && u.device.model, u.task && u.task.task_type].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(key);
  });
}

/* ---- KPI ---- */
function renderUnitKpis() {
  const total = units.length;
  const phones = units.filter((u) => kindOf(u) === "phone");
  const browsers = units.filter((u) => kindOf(u) === "browser");
  const onP = phones.filter(isOnline).length, onB = browsers.filter(isOnline).length;
  const online = onP + onB;
  const attn = units.filter((u) => unitState(u).attn !== null);
  const devAttn = attn.filter((u) => u.status === "ACTIVE" && u.risk_state !== "FROZEN").length;

  $("#u-total").textContent = total;
  $("#u-total-sub").textContent = units.filter((u) => kindOf(u) === "none").length
    ? `${units.filter((u) => kindOf(u) === "none").length} 个未绑执行端` : "";
  const pp = total ? (phones.length / total) * 100 : 0;
  const bp = total ? (browsers.length / total) * 100 : 0;
  $("#u-stack").innerHTML = `<i class="sp" style="width:${pp}%"></i><i class="sb" style="width:${bp}%"></i><i class="so" style="width:${100 - pp - bp}%"></i>`;
  $("#u-legend").innerHTML =
    `<span><i class="lp"></i>真机 <b>${phones.length}</b></span><span><i class="lb"></i>浏览器 <b>${browsers.length}</b></span>` +
    (total - phones.length - browsers.length ? `<span><i class="lo"></i>未绑定 <b>${total - phones.length - browsers.length}</b></span>` : "");

  $("#u-online").textContent = online;
  $("#u-online-rate").textContent = total ? `在线率 ${Math.round((online / total) * 100)}%` : "";
  $("#u-online-note").textContent = `真机 ${onP} / ${phones.length} · 浏览器 ${onB} / ${browsers.length}`;

  $("#u-attn").textContent = attn.length;
  $("#u-attn-note").textContent = `执行端告警 ${devAttn} · 账号风控 ${attn.length - devAttn}`;

  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  $("#u-h-p").textContent = `${onP} / ${phones.length}`;
  $("#u-h-p-bar").style.width = pct(onP, phones.length) + "%";
  $("#u-h-b").textContent = `${onB} / ${browsers.length}`;
  $("#u-h-b-bar").style.width = pct(onB, browsers.length) + "%";

  let used = 0, cap = 0;
  for (const u of units) for (const q of Object.values(u.quota || {})) { used += q.used || 0; cap += q.limit || 0; }
  $("#u-quota-used").textContent = used;
  $("#u-quota-total").textContent = cap ? `/ ${cap} 单` : "";
  $("#u-quota-pct").textContent = cap ? pct(used, cap) + "%" : "—";
  $("#u-quota-bar").style.width = pct(used, cap) + "%";

  // chips 计数(两页共用同一套口径)
  const counts = { all: total, phone: phones.length, browser: browsers.length, attn: attn.length };
  document.querySelectorAll("#u-chips .chip-btn, #ov-chips .chip-btn").forEach((c) => {
    const f = c.dataset.tblfilter || c.dataset.cardfilter;
    const n = c.querySelector(".n");
    if (n) n.textContent = counts[f] != null ? counts[f] : 0;
  });
  const badge = $("#units-badge");
  badge.textContent = String(attn.length);
  badge.style.display = attn.length ? "flex" : "none";
}

/* ---- 执行单元表 ---- */
function renderUnitRows() {
  const tb = $("#u-rows");
  const list = visibleUnits(tblFilter);
  $("#u-count").textContent = list.length;
  $("#u-stale").textContent = unitsErr ? `  ·  数据可能过期(${unitsErr})` : "";
  if (!list.length) {
    tb.innerHTML = `<tr><td colspan="9"><div class="empty-hint">${units.length ? "没有符合条件的执行单元" : "还没有执行单元 — 账号在执行端登录闲鱼后会自动出现"}</div></td></tr>`;
    return;
  }
  tb.innerHTML = "";
  for (const u of list) {
    const k = kindOf(u);
    const st = unitState(u);
    const loc = localOf(u);
    const tr = document.createElement("tr");
    tr.dataset.acct = u.account_id;
    if (st.attn === "bad") tr.className = "attn-bad";
    else if (st.attn === "warn") tr.className = "attn-warn";
    if (selected.has(u.account_id)) tr.classList.add("sel-row");
    const dev = u.device;
    const execLine2 = k === "phone"
      ? [dev.brand, dev.model].filter(Boolean).join(" ") || dev.serial || ""
      : (dev && dev.name) || "";
    tr.innerHTML = `
      <td><span class="ck${selected.has(u.account_id) ? " on" : ""}"></span></td>
      <td><span class="acct-cell"><span class="an">${escapeHtml(u.nick)}</span><span class="ai">${escapeHtml(u.account_id.slice(0, 8))}</span></span></td>
      <td>${kindBadge(k)}</td>
      <td>${dev ? `<span class="exec-cell"><span class="en">${escapeHtml(dev.name)}</span><span class="em">${escapeHtml(execLine2)}</span></span>` : `<span class="cell-dim">—</span>`}</td>
      <td>${sigsHtml(u)}</td>
      <td>${quotaHtml(u, false)}</td>
      <td>${taskStHtml(u)}</td>
      <td class="cell-mono">${escapeHtml(fmtTime(dev && (dev.last_report_at || dev.last_online_at)) || "—")}</td>
      <td style="text-align:right"><button class="row-act" title="详情">⋯</button></td>`;
    tr.querySelector(".ck").addEventListener("click", (e) => {
      e.stopPropagation();
      if (selected.has(u.account_id)) selected.delete(u.account_id); else selected.add(u.account_id);
      renderUnitRows(); renderSelBar();
    });
    tr.addEventListener("click", () => openDrawer(u.account_id));
    if (loc && k === "phone") tr.title = `本机 ADB:${loc.serial}`;
    tb.appendChild(tr);
  }
}

/* ---- 批量操作条:混选两类时只留两类都支持的动作 ---- */
function renderSelBar() {
  const picked = units.filter((u) => selected.has(u.account_id));
  const kinds = new Set(picked.map(kindOf));
  const mixed = kinds.size > 1;
  $("#u-sel-n").textContent = picked.length;
  $("#u-sel-kind").textContent = !picked.length ? "" : mixed ? " · 真机与浏览器混选" : ` · 全为${kindLabel([...kinds][0])}`;
  $("#u-scope-hint").hidden = !mixed;
  $("#u-ck-all").classList.toggle("on", picked.length > 0 && picked.length === visibleUnits(tblFilter).length);
  const onlyPhone = picked.length > 0 && kinds.size === 1 && kinds.has("phone");
  const onlyBrowser = picked.length > 0 && kinds.size === 1 && kinds.has("browser");
  $("#u-act-screen").hidden = !onlyPhone;
  $("#u-act-init").hidden = !onlyPhone;
  $("#u-act-start").hidden = !onlyBrowser;
  $("#u-act-stop").hidden = !onlyBrowser;
}

/* ---- 总览卡片 ---- */
function renderUnitCards() {
  const grid = $("#ov-grid");
  const list = visibleUnits(cardFilter);
  $("#ov-card-cnt").textContent = list.length;
  if (!list.length) {
    grid.innerHTML = `<div class="empty-hint">${units.length ? "没有符合条件的执行单元" : "还没有执行单元"}</div>`;
    return;
  }
  grid.innerHTML = "";
  for (const u of list.slice(0, 24)) {
    const k = kindOf(u), st = unitState(u), loc = localOf(u), dev = u.device;
    const card = document.createElement("article");
    card.className = "unit" + (st.attn === "bad" ? " is-down" : st.attn === "warn" ? " is-attn" : "") + (k === "none" ? " is-free" : "");
    const facts = [];
    if (k === "phone") {
      facts.push(["机型", escapeHtml([dev.brand, dev.model].filter(Boolean).join(" ") || "—"), ""]);
      facts.push(["闲鱼", escapeHtml(loc && loc.xyVer ? loc.xyVer : dev.app_version || "—"),
                  loc && loc.xyVer && loc.xyVer !== XY_LOCKED ? "bad" : ""]);
      facts.push(["权限", loc ? (loc.permMissing || []).length ? `缺 ${loc.permMissing.length} 项` : "正常" : "—",
                  loc && (loc.permMissing || []).length ? "warn" : loc ? "good" : ""]);
    } else if (k === "browser") {
      facts.push(["环境", escapeHtml(loc ? loc.user_id : dev.name), ""]);
      facts.push(["浏览器", loc ? (loc.browser === "运行中" ? "已启动" : "未启动") : "—",
                  loc && loc.browser === "运行中" ? "good" : loc ? "warn" : ""]);
      facts.push(["执行端", escapeHtml(loc ? String(loc.executor || "已停止") : "—"),
                  loc && /^运行中/.test(String(loc.executor || "")) ? "good" : loc ? "warn" : ""]);
    }
    facts.push(["心跳", escapeHtml(fmtTime(dev && (dev.last_report_at || dev.last_online_at)) || "—"), ""]);
    card.innerHTML = `
      <div class="u-top">
        <div class="u-name"><h4${k === "none" ? ' class="none"' : ""}>${escapeHtml(u.nick)}</h4><span class="aid">${escapeHtml(u.account_id.slice(0, 8))}</span></div>
        ${kindBadge(k)}
      </div>
      <div class="u-state">
        <span class="dot ${st.cls}"></span><span class="s1">${escapeHtml(st.text)}</span>
        ${u.risk_state && u.risk_state !== "NORMAL" ? `<span class="risk ${u.risk_state === "FROZEN" ? "banned" : "frozen"}">${u.risk_state === "FROZEN" ? "冻结" : "预警"}</span>` : ""}
      </div>
      ${dev ? `<div class="u-exec">${k === "browser" ? SVG_BROWSER : SVG_PHONE}<span class="en">${escapeHtml(dev.name)}</span><span class="eid">${escapeHtml(dev.serial || dev.id.slice(0, 6))}</span></div>` : ""}
      <div class="u-facts">${facts.map(([d, v, c]) => `<div><dt>${d}</dt><dd${c ? ` class="${c}"` : ""}>${v}</dd></div>`).join("")}</div>
      <div class="u-quota">${quotaHtml(u, true)}</div>`;
    card.addEventListener("click", () => { gotoPage("units"); openDrawer(u.account_id); });
    grid.appendChild(card);
  }
  if (list.length > 24) {
    const more = document.createElement("div");
    more.className = "empty-hint";
    more.style.gridColumn = "1/-1";
    more.textContent = `另有 ${list.length - 24} 个执行单元 — 到「执行单元」页看全部`;
    grid.appendChild(more);
  }
}

/* ---- 抽屉:tab 随类型变(真机看权限/日志,浏览器看环境/executor) ---- */
function openDrawer(acctId) {
  drawerOf = acctId;
  if (!units.some((u) => u.account_id === acctId)) { closeDrawer(); return; }
  drawerTab = "base";
  renderDrawer();
}
function closeDrawer() { drawerOf = null; $("#u-drawer").hidden = true; renderUnitRows(); }

function renderDrawer() {
  const dw = $("#u-drawer");
  const u = units.find((x) => x.account_id === drawerOf);
  if (!u) { dw.hidden = true; return; }
  dw.hidden = false;
  const k = kindOf(u), loc = localOf(u), dev = u.device;
  $("#dw-title").textContent = u.nick;
  $("#dw-sub").textContent = u.account_id;
  const tabs = k === "browser"
    ? [["base", "概况"], ["env", "环境"], ["quota", "配额"]]
    : k === "phone" ? [["base", "概况"], ["perm", "权限"], ["quota", "配额"]]
    : [["base", "概况"], ["quota", "配额"]];
  $("#dw-tabs").innerHTML = tabs.map(([id, t]) =>
    `<button class="dw-tab${drawerTab === id ? " on" + (k === "browser" ? " v" : "") : ""}" data-tab="${id}">${t}</button>`).join("");
  $("#dw-tabs").querySelectorAll(".dw-tab").forEach((b) =>
    b.addEventListener("click", () => { drawerTab = b.dataset.tab; renderDrawer(); }));

  const kv = (rows) => `<div class="dw-kv">${rows.map(([d, v, c]) =>
    `<div><dt>${d}</dt><dd${c ? ` class="${c}"` : ""}>${v}</dd></div>`).join("")}</div>`;
  let body = "";
  if (drawerTab === "base") {
    const st = unitState(u);
    body += kv([
      ["状态", escapeHtml(st.text), st.attn === "bad" ? "bad" : st.attn === "warn" ? "warn" : "good"],
      ["类型", kindLabel(k), ""],
      ["执行端", dev ? escapeHtml(dev.name) : "未绑定", ""],
      ["作息窗口", escapeHtml(u.active_window || "—"), ""],
      ["最后操作", escapeHtml(fmtTime(u.last_op_at) || "—"), ""],
      ["最后心跳", escapeHtml(fmtTime(dev && (dev.last_report_at || dev.last_online_at)) || "—"), ""],
    ]);
    if (u.risk_state !== "NORMAL" || u.status !== "ACTIVE") {
      body += `<div class="banner ${u.risk_state === "FROZEN" ? "e" : "w"}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8v5M12 16v.5"/><circle cx="12" cy="12" r="9"/></svg>
        <span><b>${u.status !== "ACTIVE" ? escapeHtml(u.status) : escapeHtml(u.risk_state)}</b>　${escapeHtml(u.risk_note || "账号被风控,任务不会派发到这个单元")}</span></div>`;
    }
    if (dev && dev.blocking) {
      body += `<div class="banner w"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8v5M12 16v.5"/><circle cx="12" cy="12" r="9"/></svg><span>${escapeHtml(dev.blocking)}</span></div>`;
    }
    body += `<div class="dw-sec">快捷操作</div><div class="qa" id="dw-qa"></div>`;
  } else if (drawerTab === "perm") {
    if (!loc) body += `<div class="q-none">这台机不在本电脑的 ADB 列表里,权限明细读不到。</div>`;
    else {
      const miss = loc.permMissing || [];
      body += kv([
        ["序列号", `<span class="mono">${escapeHtml(loc.serial)}</span>`, "mono"],
        ["ADB", loc.state === "device" ? "已连接" : escapeHtml(loc.state), loc.state === "device" ? "good" : "bad"],
        ["群控 App", loc.appInstalled === false ? "未安装" : "已安装", loc.appInstalled === false ? "bad" : "good"],
        ["群控服务", loc.gcService ? "运行中" : "未运行", loc.gcService ? "good" : "warn"],
        ["闲鱼版本", escapeHtml(loc.xyVer || "—"), loc.xyVer && loc.xyVer !== XY_LOCKED ? "bad" : "good"],
        ["前台 App", escapeHtml(FG_NAMES[loc.foreground] || loc.foreground || "—"), ""],
      ]);
      body += `<div class="dw-sec">权限</div>` + (miss.length
        ? `<div class="banner w"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8v5M12 16v.5"/><circle cx="12" cy="12" r="9"/></svg><span>缺 <b>${miss.length}</b> 项:${escapeHtml(miss.join("、"))}</span></div>`
        : `<div class="q-none">全部就绪 ✓</div>`);
    }
  } else if (drawerTab === "env") {
    if (!loc) body += `<div class="q-none">这个环境没配进本机 gc-ads 的 config.yaml,状态读不到。</div>`;
    else body += kv([
      ["环境 ID", `<span class="mono">${escapeHtml(loc.user_id)}</span>`, "mono"],
      ["备注", escapeHtml(loc.name || "—"), ""],
      ["浏览器", loc.browser === "运行中" ? "已启动" : "未启动", loc.browser === "运行中" ? "good" : "warn"],
      ["executor", escapeHtml(String(loc.executor || "已停止")), /^运行中/.test(String(loc.executor || "")) ? "good" : "warn"],
      ["就绪", dev && dev.last_ready ? "已就绪" : "未就绪", dev && dev.last_ready ? "good" : "warn"],
    ]);
  } else if (drawerTab === "quota") {
    const NAMES = { publish: "发布", reprice: "改价", delist: "下架" };
    const q = u.quota || {};
    body += Object.keys(NAMES).map((cat) => {
      const it = q[cat] || { used: 0, limit: 0 };
      if (!it.limit) return `<div><div class="q-head"><span>${NAMES[cat]}</span><b>${it.used} / 不限</b></div></div>`;
      const pct = Math.min(100, Math.round((it.used / it.limit) * 100));
      return `<div><div class="q-head"><span>${NAMES[cat]}</span><b>${it.used} / ${it.limit}</b></div>
        <div class="meter"><i class="${pct >= 100 ? "full" : ""}" style="width:${pct}%"></i></div></div>`;
    }).join("");
    body += `<div class="q-none">配额按北京时间日界重置,只统计已成功的任务——与派发闸是同一个数。</div>`;
  }
  $("#dw-body").innerHTML = body;
  if (drawerTab === "base") renderDrawerActions(u);
  renderUnitRows();
}

// 抽屉快捷操作:动作按类型给,给不了的直接不画(不摆一个点不动的灰按钮)
function renderDrawerActions(u) {
  const box = $("#dw-qa");
  if (!box) return;
  const k = kindOf(u), loc = localOf(u);
  const acts = [];
  if (k === "phone" && loc) {
    const open = screenOpen.has(loc.serial);
    acts.push([open ? "关投屏" : "投屏", "primary", () => (open ? window.gc.closeScreen(loc.serial) : window.gc.openScreen(loc.serial))]);
    acts.push(["初始化", "", async () => { await window.gc.initDevice(loc.serial); toast(`${loc.serial} 初始化完成`); }]);
    acts.push(["拉活", "", async () => { await window.gc.revive(loc.serial); toast("已尝试拉活"); }]);
  } else if (k === "browser" && loc) {
    acts.push(["启动", "violet", async () => { const r = await window.gc.adsStart([loc.user_id]); toast(r && r.ok ? "已启动" : `启动失败: ${(r && r.error) || "未知"}`); await loadAdsStatus(); renderUnits(); }]);
    acts.push(["停止", "", async () => { const r = await window.gc.adsStop([loc.user_id], false); toast(r && r.ok ? "已停止" : `停止失败: ${(r && r.error) || "未知"}`); await loadAdsStatus(); renderUnits(); }]);
    acts.push(["日志", "", async () => { const r = await window.gc.adsTailLog(loc.user_id); gotoPage("packages"); showAdsPre(`${loc.user_id} 日志`, (r && r.out) || "(空)"); }]);
  }
  // 解冻改的是服务端记录,执行端在不在本机都能解
  if (u.status !== "ACTIVE" || u.risk_state === "FROZEN") {
    acts.push(["解冻", "", async () => { const r = await window.gc.unfreezeAccount(u.account_id, u.nick); toast(r && r.ok ? "账号已解冻" : `解冻失败: ${(r && r.error) || "未知"}`); await loadUnits(true); }]);
  }
  if (!acts.length) { box.innerHTML = `<div class="q-none" style="grid-column:1/-1">这个单元的执行端不在本机,操作不了。</div>`; return; }
  box.innerHTML = "";
  for (const [text, cls, fn] of acts) {
    const b = document.createElement("button");
    b.className = cls;
    b.textContent = text;
    b.addEventListener("click", async () => { b.disabled = true; try { await fn(); } finally { b.disabled = false; } });
    box.appendChild(b);
  }
}

function renderUnits() {
  renderUnitKpis();
  renderUnitRows();
  renderSelBar();
  renderUnitCards();
  if (drawerOf) renderDrawer();
  renderStatusbar();
}

async function loadUnits(force) {
  const r = await window.gc.getUnits(!!force);
  units = (r && r.units) || [];
  unitsErr = r && r.ok === false ? r.error || "拉取失败" : "";
  if (unitsErr && !units.length) {
    addError({ ts: new Date().toLocaleTimeString(), msg: `执行单元拉取失败: ${unitsErr}`, level: "error" });
  }
  // 选中项跟着数据走,账号没了就别留在选中集里
  for (const id of [...selected]) if (!units.some((u) => u.account_id === id)) selected.delete(id);
  if (drawerOf && !units.some((u) => u.account_id === drawerOf)) closeDrawer();
  renderUnits();
  // 任务行的执行端类型徽标要查 units;任务先到、单元后到时得补画一次
  if (taskItems.length) renderQueue();
}

/* ---- 交互绑定 ---- */
document.querySelectorAll("#u-chips .chip-btn").forEach((c) =>
  c.addEventListener("click", () => {
    tblFilter = c.dataset.tblfilter;
    document.querySelectorAll("#u-chips .chip-btn").forEach((x) => x.setAttribute("aria-pressed", String(x === c)));
    renderUnitRows(); renderSelBar();
  }));
document.querySelectorAll("#ov-chips .chip-btn").forEach((c) =>
  c.addEventListener("click", () => {
    cardFilter = c.dataset.cardfilter;
    document.querySelectorAll("#ov-chips .chip-btn").forEach((x) => x.setAttribute("aria-pressed", String(x === c)));
    renderUnitCards();
  }));
$("#u-search").addEventListener("input", (e) => { searchKey = e.target.value; renderUnitRows(); renderUnitCards(); });
$("#u-risk").addEventListener("change", (e) => { riskFilter = e.target.value; renderUnitRows(); renderUnitCards(); });
$("#dw-close").addEventListener("click", closeDrawer);
$("#ov-goto-units").addEventListener("click", () => gotoPage("units"));
$("#u-ck-all").addEventListener("click", () => {
  const list = visibleUnits(tblFilter);
  const allOn = list.length > 0 && list.every((u) => selected.has(u.account_id));
  for (const u of list) if (allOn) selected.delete(u.account_id); else selected.add(u.account_id);
  renderUnitRows(); renderSelBar();
});
$("#u-refresh").addEventListener("click", async (e) => {
  const b = e.currentTarget;
  b.disabled = true; b.textContent = "刷新中…";
  try { await window.gc.refreshDevices(); await loadAdsStatus(); await loadUnits(true); }
  finally { b.textContent = "刷新"; b.disabled = false; }
});
// Ctrl/Cmd+K 落到搜索框(设计稿标了这个键位,标了就得能用)
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault(); gotoPage("units"); $("#u-search").focus(); $("#u-search").select();
  }
});

// 批量操作:逐个串行执行,一个失败不影响其余,结束报一次总数
function bindBulk(id, busyText, pick, fn) {
  $(id).addEventListener("click", async (e) => {
    const b = e.currentTarget, old = b.textContent;
    const targets = units.filter((u) => selected.has(u.account_id)).map(pick).filter(Boolean);
    if (!targets.length) return toast("选中的单元里没有本机能操作的执行端");
    b.disabled = true; b.textContent = busyText;
    let ok = 0;
    for (const t of targets) { try { await fn(t); ok++; } catch (_) { /* 单个失败继续 */ } }
    b.textContent = old; b.disabled = false;
    toast(`${old}:成功 ${ok} / ${targets.length}`);
    await loadAdsStatus(); await loadUnits(true);
  });
}
const phoneSerial = (u) => { const l = localOf(u); return l && l.serial ? l.serial : null; };
const browserUid = (u) => { const l = localOf(u); return l && l.user_id ? l.user_id : null; };
bindBulk("#u-act-screen", "投屏中…", phoneSerial, (sn) => window.gc.openScreen(sn));
bindBulk("#u-act-init", "初始化…", phoneSerial, (sn) => window.gc.initDevice(sn));
bindBulk("#u-act-start", "启动中…", browserUid, (uid) => window.gc.adsStart([uid]));
bindBulk("#u-act-stop", "停止中…", browserUid, (uid) => window.gc.adsStop([uid], false));

/* ================= 总览页:本机指标 + 核心服务 ================= */
let lastSync = "";

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `已运行 ${d} 天 ${h} 小时` : h ? `已运行 ${h} 小时 ${m} 分` : `已运行 ${m} 分`;
}

async function renderOverview() {
  const m = await window.gc.hostMetrics();
  $("#ov-node").textContent = `执行节点 ${m.host || "本机"}`;
  $("#ov-meta").innerHTML =
    `<span class="mono">${escapeHtml(m.ip || "无网卡")}</span><span class="bar"></span>` +
    `<span>${escapeHtml(m.os)}</span><span class="bar"></span><span>${fmtUptime(m.uptimeSec)}</span>`;
  if (m.cpu != null) { $("#ov-cpu").textContent = m.cpu + "%"; $("#ov-cpu-bar").style.width = m.cpu + "%"; }
  $("#ov-mem").textContent = m.memPct + "%";
  $("#ov-mem").title = `已用 ${m.memUsedGb}G / 共 ${m.memTotalGb}G`;
  $("#ov-mem-bar").style.width = m.memPct + "%";

  const total = units.length;
  const online = units.filter(isOnline).length;
  const phones = units.filter((u) => kindOf(u) === "phone");
  const browsers = units.filter((u) => kindOf(u) === "browser");
  const onP = phones.filter(isOnline).length, onB = browsers.filter(isOnline).length;
  $("#ov-online").textContent = online;
  $("#ov-online-sub").textContent = total ? `/ ${total} 在线` : "";
  const pp = total ? (onP / total) * 100 : 0, bp = total ? (onB / total) * 100 : 0;
  $("#ov-stack").innerHTML = `<i class="sp" style="width:${pp}%"></i><i class="sb" style="width:${bp}%"></i><i class="so" style="width:${100 - pp - bp}%"></i>`;
  $("#ov-legend").innerHTML = `<span><i class="lp"></i>真机 <b>${onP}</b></span><span><i class="lb"></i>浏览器 <b>${onB}</b></span><span><i class="lo"></i>离线 <b>${total - online}</b></span>`;

  const running = taskItems.filter((t) => t.status === "RUNNING" || t.status === "DISPATCHED").length;
  const pending = taskItems.filter((t) => t.status === "PENDING").length;
  $("#ov-running").textContent = running;
  $("#ov-task-note").textContent = `本页任务 ${taskItems.length} · 排队 ${pending}`;

  const attn = units.filter((u) => unitState(u).attn !== null);
  const risky = attn.filter((u) => u.status !== "ACTIVE" || u.risk_state === "FROZEN").length;
  $("#ov-attn").textContent = attn.length;
  $("#ov-attn-note").textContent = `执行端告警 ${attn.length - risky} · 账号风控 ${risky}`;

  const adbOk = !!(latestState && (latestState.devices || []).some((d) => d.state === "device"));
  const adsOk = !!(adsDetectInfo && adsDetectInfo.apiAlive);
  const svrOk = !unitsErr;
  const wdOk = !!adsWatchdogOn;
  $("#ov-svc").innerHTML = [
    ["ADB", adbOk], ["调度中心", svrOk], ["AdsPower API", adsOk], ["看门狗", wdOk],
  ].map(([n, ok]) => `<div class="${ok ? "" : "off"}"><span class="mini-dot"></span>${n}</div>`).join("");
  lastSync = new Date().toLocaleTimeString();
  $("#ov-sync").textContent = "最后同步 " + lastSync;
  const bad = attn.length > 0;
  const pill = $("#ov-pill");
  pill.className = "node-pill" + (bad ? " warn" : "");
  pill.innerHTML = `<span class="mini-dot"></span>${bad ? `${attn.length} 个单元待处理` : "运行正常"}`;
  renderStatusbar();
}

/* ================= 状态栏 ================= */
function renderStatusbar() {
  const set = (id, ok, text) => {
    const el = $(id);
    if (!el) return;
    el.className = "s" + (ok === true ? "" : ok === false ? " bad" : " off");
    el.innerHTML = `<span class="mini-dot"></span>${text}`;
  };
  const devices = (latestState && latestState.devices) || [];
  const adbOn = devices.some((d) => d.state === "device");
  set("#sb-adb", devices.length ? adbOn : null, devices.length ? (adbOn ? `ADB ${devices.filter((d) => d.state === "device").length} 台` : "ADB 无在线设备") : "ADB 未检测到设备");
  set("#sb-ads", adsDetectInfo ? !!adsDetectInfo.apiAlive : null, adsDetectInfo ? (adsDetectInfo.apiAlive ? "AdsPower API 正常" : "AdsPower API 离线") : "AdsPower 未检测");
  set("#sb-server", unitsErr ? false : units.length || !unitsErr ? true : null, unitsErr ? "调度中心不可达" : "调度中心正常");
  set("#sb-wd", adsWatchdogOn === null ? null : !!adsWatchdogOn, adsWatchdogOn ? "看门狗运行中" : "看门狗未运行");
  if (lastSync) $("#sb-sync").textContent = lastSync;
  const attn = units.filter((u) => unitState(u).attn !== null).length;
  const r = $("#sb-right");
  r.className = "right" + (attn ? " warn" : "");
  r.innerHTML = `<span class="mini-dot"></span>${attn ? `${attn} 个单元需要处理` : "节点运行正常"}`;
}

/* ================= 渲染:任务队列页(分区) ================= */
async function loadTasks() {
  const r = await window.gc.getTasks({});
  if (r.error) {
    addError({ ts: new Date().toLocaleTimeString(), msg: `任务队列拉取失败: ${r.error}`, level: "error" });
    $("#q-sections").innerHTML = `<div class="q-empty">加载失败:${escapeHtml(r.error)}(检查网络/服务端)</div>`;
    $("#q-summary").innerHTML = "";
    taskItems = [];
    updateQFailBadge();
    return;
  }
  // 按时间倒序(id 兜底),保证「每设备最新一条」取数正确
  taskItems = (r.items || []).slice().sort((a, b) => {
    const ta = Date.parse(a.created_at || "") || 0;
    const tb = Date.parse(b.created_at || "") || 0;
    return tb - ta || (b.id || 0) - (a.id || 0);
  });
  renderQueue();
  if ($("#page-overview").classList.contains("show")) renderOverview(); // 总览「任务执行中」同源刷新
}

function updateQFailBadge() {
  const n = taskItems.filter((t) => t.status === "FAILED" || t.status === "TIMEOUT").length;
  const b = $("#q-fail-badge");
  b.style.display = n ? "flex" : "none";
  b.textContent = String(n);
}

function renderQueue() {
  const items = taskItems;
  const actives = items.filter((t) => t.status === "RUNNING" || t.status === "DISPATCHED");
  const fails = items.filter((t) => t.status === "FAILED" || t.status === "TIMEOUT");
  const pends = items.filter((t) => t.status === "PENDING");
  const dones = items.filter((t) => t.status === "SUCCESS");

  $("#q-summary").innerHTML = `
    <div class="qs c-run"><div class="n">${actives.length}</div><div class="l">进行中</div></div>
    <div class="qs"><div class="n">${pends.length}</div><div class="l">排队</div></div>
    <div class="qs c-done"><div class="n">${dones.length}</div><div class="l">成功</div></div>
    <div class="qs c-fail"><div class="n">${fails.length}</div><div class="l">失败</div></div>`;
  updateQFailBadge();

  const sec = $("#q-sections");
  sec.innerHTML = "";
  if (!items.length) {
    sec.innerHTML = `<div class="q-empty">任务队列已清空</div>`;
    return;
  }

  /* 进行中 */
  sec.insertAdjacentHTML("beforeend",
    `<div class="q-sec-title">进行中<span class="cnt">${actives.length}</span><span class="line"></span></div>`);
  if (actives.length) {
    const tb = document.createElement("table");
    const body = document.createElement("tbody");
    for (const t of actives) {
      const pct = parsePct(t.progress);
      const text = t.progress != null && String(t.progress) !== "" ? String(t.progress) : "";
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td style="width:26px"></td>
        <td class="dev-id"><div class="line1"><span class="sn">${execTagHtml(devLabel(t))}</span></div><div class="nick cell-dim">#${t.id} · ${escapeHtml(fmtTime(t.created_at))}</div></td>
        <td><span class="q-status running"><span class="dot"></span>${t.status === "DISPATCHED" ? "已下发" : "执行中"}</span></td>
        <td><div class="task-cell"><div class="tname">${escapeHtml(t.task_type || "任务")}</div>
          ${pct != null ? `<div class="pbar wide ${pct >= 100 ? "done" : ""}"><i style="width:${pct}%"></i></div>` : text ? `<div class="cell-dim">${escapeHtml(text)}</div>` : ""}</div></td>
        <td class="cell-mono" style="color:var(--cyan)">${pct != null ? Math.round(pct) + "%" : "—"}</td>
        <td style="text-align:right"><div class="row-acts"></div></td>`;
      const serial = serialOfTask(t);
      if (serial) {
        const b = document.createElement("button");
        b.className = "ra";
        b.textContent = "投屏";
        b.addEventListener("click", () => window.gc.openScreen(serial));
        tr.querySelector(".row-acts").appendChild(b);
      }
      body.appendChild(tr);
    }
    tb.appendChild(body);
    sec.appendChild(tb);
  } else {
    sec.insertAdjacentHTML("beforeend", `<div class="q-empty">当前没有正在执行的任务</div>`);
  }

  /* 失败 / 超时(可重发) */
  sec.insertAdjacentHTML("beforeend",
    `<div class="q-sec-title">失败 / 超时<span class="cnt">${fails.length}</span><span class="line"></span></div>`);
  if (fails.length) {
    const tb = document.createElement("table");
    const body = document.createElement("tbody");
    for (const t of fails) {
      const errText = [t.failed_step, t.error].filter(Boolean).join(": ");
      const tr = document.createElement("tr");
      tr.className = "task-fail-row";
      tr.innerHTML = `
        <td style="width:26px"></td>
        <td class="dev-id"><div class="line1"><span class="sn">${execTagHtml(devLabel(t))}</span></div><div class="nick cell-dim">#${t.id} · ${escapeHtml(fmtTime(t.finished_at || t.created_at))}</div></td>
        <td><span class="q-status failed"><span class="dot"></span>${t.status === "TIMEOUT" ? "超时" : "失败"}</span></td>
        <td><div class="task-cell"><div class="tname task-fail">${escapeHtml(t.task_type || "任务")}</div>
          ${errText ? `<div class="err-line">${escapeHtml(errText)}</div>` : ""}</div></td>
        <td class="cell-mono" style="color:var(--bad)">—</td>
        <td style="text-align:right"><div class="row-acts"></div></td>`;
      const b = document.createElement("button");
      b.className = "ra amber";
      b.textContent = "重发";
      b.title = "按原参数重新创建一条任务(source=MANUAL)";
      b.addEventListener("click", async () => {
        if (!confirm(`确认重发任务 #${t.id}(${t.task_type})?`)) return;
        b.disabled = true;
        b.textContent = "重发中…";
        try {
          const r = await window.gc.retryTask(t.id);
          if (r && r.error) toast(`重发失败: ${r.error}`);
          else {
            toast(`任务 #${t.id} 已重发`);
            await loadTasks();
          }
        } finally {
          b.textContent = "重发";
          b.disabled = false;
        }
      });
      tr.querySelector(".row-acts").appendChild(b);
      body.appendChild(tr);
    }
    tb.appendChild(body);
    sec.appendChild(tb);
  } else {
    sec.insertAdjacentHTML("beforeend", `<div class="q-empty">没有失败任务</div>`);
  }

  /* 排队(按设备归组) */
  const byDev = new Map();
  for (const t of pends) {
    const k = devLabel(t);
    if (!byDev.has(k)) byDev.set(k, []);
    byDev.get(k).push(t);
  }
  sec.insertAdjacentHTML("beforeend",
    `<div class="q-sec-title">排队中<span class="cnt">${byDev.size} 台 / ${pends.length} 项</span><span class="line"></span></div>`);
  if (pends.length) {
    const tb = document.createElement("table");
    const body = document.createElement("tbody");
    for (const [dev, arr] of byDev) {
      const tr = document.createElement("tr");
      const names = arr
        .map((t, k) => `<span style="color:${k === 0 ? "var(--text)" : "var(--text-dim)"}">${escapeHtml(t.task_type || "任务")}</span>`)
        .join(` <span style="color:var(--text-faint)">→</span> `);
      tr.innerHTML = `
        <td style="width:26px"></td>
        <td class="dev-id"><div class="line1"><span class="sn">${execTagHtml(dev)}</span></div></td>
        <td colspan="3" class="cell-dim" style="white-space:normal">${names}</td>
        <td style="text-align:right"><span class="cell-mono" style="color:var(--text-faint)">${arr.length} 项</span></td>`;
      body.appendChild(tr);
    }
    tb.appendChild(body);
    sec.appendChild(tb);
  } else {
    sec.insertAdjacentHTML("beforeend", `<div class="q-empty">没有排队任务</div>`);
  }

  /* 最近完成 */
  sec.insertAdjacentHTML("beforeend",
    `<div class="q-sec-title">最近完成<span class="cnt">${dones.length}</span><span class="line"></span></div>`);
  if (dones.length) {
    const tb = document.createElement("table");
    const body = document.createElement("tbody");
    for (const t of dones.slice(0, 12)) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td style="width:26px"></td>
        <td class="dev-id"><div class="line1"><span class="sn">${execTagHtml(devLabel(t))}</span></div></td>
        <td><span class="q-status done"><span class="dot"></span>已完成</span></td>
        <td class="cell-dim">${escapeHtml(t.task_type || "任务")}</td>
        <td class="cell-mono" style="color:var(--text-faint)">${escapeHtml(fmtTime(t.finished_at || t.created_at))}</td>
        <td></td>`;
      body.appendChild(tr);
    }
    tb.appendChild(body);
    sec.appendChild(tb);
  }
}

/* ================= 渲染:装机包页(三卡) ================= */
function setTag(el, cls, text) {
  el.className = "tag" + (cls ? " " + cls : "");
  el.textContent = text;
}
function showBtn(btn, show) {
  btn.style.display = show ? "" : "none";
}
// dl-prog 只在下载中显示,indeterminate 动画(无真实百分比,不造假)
function setDlProg(sel, busy) {
  $(sel).classList.toggle("busy", !!busy);
}

// rail「装机」badge:有新版/未就绪/待重启的卡片数
function updatePkgBadge() {
  let n = 0;
  if (latestAppUpdate && latestAppUpdate.updateAvailable) n++;
  if (latestXianyu && latestXianyu.locked && !latestXianyu.ready) n++;
  if (latestCodeUpdate && (latestCodeUpdate.updateAvailable || latestCodeUpdate.readyToApply)) n++;
  const b = $("#pkg-badge");
  b.style.display = n ? "flex" : "none";
  b.textContent = String(n);
}

// 群控 App:最新版 vs 装机包 + 一键下载
function renderAppUpdate(u) {
  latestAppUpdate = u || latestAppUpdate;
  const tag = $("#pkg-gp-tag"), meta = $("#pkg-gp-meta"), dl = $("#btn-dl-gp");
  if (!u) { setTag(tag, "", "尚未检查"); meta.innerHTML = "<span>等待检查…</span>"; showBtn(dl, false); updatePkgBadge(); return; }
  if (u.checking) setTag(tag, "warn", "检查中…");
  else if (!u.latest) setTag(tag, "bad", "检查失败");
  else if (u.updateAvailable) setTag(tag, "warn", "有新版");
  else setTag(tag, "ok", "已是最新");
  let html = "<span>等待检查…</span>";
  if (u.latest) {
    html = `<span>服务器 <b class="srv">v${escapeHtml(u.latest.versionName)}</b></span>` +
      (u.downloaded
        ? `<span>本地 <b>v${escapeHtml(u.latest.versionName)}</b>(已下载)</span>`
        : u.bundled
          ? `<span>本地装机包 <b>v${escapeHtml(u.bundled.versionName)}</b></span>`
          : `<span>装机包版本未知</span>`) +
      (u.latest.notes && u.updateAvailable ? `<span>${escapeHtml(u.latest.notes)}</span>` : "");
  } else if (u.error) {
    html = `<span>${escapeHtml(u.error)}</span>`;
  }
  meta.innerHTML = html;
  showBtn(dl, !!(u.latest && u.updateAvailable && !u.checking));
  setDlProg("#gp-prog", dl.disabled);
  updatePkgBadge();
}

// 闲鱼锁定版:锁定版 vs 本地就绪 + 预下载
function renderXianyu(x) {
  latestXianyu = x || latestXianyu;
  const tag = $("#pkg-xy-tag"), meta = $("#pkg-xy-meta"), dl = $("#btn-dl-xy");
  if (!x) { setTag(tag, "", "尚未检查"); meta.innerHTML = "<span>等待检查…</span>"; showBtn(dl, false); updatePkgBadge(); return; }
  if (x.checking) setTag(tag, "warn", "检查中…");
  else if (!x.locked) setTag(tag, "bad", "检查失败");
  else if (x.downloading) setTag(tag, "warn", "下载中");
  else if (x.ready) setTag(tag, "ok", "已就绪");
  else setTag(tag, "bad", "未就绪");
  let html = "<span>等待检查…</span>";
  if (x.locked) {
    html = `<span>锁定版本 <b class="srv">v${escapeHtml(x.locked.versionName)}</b></span>` +
      `<span>本地 <b>${x.local ? "v" + escapeHtml(x.local.versionName) : "缺失"}</b></span>` +
      (x.downloading ? `<span>下载中(约 84MB)…</span>` : x.ready ? `<span>初始化将自动统一各机版本</span>` : "");
  } else if (x.error) {
    html = `<span>${escapeHtml(x.error)}</span>`;
  }
  meta.innerHTML = html;
  showBtn(dl, !!(x.locked && !x.ready && !x.downloading && !x.checking));
  setDlProg("#xy-prog", !!(x.downloading || dl.disabled));
  updatePkgBadge();
}

// 桌面端本体:代码热更新(下载落位后重启生效)
function renderCodeUpdate(c) {
  latestCodeUpdate = c || latestCodeUpdate;
  const tag = $("#pkg-code-tag"), meta = $("#pkg-code-meta"), dl = $("#btn-dl-code"), rl = $("#btn-relaunch");
  if (!c) { setTag(tag, "", "尚未检查"); meta.innerHTML = "<span>等待检查…</span>"; showBtn(dl, false); showBtn(rl, false); updatePkgBadge(); return; }
  const cur = c.current ? `v${escapeHtml(c.current.versionName)}` : "?";
  if (c.checking) setTag(tag, "warn", "检查中…");
  else if (c.readyToApply) setTag(tag, "warn", "待重启");
  else if (!c.latest) setTag(tag, "bad", "检查失败");
  else if (c.downloading) setTag(tag, "warn", "下载中");
  else if (c.updateAvailable) setTag(tag, "warn", "有新版");
  else setTag(tag, "ok", "已是最新");
  let html;
  if (c.downloading) html = `<span>当前 <b>${cur}</b></span><span>→ <b class="srv">v${escapeHtml(c.latest.versionName)}</b> 下载中…</span>`;
  else if (c.readyToApply) html = `<span><b class="srv">v${escapeHtml(c.latest.versionName)}</b> 已就绪,重启后生效</span>`;
  else if (c.latest && c.updateAvailable) html = `<span>当前 <b>${cur}</b></span><span>最新 <b class="srv">v${escapeHtml(c.latest.versionName)}</b></span>${c.latest.notes ? `<span>${escapeHtml(c.latest.notes)}</span>` : ""}`;
  else if (c.latest) html = `<span>当前 <b>${cur}</b></span><span>已是最新 ✔</span>`;
  else html = c.error ? `<span>当前 ${cur}</span><span>${escapeHtml(c.error)}</span>` : `<span>当前 ${cur}</span><span>尚未检查</span>`;
  meta.innerHTML = html;
  showBtn(dl, !!(c.latest && c.updateAvailable && !c.downloading && !c.checking));
  showBtn(rl, !!c.readyToApply);
  setDlProg("#code-prog", !!(c.downloading || dl.disabled));
  updatePkgBadge();
}

/* ================= AdsPower 浏览器环境页 ================= */
// 数据全部来自 main.js 托管的 gc-ads CLI:adsDetect(安装/API 探测) + adsStatus(status --json)
let adsRows = [];        // status --json 的环境行 {user_id,name,browser,executor,log}
let adsDetectInfo = null;
let adsWatchdogOn = null;  // null=还没探过;状态栏与总览「核心服务」读它

function renderAdsDetect(d) {
  adsDetectInfo = d;
  const apiTag = $("#ads-api-tag"), apiMeta = $("#ads-api-meta");
  setTag(apiTag, d.apiAlive ? "ok" : "bad", d.apiAlive ? "API 在线" : "API 离线");
  apiMeta.innerHTML = d.apiAlive
    ? `<span>Local API <b class="srv">127.0.0.1:50325</b> 可达</span>`
    : `<span>Local API 不可达 — 请启动 AdsPower 客户端并在设置里开启 API</span>`;

  const cliTag = $("#ads-cli-tag"), cliMeta = $("#ads-cli-meta");
  const installBtn = $("#ads-install");
  if (d.root) {
    setTag(cliTag, "ok", `已安装 · ${escapeHtml(d.mode)}`);
    cliMeta.innerHTML = `<span class="cell-mono">${escapeHtml(d.root)}</span>` +
      (d.hasConfig ? `<span>config.yaml ✔</span>` : `<span style="color:var(--bad)">config.yaml 缺失</span>`);
    installBtn.textContent = "重装/更新";
  } else {
    setTag(cliTag, "bad", "未安装");
    cliMeta.innerHTML = `<span>点「一键安装」自动下载安装(自带运行环境,不用装 Python)</span>`;
    installBtn.textContent = "一键安装";
  }
  installBtn.style.display = "";
  renderStatusbar();
}

function showAdsPre(title, text) {
  $("#ads-pre-title").textContent = title;
  $("#ads-pre").textContent = text; // textContent 防注入
  $("#ads-pre-wrap").style.display = "";
}
$("#ads-pre-close").addEventListener("click", () => { $("#ads-pre-wrap").style.display = "none"; });

// 拉本机 gc-ads 各环境实况;浏览器类执行单元的「链路状态」列全靠它
async function loadAdsStatus() {
  const s = await window.gc.adsStatus();
  if (s && s.ok) {
    adsRows = s.rows || [];
  } else {
    adsRows = [];
    // gc-ads 没装是常态(纯真机的门店),别当错误刷屏;只有真报错才进告警
    if (s && s.error) addError({ ts: new Date().toLocaleTimeString(), msg: `gc-ads 状态拉取失败: ${s.error}`, level: "error" });
  }
  renderUnits();
}

// 装机页整页加载:安装/API 探测 + 环境实况 + 看门狗
async function loadAds() {
  const d = await window.gc.adsDetect();
  renderAdsDetect(d);
  if (d.root) await loadAdsStatus();
  else { adsRows = []; renderUnits(); }
  renderAdsWatchdog(await window.gc.adsWatchdogStatus());
}

// 看门狗状态/开关(常驻守护:executor 崩溃拉起、浏览器掉了重开)
function renderAdsWatchdog(w) {
  const tag = $("#ads-act-tag"), btn = $("#ads-watchdog");
  const running = !!(w && w.running);
  adsWatchdogOn = running;
  renderStatusbar();
  setTag(tag, running ? "ok" : "", running ? `看门狗 运行中 · pid ${w.pid}` : "看门狗 未运行");
  btn.textContent = running ? "停止看门狗" : "启动看门狗";
  btn.classList.toggle("amber", running);
}
$("#ads-watchdog").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const cur = await window.gc.adsWatchdogStatus();
    const r = cur && cur.running ? await window.gc.adsWatchdogStop() : await window.gc.adsWatchdogStart();
    if (r && r.ok === false) toast(`看门狗操作失败: ${r.error || "未知错误"}`);
    else toast(cur && cur.running ? "看门狗已停止" : "看门狗已启动(浏览器掉了会自动重开)");
    renderAdsWatchdog(await window.gc.adsWatchdogStatus());
  } finally {
    btn.disabled = false;
  }
});

function bindAdsBtn(id, busyText, fn) {
  const btn = $(id);
  btn.addEventListener("click", async () => {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = busyText;
    try {
      await fn();
    } finally {
      btn.textContent = old;
      btn.disabled = false;
    }
  });
}
bindAdsBtn("#ads-setdir", "选择中…", async () => {
  const d = await window.gc.adsChooseRoot();
  if (d && d.error) toast(d.error);
  renderAdsDetect(d);
  if (d.root) await loadAdsStatus();
});

// 一键安装/重装 gc-ads:下载进度走 ads-install-progress 事件(真实 MB/百分比),解压阶段转 indeterminate
function renderAdsInstallProg(p) {
  const bar = $("#ads-dl-prog"), text = $("#ads-dl-text");
  if (!p || p.phase === "idle") { bar.classList.remove("busy"); text.style.display = "none"; return; }
  if (p.phase === "downloading") {
    bar.classList.remove("busy"); // 有真实百分比时用文字表达,进度条留给解压(indeterminate)
    text.style.display = "";
    const mb = (p.received / 1048576).toFixed(1);
    const totalMb = p.total ? (p.total / 1048576).toFixed(0) : "?";
    const pct = p.total ? ` ${Math.round((p.received / p.total) * 100)}%` : "";
    text.innerHTML = `<span>下载中 ${mb} / ${totalMb} MB${pct}</span>`;
  } else if (p.phase === "extracting") {
    bar.classList.add("busy");
    text.innerHTML = `<span>解压安装中…</span>`;
  } else if (p.phase === "error") {
    bar.classList.remove("busy");
    text.innerHTML = `<span style="color:var(--bad)">安装失败:${escapeHtml(p.error || "")}</span>`;
  }
}
window.gc.onAdsInstallProgress(renderAdsInstallProg);
$("#ads-install").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const r = await window.gc.adsInstall();
    if (r && r.ok) {
      toast(r.wroteConfig ? "安装完成,线上配置已自动写好" : "安装完成");
      await loadAds();
      $("#ads-dl-prog").classList.remove("busy");
      $("#ads-dl-text").style.display = "none";
    } else {
      toast(`安装失败: ${(r && r.error) || "未知错误"}`);
    }
  } finally {
    btn.disabled = false;
  }
});
bindAdsBtn("#ads-start-all", "启动中…", async () => {
  const r = await window.gc.adsStart([]);
  toast(r && r.ok ? "已发起全部启动(浏览器逐个拉起,稍候刷新看状态)" : `启动失败: ${(r && r.error) || "未知错误"}`);
  await loadAds();
});
bindAdsBtn("#ads-stop-all", "停止中…", async () => {
  if (!confirm("确认停止全部环境的 executor?(浏览器保持开着)")) return;
  const r = await window.gc.adsStop([], false);
  toast(r && r.ok ? "已全部停止" : `停止失败: ${(r && r.error) || "未知错误"}`);
  await loadAds();
});
bindAdsBtn("#ads-doctor", "体检中…", async () => {
  showAdsPre("gc-ads 体检", "体检中…(只读,不会改动任何状态)");
  const r = await window.gc.adsDoctor();
  showAdsPre("gc-ads 体检", (r && r.ok) ? r.out : `体检失败: ${(r && r.error) || "未知错误"}`);
});

/* ================= 底部面板:问题 / 输出 ================= */
const MAX_FEED = 400;
const feedEl = $("#log-feed");
const alertBadge = $("#alert-badge");
let feed = [];              // {ts,msg,level} 最新在前
let logFilter = "all";

const FEED_ICON = {
  err: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  wrn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 6v7M12 17v.6"/></svg>',
  inf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 10v7M12 7v.6"/></svg>',
};
const feedCls = (lv) => (lv === "error" ? "err" : lv === "warn" ? "wrn" : "inf");

// 日志里出现哪个账号,就把账号名做成徽标标出来——出问题时先看是谁,再看是什么。
function whoHtml(msg) {
  for (const u of units) {
    if (!u.nick || !msg.includes(u.nick)) continue;
    const icon = u.device && u.device.kind === "browser" ? SVG_BROWSER : SVG_PHONE;
    const badge = `<span class="who">${icon}${escapeHtml(u.nick)}</span>`;
    const [a, b] = [msg.slice(0, msg.indexOf(u.nick)), msg.slice(msg.indexOf(u.nick) + u.nick.length)];
    return escapeHtml(a) + badge + escapeHtml(b);
  }
  return escapeHtml(msg);
}

function renderFeed() {
  const list = feed.filter((f) =>
    logFilter === "all" ? true : logFilter === "attn" ? f.level !== "info" : f.level === "info");
  const counts = { all: feed.length, attn: feed.filter((f) => f.level !== "info").length };
  counts.info = feed.length - counts.attn;
  document.querySelectorAll("#log-chips .chip-btn").forEach((c) => {
    const n = c.querySelector(".n");
    if (n) n.textContent = counts[c.dataset.logfilter] || 0;
  });
  const attn = counts.attn;
  alertBadge.textContent = String(attn);
  alertBadge.style.display = attn ? "flex" : "none";
  if (!list.length) {
    feedEl.innerHTML = `<div class="empty-hint">${feed.length ? "该分类下没有记录" : "暂无告警,全部执行单元状态正常"}</div>`;
    return;
  }
  feedEl.innerHTML = list.slice(0, 200).map((f) => {
    const c = feedCls(f.level);
    return `<div class="fi ${c}"><span class="ic">${FEED_ICON[c]}</span><span class="tm">${escapeHtml(f.ts)}</span><span class="tx">${whoHtml(f.msg)}</span></div>`;
  }).join("");
}

// 全量日志入口(main.js 的 onLog);告警只是 level 不同的同一条流,不再分两个面板
function addLog({ ts, msg, level = "info" }) {
  feed.unshift({ ts, msg: String(msg), level });
  if (feed.length > MAX_FEED) feed.length = MAX_FEED;
  renderFeed();
}
const addError = ({ ts, msg, level }) => addLog({ ts, msg, level: level || "error" });

document.querySelectorAll("#log-chips .chip-btn").forEach((c) =>
  c.addEventListener("click", () => {
    logFilter = c.dataset.logfilter;
    document.querySelectorAll("#log-chips .chip-btn").forEach((x) => x.setAttribute("aria-pressed", String(x === c)));
    renderFeed();
  }));
$("#log-clear").addEventListener("click", () => { feed = []; renderFeed(); });

/* ================= 标题栏 ================= */
$("#win-min").addEventListener("click", () => window.gc.winMin());
$("#win-max").addEventListener("click", () => window.gc.winMaxToggle());
$("#win-close").addEventListener("click", () => window.gc.winClose());

function bindSwitch(el, ipcCall) {
  el.addEventListener("click", async () => {
    const on = !el.classList.contains("on");
    el.classList.toggle("on", on); // 乐观回显,失败时以 IPC 返回值为准
    const r = await ipcCall(on);
    if (typeof r === "boolean") el.classList.toggle("on", r);
  });
}
bindSwitch($("#sw-autoperm"), (on) => window.gc.setAutoPerm(on));
bindSwitch($("#sw-autotile"), (on) => window.gc.setAutoTile(on));
// 起步值与 main.js 默认一致(autoPermOn/autoTileOn 均为 true);首轮轮询成功后 onState 会以真实值覆盖
$("#sw-autoperm").classList.add("on");
$("#sw-autotile").classList.add("on");

function bindBusyBtn(id, busyText, fn) {
  const btn = $(id);
  btn.addEventListener("click", async () => {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = busyText;
    try {
      await fn(btn);
    } finally {
      btn.textContent = old;
      btn.disabled = false;
    }
  });
}
bindBusyBtn("#btn-reconnect", "重启中…", async () => {
  const r = await window.gc.restartAdb();
  toast(r && r.ok ? "adb 连接已重启" : `adb 重启失败: ${(r && r.error) || "未知错误"}`);
});
bindBusyBtn("#btn-fixperm", "补齐中…", async () => {
  const r = await window.gc.fixPerms();
  if (r && r.ok === false && !r.count) toast("没有可操作的设备(需已连接且装了群控 App)");
});
bindBusyBtn("#btn-matrix", "平铺中…", async () => {
  const r = await window.gc.tileScreens();
  if (r && r.ok === false && !r.count) toast("当前没有可投屏的设备");
  else if (r && r.ok && r.count) toast(`矩阵投屏:${r.count} 路画面`);
});

/* 装机包按钮 */
$("#btn-recheck").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    renderAppUpdate(await window.gc.checkAppUpdate());
    renderXianyu(await window.gc.checkXianyu());
    renderCodeUpdate(await window.gc.checkCodeUpdate());
    await loadAds();   // gc-ads / AdsPower API 也在这页,一并重查
  } finally {
    btn.disabled = false;
  }
});
$("#btn-dl-gp").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = "下载中…";
  setDlProg("#gp-prog", true);
  try {
    const r = await window.gc.downloadAppUpdate();
    if (r && r.ok === false) toast(`下载失败: ${r.error || "未知错误"}`);
    else toast("群控 App 装机包已更新");
  } finally {
    btn.textContent = "下载新版";
    btn.disabled = false;
    setDlProg("#gp-prog", false);
  }
});
$("#btn-dl-xy").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = "下载中…";
  setDlProg("#xy-prog", true);
  try {
    const r = await window.gc.downloadXianyu();
    if (r && r.ok === false) toast(`下载失败: ${r.error || "未知错误"}`);
    else toast("闲鱼锁定版已就绪");
  } finally {
    btn.textContent = "预下载";
    btn.disabled = false;
    setDlProg("#xy-prog", false);
  }
});
$("#btn-dl-code").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = "下载中…";
  setDlProg("#code-prog", true);
  try {
    const r = await window.gc.downloadCodeUpdate();
    if (r && r.ok === false) toast(`下载失败: ${r.error || "未知错误"}`);
  } finally {
    btn.textContent = "下载更新";
    btn.disabled = false;
    setDlProg("#code-prog", false);
  }
});
$("#btn-relaunch").addEventListener("click", () => window.gc.relaunchApp());

/* ================= 状态流 ================= */
function applyState(s) {
  if (!s) return;
  latestState = s;
  if (typeof s.autoPermOn === "boolean") $("#sw-autoperm").classList.toggle("on", s.autoPermOn);
  if (Array.isArray(s.scrcpyOpen)) {
    screenOpen.clear();
    s.scrcpyOpen.forEach((x) => screenOpen.add(x));
  }
  if (s.codeUpdate && s.codeUpdate.current) {
    $("#brand-ver").textContent = "v" + s.codeUpdate.current.versionName;
  }
  renderAppUpdate(s.appUpdate);
  renderXianyu(s.xianyu);
  renderCodeUpdate(s.codeUpdate);
  renderUnits();   // 本机 adb 实况变了,单元的链路状态列跟着重画
  if ($("#page-overview").classList.contains("show")) renderOverview();
}
window.gc.onLog(addLog);
window.gc.onState(applyState);
window.gc.getState().then(applyState);

/* ================= 员工登录 ================= */
// 群控的执行单元、任务要员工令牌才给。登录框能先关掉:保活、投屏不需要登录。
let authInfo = { loggedIn: false };
const staffName = (s) => (s && (s.name || s.username)) || "";

function renderAuth(s) {
  authInfo = s || { loggedIn: false };
  $("#sb-login").classList.toggle("off", !authInfo.loggedIn);
  $("#sb-login-text").textContent = authInfo.loggedIn ? `已登录 · ${staffName(authInfo.staff)}` : "未登录";
}

async function openLogin(reason) {
  const logged = authInfo.loggedIn;
  $("#login-form").hidden = logged;
  $("#login-in").hidden = !logged;
  $("#login-sub").textContent = reason || "用员工账号登录";
  $("#login-sub").classList.toggle("bad", Boolean(reason));
  $("#login-err").textContent = "";
  if (logged) {
    $("#login-who").textContent = staffName(authInfo.staff);
  } else {
    // 记住过就填好;上次特意没勾「记住」,就别替人勾上
    const saved = await window.gc.rememberedLogin().catch(() => null);
    $("#login-remember").checked = !(saved && saved.off);
    if (saved && saved.username) {
      $("#login-user").value = saved.username;
      $("#login-pass").value = saved.password || "";
    }
  }
  $("#login-mask").hidden = false;
  (logged ? $("#login-close") : $("#login-user").value ? $("#login-pass") : $("#login-user")).focus();
}

function closeLogin() {
  $("#login-mask").hidden = true;
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#login-submit");
  btn.disabled = true;
  $("#login-err").textContent = "";
  try {
    const remember = $("#login-remember").checked;
    const r = await window.gc.login({ username: $("#login-user").value.trim(), password: $("#login-pass").value, remember });
    if (!r.ok) {
      $("#login-err").textContent = r.reason || "登录失败";
      return;
    }
    closeLogin();
    toast(remember && !r.passwordSaved ? "已登录(这台电脑没法加密保存密码,只记住了账号)" : `已登录:${staffName(r.staff)}`);
    loadUnits(true);   // 没登录时这两页是空的,登上就立刻拉一次
    loadTasks();
  } finally {
    btn.disabled = false;
  }
});
$("#login-later").addEventListener("click", closeLogin);
$("#login-close").addEventListener("click", closeLogin);
$("#login-out").addEventListener("click", async () => {
  await window.gc.logout();
  closeLogin();
  toast("已退出登录");
});
$("#sb-login").addEventListener("click", () => openLogin());

let authSettled = false;
window.gc.onAuthChanged((s) => {
  renderAuth(s);
  // 用着用着令牌失效(群控回 401)才带 reason;开机那次没登上也要弹,但只弹一回
  if (!s.loggedIn && (s.reason || !authSettled)) openLogin(s.reason);
  authSettled = true;
});
window.gc.authState().then((s) => {
  renderAuth(s);
  if (s.loggedIn) {
    authSettled = true;
    return;
  }
  // 主进程开机会先续期/自动登录一次,结果经 auth-changed 送来。它若赶在这页加载完
  // 之前就送到了(事件会丢),这里兜底:等一会儿还没登录再弹框。
  setTimeout(async () => {
    if (authSettled) return;
    authSettled = true;
    const again = await window.gc.authState();
    renderAuth(again);
    if (!again.loggedIn) openLogin();
  }, 3000);
});

/* ================= 启动 ================= */
loadTasks();                          // 任务中心首拉
setInterval(loadTasks, 10000);        // 任务 10s 轮询
loadUnits();                          // 执行单元首拉
setInterval(() => loadUnits(true), 20000);  // 单元 20s 刷新(配额/心跳/在跑任务都在这条线上)
loadAds();                            // 浏览器环境:首拉一次,否则浏览器单元的链路列一直是空的
setInterval(loadAdsStatus, 30000);
renderFeed();
renderStatusbar();
