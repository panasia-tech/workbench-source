/**
 * 闲鱼 Web：在已有 Cookie 时用浏览器式请求访问搜索页并合并 Set-Cookie；无 Cookie 时冷 GET 作兜底（常拿不到 _m_h5_tk）。
 */
const { httpAxios } = require("./http-client");

const CHROME_NAVIGATE_HEADERS = {
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "Accept-Language": "zh-CN,zh;q=0.9,ja;q=0.8,zh-HK;q=0.7",
  Priority: "u=0, i",
  "Sec-CH-UA":
    '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
  "Sec-CH-UA-Mobile": "?0",
  "Sec-CH-UA-Platform": '"macOS"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
};

const DEFAULT_BOOTSTRAP_URL =
  "https://www.goofish.com/search?q=openclaw%E5%AE%89%E8%A3%85%E9%83%A8%E7%BD%B2&spm=a21ybx.search.searchInput.0";

const DEFAULT_SEARCH_REFERER =
  "https://www.goofish.com/search?spm=a21ybx.home.searchHistory.1.4c053da6MZkdTF&q=openclaw%E5%AE%89%E8%A3%85%E9%83%A8%E7%BD%B2";

function setCookieHeadersToPairs(setCookieHeader) {
  if (setCookieHeader == null) return [];
  const lines = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : [setCookieHeader];
  const pairs = [];
  for (const line of lines) {
    const first = String(line).split(";")[0].trim();
    if (first.includes("=")) pairs.push(first);
  }
  return pairs;
}

function mergeCookieHeader(existing, newPairs) {
  const map = new Map();
  for (const part of String(existing || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const i = part.indexOf("=");
    if (i > 0) map.set(part.slice(0, i), part.slice(i + 1));
  }
  for (const part of newPairs) {
    const i = part.indexOf("=");
    if (i > 0) map.set(part.slice(0, i), part.slice(i + 1));
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

/**
 * 将 MTOP / 闲鱼接口响应头里的 Set-Cookie 合并进请求时带的 Cookie 串（与浏览器行为一致，刷新 _m_h5_tk 等）。
 * @param {string} requestCookieHeader
 * @param {Record<string, unknown>} headers
 */
function mergeSetCookieFromMtopResponse(requestCookieHeader, headers) {
  const c = sanitizeCookieString(requestCookieHeader);
  if (!headers || typeof headers !== "object") return c;
  const raw = headers["set-cookie"];
  const pairs = setCookieHeadersToPairs(raw);
  if (!pairs.length) return c;
  return sanitizeCookieString(mergeCookieHeader(c, pairs));
}

function cookieHeaderHasMh5Tk(cookieHeader) {
  return /(?:^|;\s*)_m_h5_tk=/i.test(String(cookieHeader || ""));
}

function sanitizeCookieString(s) {
  return String(s || "")
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, "")
    .trim();
}

async function refreshCookieViaGoofishSearch(cookieHeader) {
  const c = sanitizeCookieString(cookieHeader);
  if (!c) return "";

  const url =
    sanitizeCookieString(
      process.env.XIANYU_GOOFISH_BOOTSTRAP_URL || DEFAULT_BOOTSTRAP_URL
    ) || DEFAULT_BOOTSTRAP_URL;

  const referer =
    sanitizeCookieString(
      process.env.XIANYU_GOOFISH_SEARCH_REFERER || DEFAULT_SEARCH_REFERER
    ) || DEFAULT_SEARCH_REFERER;

  const res = await httpAxios.get(url, {
    maxRedirects: 12,
    validateStatus: () => true,
    responseType: "text",
    headers: {
      ...CHROME_NAVIGATE_HEADERS,
      Referer: referer,
      Cookie: c,
    },
  });

  const pairs = setCookieHeadersToPairs(res.headers["set-cookie"]);
  return sanitizeCookieString(mergeCookieHeader(c, pairs));
}

async function getWithCookiesCold(url, cookieHeader) {
  const res = await httpAxios.get(url, {
    maxRedirects: 12,
    validateStatus: () => true,
    responseType: "text",
    headers: {
      ...CHROME_NAVIGATE_HEADERS,
      Referer: "https://www.goofish.com/",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
  });
  const pairs = setCookieHeadersToPairs(res.headers["set-cookie"]);
  const merged = mergeCookieHeader(cookieHeader, pairs);
  return { statusCode: res.status, cookieHeader: sanitizeCookieString(merged) };
}

async function fetchGoofishCookieViaSearchPage() {
  const url =
    sanitizeCookieString(
      process.env.XIANYU_GOOFISH_BOOTSTRAP_URL || DEFAULT_BOOTSTRAP_URL
    ) || DEFAULT_BOOTSTRAP_URL;

  let { cookieHeader } = await getWithCookiesCold(url, "");
  if (!cookieHeaderHasMh5Tk(cookieHeader)) {
    const second = await getWithCookiesCold("https://www.goofish.com/", cookieHeader);
    cookieHeader = second.cookieHeader;
  }
  return cookieHeader;
}

module.exports = {
  refreshCookieViaGoofishSearch,
  fetchGoofishCookieViaSearchPage,
  cookieHeaderHasMh5Tk,
  mergeCookieHeader,
  mergeSetCookieFromMtopResponse,
  DEFAULT_BOOTSTRAP_URL,
  DEFAULT_SEARCH_REFERER,
};
