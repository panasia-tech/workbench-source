/**
 * 闲鱼 MTOP H5 本机签名（Electron 主进程）
 * 自 server/modules/xy_sxjk/sign-simulate.js 同步；客户端 Cookie 必须由调用方传入，默认 skipPrepare。
 */


const crypto = require("crypto");
const { getHttpClientForMtop } = require("./http-client");
const {
  refreshCookieViaGoofishSearch,
  fetchGoofishCookieViaSearchPage,
  cookieHeaderHasMh5Tk,
  mergeSetCookieFromMtopResponse,
} = require("./fetch-cookie-from-goofish");
const {
  inferXianyuAccountLoginFromCookieHeader,
  resolveMtopSessionOptionForCookie,
} = require("./xianyu-cookie-profile");

/** 与 Electron 内嵌闲鱼窗口（Chrome 133）一致，避免会话在 133 建立、MTOP 用 120 触发风控 */
const MTOP_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

/**
 * idle.pc.detail：对齐浏览器商品详情页抓包（Win + Chrome 149）。
 * 可用环境变量 XIANYU_PC_DETAIL_UA 覆盖。
 */
const GOOFISH_PC_DETAIL_DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/** 私聊 IM Token / WebSocket（Chrome 133，与桌面端 goofish-im-ws 一致） */
const GOOFISH_IM_MTOP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

/**
 * 解析后的 Cookie 短期缓存（含搜索页合并 Set-Cookie 的结果），避免每条 MTOP 都 GET 搜索页
 */
const MTOP_COOKIE_CACHE_MS = Math.max(
  30_000,
  parseInt(process.env.XIANYU_MTOP_COOKIE_CACHE_MS || "120000", 10) || 120000
);
let mtopCookieResolveCache = { value: "", expiresAt: 0 };

/**
 * 桌面端传入的 Cookie：发 MTOP 前先 GET 搜索页合并 Set-Cookie（与 XIANYU_MTOP_COOKIE 路径一致），
 * 减轻「仅落盘快照、无浏览器预热」时的风控命中；同 Cookie 并发共用一个 refresh，短 TTL 内复用结果。
 */
const DESKTOP_COOKIE_REFRESH_TTL_MS = Math.max(
  20_000,
  parseInt(process.env.XIANYU_CLIENT_COOKIE_REFRESH_TTL_MS || "90000", 10) || 90_000
);
const desktopCookieWarmCache = { sig: "", value: "", at: 0 };
/** @type {Map<string, Promise<string>>} */
const desktopCookieWarmInflight = new Map();

/** 为 true 时：客户端 Cookie 先发 GET 搜索页合并 Set-Cookie 再算 sign（旧逻辑，可能打乱 tk/enc 配对导致 FAIL_SYS_USER_VALIDATE） */
function desktopCookieWarmEnabled() {
  const v = String(process.env.XIANYU_DESKTOP_COOKIE_WARM || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function desktopCookieSignature(raw) {
  const s = String(raw || "")
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, "")
    .trim();
  if (!s) return "";
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 32);
}

async function warmDesktopClientCookieForMtop(override) {
  const c = String(override || "")
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, "")
    .trim();
  if (!c) return c;
  const sig = desktopCookieSignature(c);
  const now = Date.now();
  if (
    desktopCookieWarmCache.sig === sig &&
    desktopCookieWarmCache.value &&
    now - desktopCookieWarmCache.at < DESKTOP_COOKIE_REFRESH_TTL_MS
  ) {
    return desktopCookieWarmCache.value;
  }
  let pending = desktopCookieWarmInflight.get(sig);
  if (!pending) {
    pending = (async () => {
      try {
        const merged = await refreshCookieViaGoofishSearch(c);
        const final = merged && cookieHeaderHasMh5Tk(merged) ? merged : c;
        desktopCookieWarmCache = { sig, value: final, at: Date.now() };
        return final;
      } catch {
        return c;
      } finally {
        desktopCookieWarmInflight.delete(sig);
      }
    })();
    desktopCookieWarmInflight.set(sig, pending);
  }
  return pending;
}

/**
 * Electron 传入的 Cookie：默认原样使用（对齐参考项目）；仅当 XIANYU_DESKTOP_COOKIE_WARM=1 时再走 warm 合并。
 */
async function prepareClientMtopCookie(override) {
  const c = String(override || "")
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, "")
    .trim();
  if (!c) return "";
  if (!desktopCookieWarmEnabled()) return c;
  return warmDesktopClientCookieForMtop(c);
}

/**
 * 从请求头 Cookie 串里取出 _m_h5_tk 的完整值（与 CONFIG.mH5Tk / sign 用的一致）。
 * Cookie 里若出现多条 `_m_h5_tk`（浏览器多次刷新），与 `mtop-goofish-detail` 一致取**最后一条**再签名。
 */
function parseMh5TkFromCookieHeader(cookieHeader) {
  if (!cookieHeader || typeof cookieHeader !== "string") return "";
  const re = /(?:^|;\s*)_m_h5_tk=([^;]+)/gi;
  let m;
  let raw = "";
  while ((m = re.exec(cookieHeader)) !== null) {
    raw = m[1].trim();
  }
  if (!raw) return "";
  let v = raw;
  try {
    v = decodeURIComponent(v);
  } catch {
    /* 保持原样 */
  }
  return v;
}

/**
 * 优先从 cfg.cookie 解析 _m_h5_tk；若没有再使用 cfg.mH5Tk（含 buildConfigFromCookie 写入的环境变量兜底）。
 * 与逆向合集 `闲鱼PC/sign-simulate.js` 的 resolveMh5Tk(CONFIG) 一致，避免仅用未赋值的 mH5Tk 导致本地 sign 报错。
 */
function resolveMh5Tk(cfg) {
  if (!cfg || typeof cfg !== "object") return "";
  const fromCookie = parseMh5TkFromCookieHeader(String(cfg.cookie || ""));
  if (fromCookie) return fromCookie;
  const manual = cfg.mH5Tk != null ? String(cfg.mH5Tk).trim() : "";
  if (manual) return manual;
  return "";
}

/**
 * 手动配置（推荐）：与浏览器/curl 请求头里 Cookie 整段一致，例如：
 *   curl ... -b 'cna=...; _m_h5_tk=...; _m_h5_tk_enc=...; ...'
 *   export XIANYU_MTOP_COOKIE='cna=...; _m_h5_tk=...; ...'
 * 服务端会用与 PC Chrome 接近的请求访问搜索页并合并 Set-Cookie，减轻 tk 过期频率。
 */
function getXianyuCookie() {
  return String(process.env.XIANYU_MTOP_COOKIE || "")
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, "")
    .trim();
}

function buildConfigFromCookie(cookie) {
  const c = String(cookie || "")
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, "")
    .trim();
  const parsedTk = parseMh5TkFromCookieHeader(c);
  /** 仅当 cookie 里完全没有 _m_h5_tk 时再填（与逆向脚本 CONFIG.mH5Tk 手写值同源） */
  const envManualTk = String(process.env.XIANYU_MH5_TK || "").trim();
  return {
    api: "mtop.taobao.idlehome.home.webpc.feed",
    v: "1.0",
    jsv: "2.7.2",
    appKey: "34839810",
    t: String(Date.now()),
    data: '{"itemId":"","pageSize":30,"pageNumber":1,"machId":""}',
    mH5Tk: parsedTk || envManualTk,
    cookie: c,
    fetch: true
  };
}

function buildConfig() {
  return buildConfigFromCookie(getXianyuCookie());
}

/** 同步：仅反映环境变量（命令行直接跑本文件时用） */
function getMtopConfig() {
  return buildConfig();
}

/**
 * 异步：XIANYU_MTOP_COOKIE（= curl -b 整段）优先；每次缓存窗口内合并搜索页 Set-Cookie 后再算 sign。
 * 无环境变量时冷启动抓取通常拿不到 _m_h5_tk，须手动配置。
 */
async function getMtopConfigAsync() {
  const now = Date.now();
  if (mtopCookieResolveCache.value && mtopCookieResolveCache.expiresAt > now) {
    return buildConfigFromCookie(mtopCookieResolveCache.value);
  }

  let base = getXianyuCookie();
  if (!base) {
    const cold = await fetchGoofishCookieViaSearchPage();
    if (!cold || !cookieHeaderHasMh5Tk(cold)) {
      throw new Error(
        "未配置 XIANYU_MTOP_COOKIE。请用浏览器打开 www.goofish.com（无须账号登录），在开发者工具 Network 里复制请求的「请求标头 → Cookie」整段（须含 _m_h5_tk，与 curl -b 相同）写入该环境变量。"
      );
    }
    base = cold;
  }

  const merged = await refreshCookieViaGoofishSearch(base);
  const finalCookie =
    merged && cookieHeaderHasMh5Tk(merged) ? merged : base;
  if (!cookieHeaderHasMh5Tk(finalCookie)) {
    throw new Error(
      "Cookie 中缺少 _m_h5_tk，无法签名 MTOP。请从浏览器打开 www.goofish.com 后复制请求头里的整段 Cookie（不须账号登录，但须含 _m_h5_tk）；也可设置 XIANYU_MH5_TK 为完整 _m_h5_tk 值。"
    );
  }

  mtopCookieResolveCache = {
    value: finalCookie,
    expiresAt: now + MTOP_COOKIE_CACHE_MS,
  };
  return buildConfigFromCookie(finalCookie);
}

