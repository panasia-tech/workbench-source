/**
 * 闲鱼相关 HTTP（MTOP、goofish 页面）代理封装。
 *
 * 环境变量（任选其一，勿把密钥写进代码）：
 * - XIANYU_HTTP_PROXY  固定代理，如 http://127.0.0.1:7890 或 http://user:pass@host:port
 * - XIANYU_PROXY_FETCH_URL  动态提取（GET，返回 JSON 或纯文本），见 parseProxyFromFetchBody
 * - XIANYU_PROXY_FETCH_CACHE_MS  动态代理缓存毫秒，默认 60000
 * - XIANYU_PROXY_DISABLED=1  关闭代理
 * - XIANYU_PROXY_DEBUG=1  打印代理解析过程（来源、缓存、拉取 URL 状态）；密码仅显示 ***
 */
const axios = require("axios");

/** 拉取代理列表的请求不走本模块代理，避免死循环 */
const fetchApiClient = axios.create({
  timeout: 20000,
  validateStatus: () => true,
  proxy: false,
});

let fetchCache = { proxyOpt: null, at: 0 };

/**
 * 搜索类 MTOP 是否应走「代理 axios」（固定代理 / 环境变量取 IP 接口）
 */
function shouldRouteSearchThroughProxy() {
  if (proxyDisabled()) return false;
  if (String(process.env.XIANYU_HTTP_PROXY || "").trim()) return true;
  if (String(process.env.XIANYU_PROXY_FETCH_URL || "").trim()) return true;
  const v = String(process.env.XIANYU_MTOP_USE_PROXY || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
/** 避免 XIANYU_PROXY_DEBUG 下每个 MTOP 请求都打重复日志 */
let debugLoggedFixedProxy = false;
let debugLoggedDisabled = false;
let debugLoggedNoProxyFallback = false;

function proxyDebugEnabled() {
  const v = String(process.env.XIANYU_PROXY_DEBUG || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** @param {import('axios').AxiosProxyConfig | null} opt */
function maskProxyForLog(opt) {
  if (!opt) return null;
  const out = {
    protocol: opt.protocol,
    host: opt.host,
    port: opt.port,
  };
  if (opt.auth && opt.auth.username) {
    out.auth = {
      username: opt.auth.username,
      password: opt.auth.password ? "***" : "",
    };
  }
  return out;
}

function proxyLog(msg, extra) {
  if (!proxyDebugEnabled()) return;
  if (extra !== undefined) {
    console.log("[闲鱼代理]", msg, extra);
  } else {
    console.log("[闲鱼代理]", msg);
  }
}

function proxyDisabled() {
  const v = String(process.env.XIANYU_PROXY_DISABLED || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * @param {string} raw
 * @returns {import('axios').AxiosProxyConfig | null}
 */
function parseProxyUrlToAxios(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  let href = s;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(href)) {
    href = "http://" + href;
  }
  let u;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  const protocol = (u.protocol || "http:").replace(/:$/, "");
  if (protocol !== "http" && protocol !== "https") return null;
  const host = u.hostname;
  const port = u.port ? parseInt(u.port, 10) : protocol === "https" ? 443 : 80;
  if (!host || !port) return null;
  /** @type {import('axios').AxiosProxyConfig} */
  const out = { protocol, host, port };
  if (u.username) {
    out.auth = {
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password || ""),
    };
  }
  return out;
}

/**
 * 从「取 IP 接口」返回体中解析出 host:port 或完整代理 URL
 * @param {*} body
 * @returns {string|null}
 */
function parseProxyFromFetchBody(body) {
  if (body == null) return null;
  if (typeof body === "string") {
    const t = body.trim();
    if (!t) return null;
    const oneLine = t.split(/\r?\n/)[0].trim();
    if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}$/.test(oneLine)) return `http://${oneLine}`;
    if (/^https?:\/\//i.test(oneLine)) return oneLine;
    try {
      return parseProxyFromFetchBody(JSON.parse(t));
    } catch {
      return null;
    }
  }
  if (typeof body !== "object") return null;
  const o = body;
  if (Array.isArray(o.data) && o.data.length) {
    const first = o.data[0];
    if (typeof first === "string") {
      return first.includes("://") ? first : /^[\d.:]+$/.test(first) ? `http://${first}` : null;
    }
    if (first && typeof first === "object") {
      const ip = first.ip || first.host || first.IP || first.server;
      const port = first.port || first.PORT;
      if (ip && port != null) return `http://${ip}:${port}`;
    }
  }
  if (typeof o.data === "string" && /:/.test(o.data)) {
    return o.data.includes("://") ? o.data : `http://${o.data.trim()}`;
  }
  if (typeof o.ip === "string" && o.port != null) {
    return `http://${o.ip}:${o.port}`;
  }
  return null;
}

async function resolveProxyFromFetchUrl() {
  const api = String(process.env.XIANYU_PROXY_FETCH_URL || "").trim();
  if (!api) return null;

  const ttl = Math.max(
    5_000,
    parseInt(process.env.XIANYU_PROXY_FETCH_CACHE_MS || "60000", 10) || 60_000
  );
  const now = Date.now();
  if (fetchCache.proxyOpt && now - fetchCache.at < ttl) {
    proxyLog("动态代理：缓存命中", {
      ageMs: now - fetchCache.at,
      ttlMs: ttl,
      proxy: maskProxyForLog(fetchCache.proxyOpt),
    });
    return fetchCache.proxyOpt;
  }

  proxyLog("动态代理：请求取代理接口", {
    fetchUrlPreview:
      api.length > 120 ? `${api.slice(0, 120)}…(len=${api.length})` : api,
    ttlMs: ttl,
    hadStaleCache: !!fetchCache.proxyOpt,
  });

  try {
    const res = await fetchApiClient.get(api, { responseType: "text" });
    const raw =
      typeof res.data === "string"
        ? res.data
        : res.data != null
          ? JSON.stringify(res.data)
          : "";
    let body = res.data;
    if (typeof body === "string" && body.trim().startsWith("{")) {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep text */
      }
    }
    const urlStr = parseProxyFromFetchBody(body) || parseProxyFromFetchBody(raw);
    const opt = urlStr ? parseProxyUrlToAxios(urlStr) : null;
    fetchCache = { proxyOpt: opt, at: Date.now() };

    proxyLog("动态代理：接口已响应", {
      httpStatus: res.status,
      parsedUrlShown:
        urlStr && urlStr.length > 80 ? `${urlStr.slice(0, 80)}…` : urlStr,
      axiosProxy: maskProxyForLog(opt),
      bodyPreview:
        typeof raw === "string"
          ? raw.length > 200
            ? `${raw.slice(0, 200)}…`
            : raw
          : undefined,
    });

    if (!opt) {
      proxyLog("动态代理：未能从返回体解析出可用代理", {
        parseProxyFromFetchBody_result: urlStr,
      });
    }

    return opt;
  } catch (err) {
    proxyLog("动态代理：取接口异常，回退到旧缓存（若有）", {
      error: err?.message || String(err),
      staleProxy: maskProxyForLog(fetchCache.proxyOpt),
    });
    return fetchCache.proxyOpt;
  }
}

/**
 * 解析当前应对闲鱼请求使用的 axios proxy 配置（无则 null）
 */
async function resolveXianyuAxiosProxy() {
  if (proxyDisabled()) {
    if (!debugLoggedDisabled) {
      debugLoggedDisabled = true;
      proxyLog("代理已关闭 (XIANYU_PROXY_DISABLED)");
    }
    return null;
  }

  const fixed = String(process.env.XIANYU_HTTP_PROXY || "").trim();
  if (fixed) {
    const opt = parseProxyUrlToAxios(fixed);
    if (!debugLoggedFixedProxy) {
      debugLoggedFixedProxy = true;
      proxyLog("使用固定代理 env XIANYU_HTTP_PROXY", maskProxyForLog(opt));
    }
    return opt;
  }

  const fromFetch = await resolveProxyFromFetchUrl();
  if (!fromFetch && !debugLoggedNoProxyFallback) {
    debugLoggedNoProxyFallback = true;
    proxyLog("未配置固定代理且动态取代理无结果，请求将直连（不走代理）");
  }
  return fromFetch;
}

/**
 * @param {import('axios').AxiosInstance} instance
 */
function attachXianyuProxyInterceptor(instance) {
  instance.interceptors.request.use(
    async (config) => {
      const p = await resolveXianyuAxiosProxy();
      if (p) {
        config.proxy = p;
      } else {
        delete config.proxy;
      }
      return config;
    },
    (err) => Promise.reject(err)
  );
}

/**
 * 清空动态取 IP 缓存，使下一请求重新 GET 取代理接口（列表搜索失败换代理重试时使用）。
 */
function bustDynamicProxyCache() {
  fetchCache = { proxyOpt: null, at: 0 }
  proxyLog('动态代理：已清空缓存（将重新取 IP）')
}

module.exports = {
  attachXianyuProxyInterceptor,
  resolveXianyuAxiosProxy,
  bustDynamicProxyCache,
  parseProxyUrlToAxios,
  parseProxyFromFetchBody,
  shouldRouteSearchThroughProxy
}