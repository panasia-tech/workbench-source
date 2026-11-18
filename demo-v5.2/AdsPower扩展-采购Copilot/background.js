const DEFAULT_SERVER = 'http://127.0.0.1:5360';

async function getServerUrl() {
  try {
    const res = await chrome.storage.local.get(['workbenchUrl']);
    return (res.workbenchUrl || DEFAULT_SERVER).replace(/\/+$/, '');
  } catch {
    return DEFAULT_SERVER;
  }
}

async function callLocalApi(method, path, body) {
  const base = await getServerUrl();
  const url = `${base}${path.startsWith('/') ? path : '/' + path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const opts = {
      method: method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    };
    if (body && method !== 'GET') {
      opts.body = JSON.stringify(body);
    }
    const resp = await fetch(url, opts);
    const data = await resp.json().catch(() => ({}));
    clearTimeout(timer);
    return { ok: resp.ok, online: true, status: resp.status, data };
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      online: false,
      status: 0,
      error: err?.name === 'AbortError' ? '连接本地工作台超时' : String(err?.message || err),
    };
  }
}

async function openFullWorkbench(hash) {
  const base = await getServerUrl();
  const cleanHash = hash ? (hash.startsWith('#') ? hash : '#' + hash) : '#/cases';
  const targetUrl = `${base}/${cleanHash}`;
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => t.url && t.url.startsWith(base));
  if (existing && existing.id != null) {
    await chrome.tabs.update(existing.id, { url: targetUrl, active: true });
    if (existing.windowId != null) {
      await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
    }
    return { ok: true, reused: true, url: targetUrl };
  }
  const created = await chrome.tabs.create({ url: targetUrl, active: true });
  return { ok: true, reused: false, tabId: created.id, url: targetUrl };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  if (msg.type === 'COPILOT_API') {
    callLocalApi(msg.method, msg.path, msg.body).then(sendResponse);
    return true;
  }

  if (msg.type === 'OPEN_WORKBENCH') {
    openFullWorkbench(msg.hash).then(sendResponse);
    return true;
  }

  if (msg.type === 'SAVE_SERVER_URL') {
    const clean = String(msg.url || DEFAULT_SERVER).replace(/\/+$/, '');
    chrome.storage.local.set({ workbenchUrl: clean }).then(() => sendResponse({ ok: true, url: clean }));
    return true;
  }

  if (msg.type === 'GET_SERVER_URL') {
    getServerUrl().then((url) => sendResponse({ ok: true, url }));
    return true;
  }

  return false;
});