/**
 * 从 _m_h5_tk 的值中提取 token 部分。
 * 常见格式：token_expireTime（以下划线分隔）
 * 例如：abc123_1711111111111 -> token 为 abc123
 */
function getTokenFromMH5Tk(mH5TkValue) {
  if (!mH5TkValue || typeof mH5TkValue !== "string") {
    throw new Error(
      "缺少 _m_h5_tk，无法计算 sign（本机 sign-simulate，非闲鱼接口返回）。请保证 Cookie 含 _m_h5_tk 或设置 XIANYU_MH5_TK。"
    );
  }
  const token = mH5TkValue.split("_")[0];
  if (!token) {
    throw new Error("_m_h5_tk 格式异常，未提取到 token。");
  }
  return token;
}

/**
 * 计算 MTOP sign：
 * sign = md5(token + "&" + t + "&" + appKey + "&" + data)
 */
function calcMtopSign({ token, t, appKey, data }) {
  if (!token || !t || !appKey || typeof data !== "string") {
    throw new Error("参数不完整：需要 token、t、appKey、data(字符串)。");
  }
  const raw = `${token}&${t}&${appKey}&${data}`;
  return crypto.createHash("md5").update(raw, "utf8").digest("hex");
}

/**
 * 组装请求 URL（便于调试对比）
 * @param {boolean} [omitSpmAndLogParams] 为 true 时不带 spm_cnt、spm_pre，也不合并 extraParams（给 idle.pc.detail 等极简查询串）
 */
function buildRequestUrl({
  api,
  v,
  jsv,
  appKey,
  t,
  sign,
  spmCnt = "a21ybx.home.0.0",
  spmPre = "",
  extraParams = null,
  /** 已登录常见 AutoLoginOnly；仅匿名浏览常见 OptionalLogin（由 resolveMtopSessionOptionForCookie 决定） */
  sessionOption = "AutoLoginOnly",
  omitSpmAndLogParams = false,
}) {
  const base = `https://h5api.m.goofish.com/h5/${api}/${v}/`;
  // 与常见抓包一致：查询串不含 data，data 放在 POST body（见 postMtopFeed）
  /** @type {Record<string, string>} */
  const baseParams = {
    jsv,
    appKey,
    t,
    sign,
    v,
    type: "originaljson",
    accountSite: "xianyu",
    dataType: "json",
    timeout: "20000",
    api,
    sessionOption,
  };
  if (!omitSpmAndLogParams) {
    baseParams.spm_cnt = spmCnt;
  }
  const params = new URLSearchParams(baseParams);
  if (!omitSpmAndLogParams && spmPre) {
    params.set("spm_pre", spmPre);
  }
  if (!omitSpmAndLogParams && extraParams && typeof extraParams === "object") {
    for (const [k, val] of Object.entries(extraParams)) {
      if (val != null && String(val) !== "") params.set(k, String(val));
    }
  }
  return `${base}?${params.toString()}`;
}

/**
 * 组装分页请求体，保持与真实接口字段一致。
 * 这里按页拉取首页瀑布流：pageNumber + pageSize。
 */
function buildFeedData(pageNumber, pageSize) {
  return JSON.stringify({
    itemId: "",
    pageSize,
    pageNumber,
    machId: "",
  });
}

/**
 * 组装搜索请求体，尽量贴近网页端搜索接口最小必需字段。
 * keyword 为关键词，pageNumber 为页码，rowsPerPage 为每页数量。
 *
 * sortOptions（与 `源代码/static/js/p_search-index.js` 一致）：
 * - 最新在前（新发布）：sortField=create，sortValue=desc，fromFilter=true
 * - 价格：sortField=price，sortValue=asc|desc，fromFilter=true
 * - 新降价：sortField=reduce，sortValue=desc，fromFilter=true
 * - 综合默认：sortField、sortValue 空字符串，fromFilter=false
 */
/** PC 商品详情：`data={"itemId":"..."} `，与浏览器 DevTools 抓包一致 */
function buildPcDetailData(itemId) {
  return JSON.stringify({
    itemId: String(itemId || "").trim(),
  });
}

/**
 * 详情页 MTOP 埋点：模拟「搜索结果点进商品」。
 * - spm_cnt 固定 a21ybx.item.0.0（详情页）
 * - spm_pre = a21ybx.search.searchFeedList.{index}.{logId}
 * - log_id 与 spm_pre 末段一致
 * @param {{ feedIndex?: number, logId?: string } } [opts]
 */
function buildPcItemDetailSpmContext(opts = {}) {
  const logId =
    opts.logId != null && String(opts.logId).trim()
      ? String(opts.logId).trim().slice(0, 48)
      : crypto.randomBytes(8).toString("hex");
  const feedIndex = Number.isFinite(Number(opts.feedIndex))
    ? Math.max(0, Math.floor(Number(opts.feedIndex)))
    : 0;
  const spmPre = `a21ybx.search.searchFeedList.${feedIndex}.${logId}`;
  return {
    spmCnt: "a21ybx.item.0.0",
    spmPre,
    logId,
  };
}

/** 个人中心页导航 / 用户信息：`mtop.idle.web.user.page.nav`，抓包 body 为 data=%7B%7D（{}） */
function buildUserPageNavData() {
  return JSON.stringify({});
}

/** 他人个人页/店铺页头部：`mtop.idle.web.user.page.head`，抓包 data 含 self、userId */
function buildUserPageHeadData(opts = {}) {
  const userId = String(opts.userId ?? opts.seller_user_id ?? "").trim();
  if (!userId) {
    throw new Error("缺少 userId");
  }
  const self =
    opts.self === true || opts.self === "true" || opts.self === 1 || opts.self === "1";
  return JSON.stringify({ self, userId });
}

/**
 * 店铺页「最新」商品列表：`mtop.idle.web.xyh.item.list`
 * @param {Record<string, unknown>} opts
 * @param {string} [opts.userId] 卖家用户 id（与网页店铺一致）
 * @param {number|string} [opts.groupId] 分组 id（可选；部分店铺接口要求）
 */
function buildXyhItemListData(opts = {}) {
  const userId = String(opts.userId ?? opts.seller_user_id ?? "").trim();
  if (!userId) {
    throw new Error("缺少店铺卖家 userId");
  }
  const pageNumber = Math.max(1, Math.floor(Number(opts.pageNumber) || 1));
  const pageSize = Math.min(50, Math.max(1, Math.floor(Number(opts.pageSize) || 20)));
  /** 默认 false +「最新」：与移动端一致，保证首页是按上新时间；仅显式 true 时走 needGroupInfo */
  const needGroupInfo = opts.needGroupInfo === true;
  if (needGroupInfo) {
    return JSON.stringify({
      needGroupInfo: true,
      pageNumber,
      userId,
      pageSize,
    });
  }
  const gn = String(opts.groupName != null ? opts.groupName : "最新").trim() || "最新";
  const payload = {
    needGroupInfo: false,
    pageNumber,
    userId,
    pageSize,
    groupName: gn,
    defaultGroup: opts.defaultGroup !== false,
    groupSortId:
      String(opts.groupSortId != null ? opts.groupSortId : "newest").trim() || "newest",
  };
  const gid = opts.groupId != null ? opts.groupId : opts.shop_group_id;
  if (gid != null && String(gid).trim() !== "") {
    const n = Math.floor(Number(gid));
    if (Number.isFinite(n) && n > 0) payload.groupId = n;
  }
  return JSON.stringify(payload);
}

/** 与搜索列表「明文 userId」判定一致：6～20 位纯数字 */
function isLikelyPlainNumericSellerId(s) {
  const t = String(s ?? "").trim();
  if (!t || t.length > 20) return false;
  return /^\d{6,20}$/.test(t);
}

/**
 * 在 itemDO / sellerDO 浅层按常见字段名找数字卖家 ID（不整树扫描，避免误匹配 medal 等）。
 */
function shallowPickNumericSellerIdFromObject(obj, norm) {
  if (!obj || typeof obj !== "object") return "";
  const keys = [
    "userId",
    "user_id",
    "sellerId",
    "seller_id",
    "sellerUserId",
    "seller_user_id",
    "ownerUserId",
    "owner_user_id",
  ];
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    const s = norm(obj[k]);
    if (isLikelyPlainNumericSellerId(s)) return s;
  }
  return "";
}

/**
 * 从 idle.pc.detail 取卖家标识：优先 6～20 位数字 userId（拉黑「原始 ID」、头像用），
 * 否则退回 trackParams / sellerDO 等（与聊一聊 peer 兼容）。
 * 字段顺序兼顾旧抓包与接口改版后的常见位置。
 */
function pickPeerUserIdFromPcDetail(json) {
  const d = json?.data;
  if (!d) return "";
  const norm = (v) => {
    if (v == null || v === "") return "";
    return String(v).trim();
  };

  const ordered = [];
  const push = (v) => {
    const s = norm(v);
    if (!s) return;
    if (ordered.includes(s)) return;
    ordered.push(s);
  };

  push(d.itemDO?.trackParams?.sellerId);
  push(d.trackParams?.sellerId);
  push(d.sellerDO?.sellerId);
  push(d.itemDO?.userId);
  push(d.itemDO?.sellerUserId);
  push(d.itemDO?.sellerId);
  push(d.sellerDO?.userId);
  push(d.sellerDO?.sellerUserId);
  push(d.sellerDO?.sellerId);
  push(d.userId);
  push(d.seller?.userId);
  push(d.seller?.sellerId);

  for (const sub of [d.itemDO, d.sellerDO, d.seller]) {
    const s = shallowPickNumericSellerIdFromObject(sub, norm);
    if (s) push(s);
  }

  const plain = ordered.find((x) => isLikelyPlainNumericSellerId(x));
  if (plain) return plain;
  return ordered[0] || "";
}

/** 详情 JSON 里抓取「我想要」进线用的 spm（a21ybx.item.want.1.xxx）；没有则返回站点通用兜底 */
function pickSpmItemWantFromPcDetail(json) {
  try {
    const blob = JSON.stringify(json?.data ?? {});
    const re = /a21ybx\.item\.want\.\d+\.[A-Za-z0-9]+/g;
    const ms = blob.match(re);
    if (ms && ms.length) return ms[0];
  } catch {
    /* ignore */
  }
  return "a21ybx.item.want.1.50903da65Xt1c3";
}

/**
 * 从 idle.pc.detail 取一点商品展示信息（强聊中转页用）；字段随接口变化多路径兜底。
 * @returns {{ title: string, price: string, imageUrl: string }}
 */
function pickItemBriefFromPcDetail(json) {
  const d = json?.data;
  if (!d || typeof d !== "object") {
    return { title: "", price: "", imageUrl: "" };
  }
  const norm = (v) => {
    if (v == null || v === "") return "";
    return String(v).trim();
  };
  const item = d.itemDO || d.itemInfo || d.item || {};
  let title = norm(item.title || item.subject || item.itemTitle || item.desc);
  let price = norm(
    item.soldPrice ||
      item.price ||
      item.currentPrice ||
      item.displayPrice ||
      item.originalPrice ||
      item.originalPriceString
  );
  if (!price && d.priceInfo && typeof d.priceInfo === "object") {
    price = norm(d.priceInfo.price || d.priceInfo.text);
  }
  let imageUrl = norm(item.picUrl || item.pic || item.coverUrl || item.mainPicUrl);
  if (!imageUrl && Array.isArray(item.images) && item.images.length) {
    const first = item.images[0];
    imageUrl = norm(
      typeof first === "string" ? first : first?.url || first?.picUrl || first?.pic
    );
  }
  if (!imageUrl && Array.isArray(item.picUrls) && item.picUrls.length) {
    imageUrl = norm(item.picUrls[0]);
  }
  if (!imageUrl && Array.isArray(item.imageInfos) && item.imageInfos.length) {
    const fi = item.imageInfos[0];
    imageUrl = norm(fi?.url || fi?.picUrl || fi?.pic);
  }
  title = title
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  price = price.slice(0, 48);
  imageUrl = imageUrl.slice(0, 512);
  return { title, price, imageUrl };
}

/**
 * 从 idle.pc.detail 取卖家昵称 / 头像（写 xy_sxjk_seller 用）；多路径兜底。
 * @returns {{ nick: string, avatar: string }}
 */
function pickSellerNickAvatarFromPcDetail(json) {
  const d = json?.data;
  if (!d || typeof d !== "object") {
    return { nick: "", avatar: "" };
  }
  const norm = (v) => {
    if (v == null || v === "") return "";
    return String(v).trim();
  };
  const s = d.sellerDO || d.seller || {};
  const nick = norm(
    s.nick ||
      s.nickname ||
      s.sellerNick ||
      s.userNick ||
      s.displayNick ||
      s.sellerName
  ).slice(0, 120);
  let avatar = norm(
    s.avatar ||
      s.picUrl ||
      s.userAvatar ||
      s.headPic ||
      s.sellerAvatar ||
      s.userAvatarUrl ||
      s.sellerAvatarUrl
  ).slice(0, 512);
  if (avatar.startsWith("//")) avatar = `https:${avatar}`;
  return { nick, avatar };
}

/**
 * 从 `mtop.idle.web.user.page.head` 取明文卖家 id（baseInfo.kcUserId）。
 * @param {object} json
 * @returns {string}
 */
function pickPlainUserIdFromUserPageHead(json) {
  const d = json?.data;
  if (!d || typeof d !== "object") return "";
  const norm = (v) => {
    if (v == null || v === "") return "";
    return String(v).trim();
  };
  const baseInfo = d.baseInfo && typeof d.baseInfo === "object" ? d.baseInfo : {};
  const kc = norm(baseInfo.kcUserId);
  if (isLikelyPlainNumericSellerId(kc)) return kc;
  return shallowPickNumericSellerIdFromObject(baseInfo, norm);
}

/**
 * 从 `mtop.idle.web.user.page.head` 取卖家昵称 / 头像（data.module.base）。
 * @returns {{ nick: string, avatar: string }}
 */
function pickSellerNickAvatarFromUserPageHead(json) {
  const d = json?.data;
  if (!d || typeof d !== "object") return { nick: "", avatar: "" };
  const norm = (v) => {
    if (v == null || v === "") return "";
    return String(v).trim();
  };
  const mod = d.module && typeof d.module === "object" ? d.module : {};
  const base = mod.base && typeof mod.base === "object" ? mod.base : {};
  const avWrap = base.avatar && typeof base.avatar === "object" ? base.avatar : {};
  const nick = norm(base.displayName).slice(0, 120);
  let avatar = norm(avWrap.avatar).slice(0, 512);
  if (avatar.startsWith("//")) avatar = `https:${avatar}`;
  return { nick, avatar };
}

/** PC 站聊一聊完整 URL：spm 须在 query 中（与抓包一致）；缺省与 pickSpmItemWantFromPcDetail 兜底一致 */
function buildGoofishImWebUrl({ itemId, peerUserId, spm }) {
  const id = String(itemId || "").trim();
  const peer = String(peerUserId || "").trim();
  const sp = String(spm || "").trim() || "a21ybx.item.want.1.50903da65Xt1c3";
  if (!id || !peer) return "";
  const q = new URLSearchParams();
  q.set("spm", sp);
  q.set("itemId", id);
  q.set("peerUserId", peer);
  return `https://www.goofish.com/im?${q.toString()}`;
}

function buildSearchData(keyword, pageNumber, rowsPerPage, sortOptions = {}) {
  const sortField = sortOptions.sortField != null ? String(sortOptions.sortField) : "";
  const sortValue = sortOptions.sortValue != null ? String(sortOptions.sortValue) : "";
  let fromFilter = !!sortOptions.fromFilter;
  if (!fromFilter && (sortField !== "" || sortValue !== "")) {
    fromFilter = true;
  }
  const pv = sortOptions.propValueStr && typeof sortOptions.propValueStr === "object" ? sortOptions.propValueStr : null;
  if (!fromFilter && pv && typeof pv.searchFilter === "string" && pv.searchFilter.length > 0) {
    fromFilter = true;
  }
  /** 官方抓包：仅地域 divisionList 时 fromFilter 仍为 false，不因 extraFilterValue 强行改 true */
  return JSON.stringify({
    pageNumber,
    keyword,
    fromFilter,
    rowsPerPage,
    sortValue,
    sortField,
    customDistance: sortOptions.customDistance != null ? String(sortOptions.customDistance) : "",
    gps: sortOptions.gps != null ? String(sortOptions.gps) : "",
    propValueStr: pv || {},
    customGps: sortOptions.customGps != null ? String(sortOptions.customGps) : "",
    searchReqFromPage: "pcSearch",
    extraFilterValue: sortOptions.extraFilterValue != null ? String(sortOptions.extraFilterValue) : "{}",
    userPositionJson: sortOptions.userPositionJson != null ? String(sortOptions.userPositionJson) : "{}",
  });
}

/**
 * Referer 策略：与「逆向合集/闲鱼PC/sign-simulate」一致时固定为站点根，避免带搜索词 Referer 时易被风控；
 * 需要旧行为可设 XIANYU_MTOP_REFERER_STRATEGY=search。
 */
function resolveMtopPostReferer(explicitReferer) {
  const strategy = String(
    process.env.XIANYU_MTOP_REFERER_STRATEGY || ""
  )
    .trim()
    .toLowerCase();
  if (strategy === "search" || strategy === "page") {
    const ref =
      typeof explicitReferer === "string" && explicitReferer.trim()
        ? explicitReferer.trim()
        : "https://www.goofish.com/";
    return ref;
  }
  return "https://www.goofish.com/";
}

/**
 * MTOP POST 请求头（与浏览器常见抓包一致）；`referer` 经 {@link resolveMtopPostReferer} 得到实际 Referer。
 * @param {string} safeCookie 已 strip 控制字符的 Cookie
 * @param {string} [referer]
 * @returns {Record<string, string>}
 */
function buildMtopPostHeaders(safeCookie, referer) {
  const ref = resolveMtopPostReferer(referer);
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    ...(safeCookie ? { Cookie: safeCookie } : {}),
    Referer: ref,
    Origin: "https://www.goofish.com",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "User-Agent": MTOP_BROWSER_USER_AGENT,
    Accept: "application/json",
    "Sec-Fetch-Site": "same-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "Sec-CH-UA":
      '"Chromium";v="133", "Google Chrome";v="133", "Not-A.Brand";v="24"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"Windows"',
  };
}

/**
 * idle.pc.detail 专用：对齐浏览器商品详情页抓包（含 Sec-Fetch / Client Hints）。
 * @param {string} safeCookie
 * @param {string} [referer] 抓包为站点根；有显式值时优先
 */
function buildMtopPostHeadersGoofishPcDetail(safeCookie, referer) {
  const ua = String(process.env.XIANYU_PC_DETAIL_UA || "").trim() || GOOFISH_PC_DETAIL_DEFAULT_UA;
  const ref =
    typeof referer === "string" && referer.trim()
      ? referer.trim()
      : "https://www.goofish.com/";
  return {
    accept: "application/json",
    "accept-language": "zh-CN,zh;q=0.9,ja;q=0.8,zh-HK;q=0.7",
    "content-type": "application/x-www-form-urlencoded",
    ...(safeCookie ? { cookie: safeCookie } : {}),
    origin: "https://www.goofish.com",
    priority: "u=1, i",
    referer: ref,
    "sec-ch-ua": '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "user-agent": ua,
  };
}

/** 私聊 IM Token（与 WebSocket 同 Chrome 133） */
function buildMtopPostHeadersGoofishIm(safeCookie, referer) {
  const ref = resolveMtopPostReferer(referer);
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    ...(safeCookie ? { Cookie: safeCookie } : {}),
    Referer: ref,
    Origin: "https://www.goofish.com",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "User-Agent": GOOFISH_IM_MTOP_USER_AGENT,
    Accept: "application/json",
    "Sec-Fetch-Site": "same-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "Sec-CH-UA": '"Chromium";v="133", "Google Chrome";v="133", "Not-A.Brand";v="24"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"Windows"',
    priority: "u=1, i",
  };
}

function isMtopAntiBotChallengeJson(json) {
  if (!json || typeof json !== "object") return false;
  const ret0 = Array.isArray(json.ret) ? String(json.ret[0] || "") : String(json.ret || "");
  const ret1 = Array.isArray(json.ret) ? String(json.ret[1] || "") : "";
  if (/FAIL_SYS_USER_VALIDATE|FAIL_SYS_SESSION_EXPIRED|RGV587/i.test(ret0)) return true;
  if (/RGV587|挤爆|USER_VALIDATE|人机验证|安全验证|滑块|哎哟喂/i.test(ret1)) return true;
  const raw = String(json?.data?.url || "").trim();
  if (
    raw &&
    /^https?:\/\//i.test(raw) &&
    /punish|_____tmd_____|x5sec|captcha|risk\.taobao|\/sm\//i.test(raw)
  ) {
    return true;
  }
  return false;
}

/** XianYuApis.refresh_token：`mtop.taobao.idlemessage.pc.loginuser.get`，body 为 {} */
function buildIdleMessageLoginUserGetData() {
  return JSON.stringify({});
}

/**
 * 仅生成「IM 登录态刷新」MTOP 的 URL / body / Cookie / Referer，不发 HTTP。
 */
async function buildSignedIdleMessageLoginUserGetMtopRequest(clientCookieOverride = null, opts = {}) {
  const skipPrepare = !!opts.skipPrepareClientCookie;
  const override =
    typeof clientCookieOverride === "string"
      ? clientCookieOverride.replace(/[\r\n\t\x00-\x1f\x7f]/g, "").trim()
      : "";
  const cookieForMtop = override
    ? skipPrepare
      ? override
      : await prepareClientMtopCookie(override)
    : "";
  const cfg = cookieForMtop ? buildConfigFromCookie(cookieForMtop) : await getMtopConfigAsync();
  if (!cfg.cookie) {
    throw new Error(
      "无法解析闲鱼 Cookie：客户端应传入登录后的 client_mtop_cookie，或在服务端配置 XIANYU_MTOP_COOKIE"
    );
  }
  const t = String(Date.now());
  const data = buildIdleMessageLoginUserGetData();
  const token = getTokenFromMH5Tk(resolveMh5Tk(cfg));
  const sign = calcMtopSign({ token, t, appKey: cfg.appKey, data });
  const cookieProfile = inferXianyuAccountLoginFromCookieHeader(cfg.cookie);
  let sessionOption = resolveMtopSessionOptionForCookie(cfg.cookie);
  if (opts.sessionOption != null && String(opts.sessionOption).trim()) {
    sessionOption = String(opts.sessionOption).trim();
  }
  const spmCnt =
    opts.spmCnt != null && String(opts.spmCnt).trim() ? String(opts.spmCnt).trim() : "a21ybx.im.0.0";
  const spmPre =
    opts.spmPre != null && String(opts.spmPre).trim()
      ? String(opts.spmPre).trim()
      : "a21ybx.item.want.1.12523da6waCtUp";
  const extraParams = { log_id: "12523da6waCtUp" };
  const requestUrl = buildRequestUrl({
    api: "mtop.taobao.idlemessage.pc.loginuser.get",
    v: "1.0",
    jsv: cfg.jsv,
    appKey: cfg.appKey,
    t,
    sign,
    spmCnt,
    spmPre,
    sessionOption,
    extraParams,
  });
  const referer =
    typeof opts.referer === "string" && opts.referer.trim()
      ? opts.referer.trim()
      : "https://www.goofish.com/";
  return {
    requestUrl,
    data,
    cookie: cfg.cookie,
    referer,
    t,
    sign,
    cookieProfile,
    mtopSessionOption: sessionOption,
  };
}

/**
 * 与浏览器 DevTools「载荷」里 Form Data 一致：POST，body 为 data=...
 * query 仍带 jsv、appKey、t、sign 等（与抓包一致）。
 * 使用 axios 发送，便于与项目其它请求方式统一。
 */
async function postMtopFeed({ url, data, cookie, referer, headersOverride } = {}) {
  // 只去掉换行与控制字符；不要剥离非 ASCII，否则可能破坏 Cookie 值导致服务端不认登录态
  const safeCookie = String(cookie || "")
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, "")
    .trim();

  const body = new URLSearchParams({ data }).toString();
  const httpAxios = getHttpClientForMtop();
  const headers =
    headersOverride && typeof headersOverride === "object"
      ? headersOverride
      : buildMtopPostHeaders(safeCookie, referer);

  const res = await httpAxios.post(url, body, {
    headers,
    // 按字符串处理响应，与原先 https 拼接逻辑一致，便于 JSON.parse
    responseType: "text",
    transformResponse: [(body) => body],
  });
  const cookieAfterResponse = mergeSetCookieFromMtopResponse(safeCookie, res.headers);
  return {
    statusCode: res.status,
    body: res.data,
    cookieAfterResponse,
  };
}

/**
 * 判断 MTOP 业务是否成功（ret 首条以 SUCCESS:: 开头）
 */
function isMtopSuccess(json) {
  const ret = json?.ret;
  if (!Array.isArray(ret) || ret.length === 0) return false;
  return String(ret[0]).startsWith("SUCCESS::");
}

/**
 * MTOP 业务失败：按接口原样展示 ret（怎么返回就怎么提示），不做「统一成请登录」的映射。
 */
function describeMtopFailureForClient(json) {
  const ret = json?.ret;
  if (Array.isArray(ret) && ret.length > 0) {
    const s = ret
      .map((x) => String(x ?? "").trim())
      .filter(Boolean)
      .join(" ");
    if (s) return s.slice(0, 2000);
  }
  if (ret != null && typeof ret === "string" && String(ret).trim()) {
    return String(ret).trim().slice(0, 2000);
  }
  return "闲鱼接口返回失败（无 ret）";
}

/**
 * 对外提供：按签名算法请求某一页真实数据（供 server.js 调用）。
 */
async function fetchSignedFeedPage(pageNumber = 1, pageSize = 8) {
  const cfg = await getMtopConfigAsync();
  if (!cfg.cookie) {
    throw new Error("无法解析闲鱼 Cookie（请配置 XIANYU_MTOP_COOKIE 或检查自动抓 Cookie 是否拿到 _m_h5_tk）");
  }
  const safePageNumber = Math.max(Number.parseInt(pageNumber, 10) || 1, 1);
  const safePageSize = Math.min(Math.max(Number.parseInt(pageSize, 10) || 8, 1), 30);
  const t = String(Date.now());
  const data = buildFeedData(safePageNumber, safePageSize);
  const token = getTokenFromMH5Tk(resolveMh5Tk(cfg));
  const sign = calcMtopSign({ token, t, appKey: cfg.appKey, data });
  const cookieProfile = inferXianyuAccountLoginFromCookieHeader(cfg.cookie);
  const sessionOption = resolveMtopSessionOptionForCookie(cfg.cookie);
  const url = buildRequestUrl({
    api: cfg.api,
    v: cfg.v,
    jsv: cfg.jsv,
    appKey: cfg.appKey,
    t,
    sign,
    sessionOption,
  });
  const { statusCode, body, cookieAfterResponse } = await postMtopFeed({
    url,
    data,
    cookie: cfg.cookie,
  });
  let json;
  try {
    json = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    json = { rawBody: body };
  }
  return {
    statusCode,
    json,
    sign,
    t,
    requestData: data,
    requestUrl: url,
    ok: isMtopSuccess(json),
    cookieProfile,
    mtopSessionOption: sessionOption,
    clientMtopCookieAfter: cookieAfterResponse,
  };
}

const MTOP_REFERER_SEARCH = "https://www.goofish.com/search";

/**
 * 仅生成搜索 MTOP 的 URL / body / Cookie / Referer，不发 HTTP。
 * 供「服务端算 sign → 客户端（Electron）直连 h5api」链路使用。
 * @param {object} [opts]
 * @param {boolean} [opts.skipPrepareClientCookie] 为 true 时不再调用 prepareClientMtopCookie（预热应在 Electron 本机完成后再传入）。
 */
async function buildSignedSearchMtopRequest(
  keyword = "",
  pageNumber = 1,
  pageSize = 90,
  sortOptions = {},
  clientCookieOverride = null,
  opts = {}
) {
  const skipPrepare = !!opts.skipPrepareClientCookie;
  const override =
    typeof clientCookieOverride === "string"
      ? clientCookieOverride.replace(/[\r\n\t\x00-\x1f\x7f]/g, "").trim()
      : "";
  const cookieForMtop = override
    ? skipPrepare
      ? override
      : await prepareClientMtopCookie(override)
    : "";
  const cfg = cookieForMtop
    ? buildConfigFromCookie(cookieForMtop)
    : await getMtopConfigAsync();
  if (!cfg.cookie) {
    throw new Error(
      "无法解析闲鱼 Cookie：客户端应传入登录后的 client_mtop_cookie，或在服务端配置 XIANYU_MTOP_COOKIE"
    );
  }
  const safeKeyword = String(keyword || "").trim();
  const safePageNumber = Math.max(Number.parseInt(pageNumber, 10) || 1, 1);
  const safePageSize = Math.min(Math.max(Number.parseInt(pageSize, 10) || 90, 1), 150);
  const t = String(Date.now());
  const data = buildSearchData(safeKeyword, safePageNumber, safePageSize, sortOptions);
  const token = getTokenFromMH5Tk(resolveMh5Tk(cfg));
  const sign = calcMtopSign({ token, t, appKey: cfg.appKey, data });
  const cookieProfile = inferXianyuAccountLoginFromCookieHeader(cfg.cookie);
  const sessionOption = resolveMtopSessionOptionForCookie(cfg.cookie);
  const requestUrl = buildRequestUrl({
    api: "mtop.taobao.idlemtopsearch.pc.search",
    v: "1.0",
    jsv: cfg.jsv,
    appKey: cfg.appKey,
    t,
    sign,
    spmCnt: "a21ybx.search.0.0",
    spmPre: "a21ybx.search.searchInput.0",
    sessionOption,
  });
  const referer =
    safeKeyword.length > 0
      ? `${MTOP_REFERER_SEARCH}?q=${encodeURIComponent(safeKeyword)}`
      : MTOP_REFERER_SEARCH;
  return {
    requestUrl,
    data,
    cookie: cfg.cookie,
    referer,
    t,
    sign,
    cookieProfile,
    mtopSessionOption: sessionOption,
  };
}

/**
 * PC 搜索联想：`mtop.taobao.idlemtopsearch.pc.search.suggest`，与浏览器搜索框下拉同源。
 */
function buildSearchSuggestData(inputWords = "", opts = {}) {
  const w = String(inputWords || "").trim().slice(0, 120);
  const searchReqFromPage =
    opts.searchReqFromPage != null && String(opts.searchReqFromPage).trim()
      ? String(opts.searchReqFromPage).trim()
      : "xyPcHome";
  const bucketId = Number.isFinite(Number(opts.bucketId)) ? Math.floor(Number(opts.bucketId)) : 30;
  const type = Number.isFinite(Number(opts.type)) ? Math.floor(Number(opts.type)) : 0;
  return JSON.stringify({
    inputWords: w,
    searchReqFromPage,
    bucketId,
    type,
  });
}

async function buildSignedSearchSuggestMtopRequest(
  clientCookieOverride = null,
  inputWords = "",
  opts = {}
) {
  const skipPrepare = !!opts.skipPrepareClientCookie;
  const override =
    typeof clientCookieOverride === "string"
      ? clientCookieOverride.replace(/[\r\n\t\x00-\x1f\x7f]/g, "").trim()
      : "";
  const cookieForMtop = override
    ? skipPrepare
      ? override
      : await prepareClientMtopCookie(override)
    : "";
  const cfg = cookieForMtop
    ? buildConfigFromCookie(cookieForMtop)
    : await getMtopConfigAsync();
  if (!cfg.cookie) {
    throw new Error(
      "无法解析闲鱼 Cookie：客户端应传入登录后的 client_mtop_cookie，或在服务端配置 XIANYU_MTOP_COOKIE"
    );
  }
  const w = String(inputWords || "").trim().slice(0, 120);
  const data = buildSearchSuggestData(w, opts);
  const t = String(Date.now());
  const token = getTokenFromMH5Tk(resolveMh5Tk(cfg));
  const sign = calcMtopSign({ token, t, appKey: cfg.appKey, data });
  const cookieProfile = inferXianyuAccountLoginFromCookieHeader(cfg.cookie);
  const sessionOption = resolveMtopSessionOptionForCookie(cfg.cookie);
  const requestUrl = buildRequestUrl({
    api: "mtop.taobao.idlemtopsearch.pc.search.suggest",
    v: "1.0",
    jsv: cfg.jsv,
    appKey: cfg.appKey,
    t,
    sign,
    spmCnt: "a21ybx.search.0.0",
    spmPre: "a21ybx.search.searchInput.0",
    sessionOption,
  });
  const referer =
    w.length > 0 ? `${MTOP_REFERER_SEARCH}?q=${encodeURIComponent(w)}` : MTOP_REFERER_SEARCH;
  return {
    requestUrl,
    data,
    cookie: cfg.cookie,
    referer,
    t,
    sign,
    cookieProfile,
    mtopSessionOption: sessionOption,
  };
}

const GAIA_GW_DEFAULT_PI_URL =
  "https://h5.m.goofish.com/wow/moyu/moyu-project/xy-site/pages/announcement";

function buildGaiaGwV2IndexGetData(piUrlOpt) {
  const piUrl =
    typeof piUrlOpt === "string" && piUrlOpt.trim()
      ? piUrlOpt.trim().slice(0, 2048)
      : GAIA_GW_DEFAULT_PI_URL;
  return JSON.stringify({ piUrl });
}

async function buildSignedGaiaGwV2IndexGetMtopRequest(
  clientCookieOverride = null,
  opts = {}
) {
  const skipPrepare = !!opts.skipPrepareClientCookie;
  const override =
    typeof clientCookieOverride === "string"
      ? clientCookieOverride.replace(/[\r\n\t\x00-\x1f\x7f]/g, "").trim()
      : "";
  const cookieForMtop = override
    ? skipPrepare
      ? override
      : await prepareClientMtopCookie(override)
    : "";
  const cfg = cookieForMtop
    ? buildConfigFromCookie(cookieForMtop)
    : await getMtopConfigAsync();
  if (!cfg.cookie) {
    throw new Error(
      "无法解析闲鱼 Cookie：客户端应传入登录后的 client_mtop_cookie，或在服务端配置 XIANYU_MTOP_COOKIE"
    );
  }
  const data = buildGaiaGwV2IndexGetData(opts.piUrl);
  const t = String(Date.now());
  const token = getTokenFromMH5Tk(resolveMh5Tk(cfg));
  const sign = calcMtopSign({ token, t, appKey: cfg.appKey, data });
  const cookieProfile = inferXianyuAccountLoginFromCookieHeader(cfg.cookie);
  const sessionOption = resolveMtopSessionOptionForCookie(cfg.cookie);
  const logId =
    opts.logId != null && String(opts.logId).trim()
      ? String(opts.logId).trim().slice(0, 48)
      : crypto.randomBytes(8).toString("hex");
  const spmCnt =
    opts.spmCnt != null && String(opts.spmCnt).trim()
      ? String(opts.spmCnt).trim()
      : "a21ybx.home.0.0";
  const spmPre =
    opts.spmPre != null && String(opts.spmPre).trim()
      ? String(opts.spmPre).trim()
      : `a21ybx.personal.logo.1.${logId}`;

  const requestUrl = buildRequestUrl({
    api: "mtop.gaia.nodejs.gaia.idle.data.gw.v2.index.get",
    v: "1.0",
    jsv: cfg.jsv,
    appKey: cfg.appKey,
    t,
    sign,
    spmCnt,
    spmPre,
    extraParams: { log_id: logId },
    sessionOption,
  });
  const referer = "https://www.goofish.com/";
  return {
    requestUrl,
    data,
    cookie: cfg.cookie,
    referer,
    t,
    sign,
    cookieProfile,
    mtopSessionOption: sessionOption,
  };
}

/**
 * 解析 suggest 接口 JSON，抽出可展示的联想词字符串（结构与官方返回略有差异时可递归兜底）。
 * @returns {string[]}
 */
function pickSearchSuggestTextsFromMtopJson(json) {
  /** @type {Map<string, string>} */
  const byLower = new Map();

  /** 埋点/trace 等非展示字段（多级英文点号或小驼峰链路），避免误塞进下拉框 */
  function isLikelyTelemetryOrFieldLabel(t) {
    const s = String(t ?? "").trim().replace(/\s+/g, " ");
    if (s.length < 2 || s.includes("://")) return true;
    const hasHumanScript =
      /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(s);
    if (hasHumanScript) return false;
    if (/\d/.test(s)) return false;
    if (/[,，。!?？'"「」`]/.test(s) || /\.\.\./u.test(s)) return false;
    if (/^-/.test(s) || /\s/.test(s)) return false;
    const parts = s.split(".");
    if (parts.length < 2) return false;
    return parts.every((p) => /^[a-zA-Z][a-zA-Z0-9_]*$/u.test(p));
  }

  const add = (v) => {
    const t = String(v ?? "")
      .trim()
      .replace(/\s+/g, " ");
    if (t.length < 2 || t.length > 120) return;
    if (isLikelyTelemetryOrFieldLabel(t)) return;
    const k = t.toLowerCase();
    if (byLower.has(k)) return;
    byLower.set(k, t);
  };

  function itemHasSuggestFields(x) {
    return (
      x != null &&
      typeof x === "object" &&
      (typeof x.suggest === "string" ||
        typeof x.word === "string" ||
        typeof x.text === "string" ||
        typeof x.keyword === "string" ||
        typeof x.completion === "string" ||
        typeof x.displayText === "string" ||
        typeof x.highLight === "string" ||
        typeof x.highlight === "string")
    );
  }

  /** 优先联想项对象数组；纯字符串数组仅当至少有一项不像埋点字段名时才采纳 */
  /** @returns {unknown[]|null} */
  const findSuggestArrayDeep = function find(o, depth = 0) {
    if (depth > 10 || o == null) return null;
    if (Array.isArray(o)) {
      if (o.length > 0 && o.every((x) => itemHasSuggestFields(x))) {
        return o;
      }
      if (
        o.length > 0 &&
        o.every((x) => typeof x === "string") &&
        o.some((s) => !isLikelyTelemetryOrFieldLabel(String(s)))
      ) {
        return o;
      }
      if (
        o.length > 0 &&
        o.some(itemHasSuggestFields) &&
        o.every((x) => typeof x === "string" || itemHasSuggestFields(x))
      ) {
        return o.filter((x) => typeof x !== "string" || !isLikelyTelemetryOrFieldLabel(String(x)));
      }
      for (const el of o) {
        const r = find(el, depth + 1);
        if (r) return r;
      }
      return null;
    }
    if (typeof o === "object") {
      const keys = [
        "items",
        "result",
        "results",
        "suggestWords",
        "suggestList",
        "list",
        "vos",
        "vosData",
        "keywords",
        "data",
      ];
      for (const key of keys) {
        const v = o[key];
        if (Array.isArray(v)) {
          const r = find(v, depth + 1);
          if (r) return r;
        }
      }
      for (const v of Object.values(o)) {
        const r = find(v, depth + 1);
        if (r) return r;
      }
    }
    return null;
  };

  function addFromItem(item) {
    if (typeof item === "string") add(item);
    else if (item != null && typeof item === "object") {
      add(
        item.suggest ??
          item.word ??
          item.text ??
          item.keyword ??
          item.displayText ??
          item.completion ??
          item.highLight ??
          item.highlight ??
          ""
      );
    }
  }

  const d = json?.data;
  if (d != null && typeof d === "object") {
    const arr = findSuggestArrayDeep(d);
    if (Array.isArray(arr)) {
      for (const item of arr) addFromItem(item);
    }
  }

  const max =
    Number.isFinite(Number(process.env.XIANYU_SUGGEST_PARSE_MAX_OUT)) &&
    Number(process.env.XIANYU_SUGGEST_PARSE_MAX_OUT) > 0
      ? Math.min(80, Math.max(5, Math.floor(Number(process.env.XIANYU_SUGGEST_PARSE_MAX_OUT))))
      : 35;
  return [...byLower.values()].slice(0, max);
}

/**
 * 仅生成「个人页导航 / 用户信息」MTOP 的 URL / body / Cookie / Referer，不发 HTTP。
 * api：mtop.idle.web.user.page.nav（与浏览器抓包一致，data 为 {}）
 * @param {string|null} clientCookieOverride
 * @param {object} [opts]
 * @param {boolean} [opts.skipPrepareClientCookie]
 * @param {string} [opts.sessionOption] 覆盖 Cookie 推断（默认 resolveMtopSessionOptionForCookie）
 * @param {string} [opts.spmCnt] 默认 a21ybx.personal.0.0
 * @param {string} [opts.spmPre] 可选，如 create-order 页带来的 spm_pre
 * @param {string} [opts.logId] 可选，写入查询参数 log_id
 * @param {string} [opts.referer] 默认 https://www.goofish.com/
 */
async function buildSignedUserPageNavMtopRequest(
  clientCookieOverride = null,
  opts = {}
) {
  const skipPrepare = !!opts.skipPrepareClientCookie;
  const override =
    typeof clientCookieOverride === "string"
      ? clientCookieOverride.replace(/[\r\n\t\x00-\x1f\x7f]/g, "").trim()
      : "";
  const cookieForMtop = override
    ? skipPrepare
      ? override
      : await prepareClientMtopCookie(override)
    : "";
  const cfg = cookieForMtop
    ? buildConfigFromCookie(cookieForMtop)
    : await getMtopConfigAsync();
  if (!cfg.cookie) {
    throw new Error(
      "无法解析闲鱼 Cookie：客户端应传入登录后的 client_mtop_cookie，或在服务端配置 XIANYU_MTOP_COOKIE"
    );
  }
  const t = String(Date.now());
  const data = buildUserPageNavData();
  const token = getTokenFromMH5Tk(resolveMh5Tk(cfg));
  const sign = calcMtopSign({ token, t, appKey: cfg.appKey, data });
  const cookieProfile = inferXianyuAccountLoginFromCookieHeader(cfg.cookie);
  let sessionOption = resolveMtopSessionOptionForCookie(cfg.cookie);
  if (opts.sessionOption != null && String(opts.sessionOption).trim()) {
    sessionOption = String(opts.sessionOption).trim();
  }
  const spmCnt =
    opts.spmCnt != null && String(opts.spmCnt).trim()
      ? String(opts.spmCnt).trim()
      : "a21ybx.personal.0.0";
  const spmPre =
    opts.spmPre != null && String(opts.spmPre).trim()
      ? String(opts.spmPre).trim()
      : "";
  const extraParams = {};
  if (opts.logId != null && String(opts.logId).trim()) {
    extraParams.log_id = String(opts.logId).trim();
  }
  const requestUrl = buildRequestUrl({
    api: "mtop.idle.web.user.page.nav",
    v: "1.0",
    jsv: cfg.jsv,
    appKey: cfg.appKey,
    t,
    sign,
    spmCnt,
    spmPre,
    sessionOption,
    extraParams: Object.keys(extraParams).length ? extraParams : null,
  });
  const referer =
    typeof opts.referer === "string" && opts.referer.trim()
      ? opts.referer.trim()
      : "https://www.goofish.com/";
  return {
    requestUrl,
    data,
    cookie: cfg.cookie,
    referer,
    t,
    sign,
    cookieProfile,
    mtopSessionOption: sessionOption,
  };
}

/**
 * 个人页/店铺页头部：`mtop.idle.web.user.page.head`（仅签名，不发 HTTP）
 * @param {string|null} clientCookieOverride
 * @param {object} [opts]
 * @param {string} [opts.userId] 目标用户 id
 * @param {boolean|string|number} [opts.self] 是否查看自己，默认 false
 * @param {string} [opts.referer] 默认带 userId 的 personal 页
 */
async function buildSignedUserPageHeadMtopRequest(clientCookieOverride = null, opts = {}) {
  const skipPrepare = !!opts.skipPrepareClientCookie;
  const override =
    typeof clientCookieOverride === "string"
      ? clientCookieOverride.replace(/[\r\n\t\x00-\x1f\x7f]/g, "").trim()
      : "";
  const cookieForMtop = override
    ? skipPrepare
      ? override
      : await prepareClientMtopCookie(override)
    : "";
  const cfg = cookieForMtop
    ? buildConfigFromCookie(cookieForMtop)
    : await getMtopConfigAsync();
  if (!cfg.cookie) {
    throw new Error(
      "无法解析闲鱼 Cookie：客户端应传入登录后的 client_mtop_cookie，或在服务端配置 XIANYU_MTOP_COOKIE"
    );
  }
  const t = String(Date.now());
  const data = buildUserPageHeadData(opts);
  const token = getTokenFromMH5Tk(resolveMh5Tk(cfg));
  const sign = calcMtopSign({ token, t, appKey: cfg.appKey, data });
  const cookieProfile = inferXianyuAccountLoginFromCookieHeader(cfg.cookie);
  let sessionOption = resolveMtopSessionOptionForCookie(cfg.cookie);
  if (opts.sessionOption != null && String(opts.sessionOption).trim()) {
    sessionOption = String(opts.sessionOption).trim();
  }
  const spmCnt =
    opts.spmCnt != null && String(opts.spmCnt).trim()
      ? String(opts.spmCnt).trim()
      : "a21ybx.personal.0.0";
  const spmPre =
    opts.spmPre != null && String(opts.spmPre).trim()
      ? String(opts.spmPre).trim()
      : "";
  const extraParams = {};
  if (opts.logId != null && String(opts.logId).trim()) {
    extraParams.log_id = String(opts.logId).trim();
  }
  const requestUrl = buildRequestUrl({
    api: "mtop.idle.web.user.page.head",
    v: "1.0",
    jsv: cfg.jsv,
    appKey: cfg.appKey,
    t,
    sign,
    spmCnt,
    spmPre,
    sessionOption,
    extraParams: Object.keys(extraParams).length ? extraParams : null,
  });
  const uidForRef = String(opts.userId ?? opts.seller_user_id ?? "").trim();
  const referer =
    typeof opts.referer === "string" && opts.referer.trim()
      ? opts.referer.trim()
      : uidForRef
        ? `https://www.goofish.com/personal?userId=${encodeURIComponent(uidForRef)}`
        : "https://www.goofish.com/";
  return {
    requestUrl,
    data,
    cookie: cfg.cookie,
    referer,
    t,
    sign,
    cookieProfile,
    mtopSessionOption: sessionOption,
  };
}

/**
 * 店铺「最新」列表：`mtop.idle.web.xyh.item.list`（仅签名，不发 HTTP）
 */
async function buildSignedXyhItemListMtopRequest(clientCookieOverride = null, opts = {}) {
  const skipPrepare = !!opts.skipPrepareClientCookie;
  const override =
    typeof clientCookieOverride === "string"
      ? clientCookieOverride.replace(/[\r\n\t\x00-\x1f\x7f]/g, "").trim()
      : "";
  const cookieForMtop = override
    ? skipPrepare
      ? override
      : await prepareClientMtopCookie(override)
    : "";
  const cfg = cookieForMtop
    ? buildConfigFromCookie(cookieForMtop)
    : await getMtopConfigAsync();
  if (!cfg.cookie) {
    throw new Error(
      "无法解析闲鱼 Cookie：客户端应传入登录后的 client_mtop_cookie，或在服务端配置 XIANYU_MTOP_COOKIE"
    );
  }
  const t = String(Date.now());
  const data = buildXyhItemListData(opts);
  const token = getTokenFromMH5Tk(resolveMh5Tk(cfg));
  const sign = calcMtopSign({ token, t, appKey: cfg.appKey, data });
  const cookieProfile = inferXianyuAccountLoginFromCookieHeader(cfg.cookie);
  let sessionOption = resolveMtopSessionOptionForCookie(cfg.cookie);
  if (opts.sessionOption != null && String(opts.sessionOption).trim()) {
    sessionOption = String(opts.sessionOption).trim();
  }
  const spmCnt =
    opts.spmCnt != null && String(opts.spmCnt).trim()
      ? String(opts.spmCnt).trim()
      : "a21ybx.personal.0.0";
  const spmPre =
    opts.spmPre != null && String(opts.spmPre).trim()
      ? String(opts.spmPre).trim()
      : "";
  const extraParams = {};
  if (opts.logId != null && String(opts.logId).trim()) {
    extraParams.log_id = String(opts.logId).trim();
  }
  const requestUrl = buildRequestUrl({
    api: "mtop.idle.web.xyh.item.list",
    v: "1.0",
    jsv: cfg.jsv,
    appKey: cfg.appKey,
    t,
    sign,
    spmCnt,
    spmPre,
    sessionOption,
    extraParams: Object.keys(extraParams).length ? extraParams : null,
  });
  const referer =
    typeof opts.referer === "string" && opts.referer.trim()
      ? opts.referer.trim()
      : "https://www.goofish.com/";
  return {
    requestUrl,
    data,
    cookie: cfg.cookie,
    referer,
    t,
    sign,
    cookieProfile,
    mtopSessionOption: sessionOption,
  };
}

/**
 * 对外提供：按签名算法请求搜索结果（供 server.js 调用）。
 * 说明：搜索接口与首页 feed 使用相同签名规则，但 API 与 data 字段不同。
 */
async function fetchSignedSearchPage(
  keyword = "",
  pageNumber = 1,
  pageSize = 90,
  sortOptions = {},
  clientCookieOverride = null
) {
  const built = await buildSignedSearchMtopRequest(
    keyword,
    pageNumber,
    pageSize,
    sortOptions,
    clientCookieOverride
  );
  const { statusCode, body, cookieAfterResponse } = await postMtopFeed({
    url: built.requestUrl,
    data: built.data,
    cookie: built.cookie,
    referer: built.referer,
  });
  let json;
  try {
    json = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    json = { rawBody: body };
  }
  return {
    statusCode,
    json,
    sign: built.sign,
    t: built.t,
    requestData: built.data,
    requestUrl: built.requestUrl,
    ok: isMtopSuccess(json),
    cookieProfile: built.cookieProfile,
    mtopSessionOption: built.mtopSessionOption,
    clientMtopCookieAfter: cookieAfterResponse,
  };
}

/**
 * PC 商品详情 MTOP（对齐浏览器商品详情页抓包），用于取 IM 的 peerUserId。
 * 查询串带 spm_cnt / spm_pre / log_id；请求头对齐 Chrome 149；Cookie 中多条 `_m_h5_tk` 时取最后一条参与签名。
 */
async function fetchSignedPcItemDetail(itemId, clientCookieOverride = null) {
  const override =
    typeof clientCookieOverride === "string"
      ? clientCookieOverride.replace(/[\r\n\t\x00-\x1f\x7f]/g, "").trim()
      : "";
  const cookieForMtop = override ? await prepareClientMtopCookie(override) : "";
  const cfg = cookieForMtop
    ? buildConfigFromCookie(cookieForMtop)
    : await getMtopConfigAsync();
  if (!cfg.cookie) {
    throw new Error(
      "无法解析闲鱼 Cookie：客户端应传入登录后的 client_mtop_cookie，或在服务端配置 XIANYU_MTOP_COOKIE"
    );
  }
  const id = String(itemId || "").trim();
  if (!id) {
    throw new Error("缺少 itemId");
  }
  const t = String(Date.now());
  const data = buildPcDetailData(id);
  const token = getTokenFromMH5Tk(resolveMh5Tk(cfg));
  const sign = calcMtopSign({ token, t, appKey: cfg.appKey, data });
  const cookieProfile = inferXianyuAccountLoginFromCookieHeader(cfg.cookie);
  const sessionOption = resolveMtopSessionOptionForCookie(cfg.cookie);
  const spm = buildPcItemDetailSpmContext();
  const url = buildRequestUrl({
    api: "mtop.taobao.idle.pc.detail",
    v: "1.0",
    jsv: cfg.jsv,
    appKey: cfg.appKey,
    t,
    sign,
    sessionOption,
    spmCnt: spm.spmCnt,
    spmPre: spm.spmPre,
    extraParams: { log_id: spm.logId },
  });
  const safeCookie = String(cfg.cookie || "")
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, "")
    .trim();
  const detailReferer = "https://www.goofish.com/";
  const detailHeaders = buildMtopPostHeadersGoofishPcDetail(safeCookie, detailReferer);
  const { statusCode, body, cookieAfterResponse } = await postMtopFeed({
    url,
    data,
    cookie: cfg.cookie,
    referer: detailReferer,
    headersOverride: detailHeaders,
  });
  let json;
  try {
    json = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    json = { rawBody: body };
  }
  return {
    statusCode,
    json,
    ok: isMtopSuccess(json),
    cookieProfile,
    mtopSessionOption: sessionOption,
    clientMtopCookieAfter: cookieAfterResponse,
  };
}

/**
 * 他人个人页头部：`mtop.idle.web.user.page.head`（用加密 userId 换明文 kcUserId，强聊/打招呼优先于 idle.pc.detail）。
 * @param {string} encryptedUserId 列表侧加密卖家 id（seller_key）
 * @param {string|null} clientCookieOverride
 * @param {object} [opts]
 */
async function fetchSignedUserPageHead(encryptedUserId, clientCookieOverride = null, opts = {}) {
  const userId = String(encryptedUserId ?? opts.userId ?? "").trim();
  if (!userId) {
    throw new Error("缺少 userId");
  }
  const logId =
    opts.logId != null && String(opts.logId).trim()
      ? String(opts.logId).trim().slice(0, 48)
      : crypto.randomBytes(8).toString("hex");
  const spmPre =
    opts.spmPre != null && String(opts.spmPre).trim()
      ? String(opts.spmPre).trim()
      : `a21ybx.item.itemHeader.1.${logId}`;
  const built = await buildSignedUserPageHeadMtopRequest(clientCookieOverride, {
    userId,
    self: opts.self === true,
    skipPrepareClientCookie: opts.skipPrepareClientCookie,
    sessionOption: opts.sessionOption,
    spmCnt: opts.spmCnt != null && String(opts.spmCnt).trim() ? String(opts.spmCnt).trim() : "a21ybx.personal.0.0",
    spmPre,
    logId,
    referer:
      typeof opts.referer === "string" && opts.referer.trim()
        ? opts.referer.trim()
        : "https://www.goofish.com/",
  });
  const safeCookie = String(built.cookie || "")
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, "")
    .trim();
  const headers = buildMtopPostHeaders(safeCookie, built.referer);
  let statusCode;
  let body;
  let cookieAfterResponse;
  try {
    ({ statusCode, body, cookieAfterResponse } = await postMtopFeed({
      url: built.requestUrl,
      data: built.data,
      cookie: built.cookie,
      referer: built.referer,
      headersOverride: headers,
    }));
  } catch (err) {
    throw err;
  }
  let json;
  try {
    json = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    json = { rawBody: body };
  }
  return {
    statusCode,
    json,
    ok: isMtopSuccess(json),
    cookieProfile: built.cookieProfile,
    mtopSessionOption: built.mtopSessionOption,
    clientMtopCookieAfter: cookieAfterResponse,
  };
}

function main() {
  const cfg = getMtopConfig();
  const { api, v, jsv, appKey } = cfg;
  const t = String(Date.now());
  const data = cfg.data;

  let token;
  try {
    token = getTokenFromMH5Tk(resolveMh5Tk(cfg));
  } catch (err) {
    console.error("提取 token 失败：", err.message);
    process.exit(1);
  }

  const sign = calcMtopSign({ token, t, appKey, data });
  const sessionOption = resolveMtopSessionOptionForCookie(cfg.cookie || "");
  const url = buildRequestUrl({ api, v, jsv, appKey, t, sign, sessionOption });
  const prof = inferXianyuAccountLoginFromCookieHeader(cfg.cookie || "");

  console.log("=== MTOP sign 模拟结果 ===");
  console.log(
    "Cookie 推断（账号登录）:",
    prof.accountLoggedIn,
    "hints:",
    prof.hints,
    "sessionOption:",
    sessionOption
  );
  console.log("token:", token);
  console.log("t:", t);
  console.log("appKey:", appKey);
  console.log("data:", data);
  console.log("sign:", sign);
  console.log("\n请求 URL：");
  console.log(url);

  const wantFetch = !!cfg.fetch;

  if (!wantFetch) {
    console.log(
      "\n————————————————————————————————————————————————————\n" +
      "【说明】本次运行没有发 HTTP 请求，所以不会出现「接口返回的业务数据」。\n" +
      "上面只是本地根据公式算出了 sign 并打印 URL。\n\n" +
      "若要看到服务端 JSON，请配置环境变量后运行：\n" +
      "  XIANYU_MTOP_COOKIE=从 goofish 复制的整段 Cookie（须含 _m_h5_tk）\n" +
      "  可选 XIANYU_MH5_TK=仅当 Cookie 里缺 _m_h5_tk 时手写完整值\n" +
      "  node .\\\\sign-simulate.js\n" +
      "————————————————————————————————————————————————————\n"
    );
  }

  if (wantFetch) {
    const cookie = cfg.cookie || "";
    if (!cookie.includes("_m_h5_tk")) {
      console.error(
        "\n[FETCH] 未设置 COOKIE 或 Cookie 中不含 _m_h5_tk，接口通常会返回 FAIL_SYS_TOKEN_EMPTY 等错误。"
      );
    }
    console.log("\n=== 正在 POST 请求（axios，FETCH=1）===");
    postMtopFeed({ url, data, cookie })
      .then(({ statusCode, body }) => {
        console.log("HTTP 状态码:", statusCode);
        console.log("响应正文：");
        try {
          const j = JSON.parse(body);
          console.log(JSON.stringify(j, null, 2));
        } catch {
          console.log(body);
        }
      })
      .catch((e) => {
        console.error("请求失败：", e.message);
        process.exit(1);
      });
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  getMtopConfig,
  getMtopConfigAsync,
  buildConfigFromCookie,
  parseMh5TkFromCookieHeader,
  resolveMh5Tk,
  getTokenFromMH5Tk,
  calcMtopSign,
  buildRequestUrl,
  buildFeedData,
  buildPcDetailData,
  buildPcItemDetailSpmContext,
  buildMtopPostHeadersGoofishPcDetail,
  GOOFISH_PC_DETAIL_DEFAULT_UA,
  buildUserPageNavData,
  buildUserPageHeadData,
  buildXyhItemListData,
  buildIdleMessageLoginUserGetData,
  buildSignedUserPageNavMtopRequest,
  buildSignedUserPageHeadMtopRequest,
  buildSignedXyhItemListMtopRequest,
  buildSignedIdleMessageLoginUserGetMtopRequest,
  buildSearchData,
  pickPeerUserIdFromPcDetail,
  pickPlainUserIdFromUserPageHead,
  pickSpmItemWantFromPcDetail,
  pickItemBriefFromPcDetail,
  pickSellerNickAvatarFromPcDetail,
  pickSellerNickAvatarFromUserPageHead,
  buildGoofishImWebUrl,
  GOOFISH_IM_MTOP_USER_AGENT,
  buildMtopPostHeadersGoofishIm,
  isMtopAntiBotChallengeJson,
  postMtopFeed,
  fetchSignedFeedPage,
  buildSignedSearchMtopRequest,
  buildSearchSuggestData,
  buildSignedSearchSuggestMtopRequest,
  GAIA_GW_DEFAULT_PI_URL,
  buildGaiaGwV2IndexGetData,
  buildSignedGaiaGwV2IndexGetMtopRequest,
  pickSearchSuggestTextsFromMtopJson,
  fetchSignedSearchPage,
  fetchSignedUserPageHead,
  fetchSignedPcItemDetail,
  prepareClientMtopCookie,
  isMtopSuccess,
  describeMtopFailureForClient,
  inferXianyuAccountLoginFromCookieHeader,
  resolveMtopSessionOptionForCookie,
};
