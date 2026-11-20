(() => {
  if (window.__pcAdspowerLoaded) return;
  window.__pcAdspowerLoaded = true;

  const LEAK_WORDS = [
    '目标价', '参考价', '公司底价', '成本底线', '底价', '提成', '毛利',
    '加价上限', '授权上限', '最高上限', '到手刀', '二次议价', '加微信', '微信号', '退差价',
    '申请小二介入', '点小二介入', '闲鱼小法庭', '法庭见', '投诉你到底', '跟你死磕',
  ];
  const EXT_ORIGIN = chrome.runtime.getURL('').replace(/\/$/, '');

  let isOpen = true;
  let copilotIframe = null;
  let waitTickSec = 0;
  let paramsState = {
    sellerPriceText: '待识别',
    refPriceText: '连工作台同步',
    ceilingText: '连工作台同步',
    preCommText: '10%自动算',
    paused: false,
    title: '',
    seller: '',
    snapImgCount: 0,
  };

  function isImPage() {
    return (
      location.pathname.includes('/im') ||
      Boolean(document.querySelector('#conv-list-scrollable, main[class*="chat-main--"], #message-list-scrollable'))
    );
  }

  function applyOpenClass() {
    document.documentElement.classList.toggle('pc-adspower-open', isOpen);
  }

  async function syncLatestSnapshotFromStorage() {
    try {
      const st = await chrome.storage.local.get(['pcLatestSnapshot']);
      if (st?.pcLatestSnapshot && window.__pcSnapshotUI) {
        window.__pcSnapshotUI.setSnapshot(st.pcLatestSnapshot);
        paramsState.snapImgCount = (st.pcLatestSnapshot.images || []).length;
        syncParamsDom();
      }
    } catch {
      // ignore
    }
  }

  function readActiveChatContext() {
    const activeConv = document.querySelector('[class*="conversation-item-active--"], .conversation-item.active');
    const headerTitle = document.querySelector('[class*="chat-header--"] [class*="title"], [class*="item-title--"], [class*="goods-title--"]');
    const priceEl = document.querySelector('[class*="goods-price--"], [class*="price--"]');
    const sellerEl = document.querySelector('[class*="nick--"], [class*="user-name--"], [class*="seller-name--"]');

    const rawText = (activeConv?.innerText || '').trim();
    const lines = rawText.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    const title = (headerTitle?.innerText || lines[1] || document.title || '闲鱼聊天窗口').trim().slice(0, 80);
    const seller = (sellerEl?.innerText || lines[0] || '当前闲鱼卖家').trim().slice(0, 40);
    const priceMatch = (priceEl?.innerText || rawText).match(/¥\s*([0-9]+(?:\.[0-9]+)?)/);
    paramsState.title = title;
    paramsState.seller = seller;
    paramsState.sellerPriceText = priceMatch ? `¥${priceMatch[1]}` : '以聊天页为准';
    syncParamsDom();
    postContextToSidebar();
  }

  function postContextToSidebar() {
    if (!copilotIframe?.contentWindow) return;
    copilotIframe.contentWindow.postMessage(
      {
        type: 'GOOFISH_CONTEXT',
        payload: {
          url: location.href,
          title: paramsState.title,
          seller: paramsState.seller,
          sellerPriceText: paramsState.sellerPriceText,
          paused: paramsState.paused,
        },
      },
      EXT_ORIGIN
    );
  }

  function injectLauncherAndDrawer() {
    if (!document.body) return;

    if (!document.getElementById('pc-adspower-launcher')) {
      const btn = document.createElement('button');
      btn.id = 'pc-adspower-launcher';
      btn.type = 'button';
      btn.innerHTML = '<span style="background:#FFDA00;color:#111827;padding:2px 7px;border-radius:999px;font-size:11px">v5.0</span> 打开采购 Copilot';
      btn.addEventListener('click', () => {
        isOpen = true;
        applyOpenClass();
      });
      document.body.appendChild(btn);
    }

    if (!document.getElementById('pc-adspower-copilot-host')) {
      const host = document.createElement('div');
      host.id = 'pc-adspower-copilot-host';
      const iframe = document.createElement('iframe');
      iframe.src = chrome.runtime.getURL('sidebar.html');
      iframe.title = '采购 Copilot v5.0 · 闲鱼四Dock助手';
      iframe.addEventListener('load', () => postContextToSidebar());
      copilotIframe = iframe;
      host.appendChild(iframe);
      document.body.appendChild(host);
    }

    if (!document.getElementById('pc-adspower-leak-banner')) {
      const warn = document.createElement('div');
      warn.id = 'pc-adspower-leak-banner';
      document.body.appendChild(warn);
    }

    applyOpenClass();
  }

  function injectFiltersBar() {
    if (!isImPage()) return;
    const convList = document.querySelector('#conv-list-scrollable, aside[class*="conversation-list--"]');
    if (!convList || document.getElementById('pc-adspower-filters')) return;

    const wrap = document.createElement('div');
    wrap.id = 'pc-adspower-filters';
    const shadow = wrap.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      .bar { padding: 10px 10px 8px; background: #ffffff; border-bottom: 1px solid #e5e7eb; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; }
      .hd { display: flex; justify-content: space-between; align-items: center; font-size: 11.5px; font-weight: 800; color: #111827; margin-bottom: 7px; }
      .hd span { color: #6b7280; font-weight: 600; font-size: 11px; }
      .row { display: flex; flex-wrap: wrap; gap: 5px; }
      button { border: 1px solid #e5e7eb; background: #f9fafb; color: #374151; border-radius: 999px; padding: 4px 9px; font-size: 11.5px; cursor: pointer; font-weight: 700; transition: all .14s; }
      button:hover { border-color: #d1d5db; background: #f3f4f6; }
      button.active { background: #111827; color: #ffffff; border-color: #111827; }
    `;
    const bar = document.createElement('div');
    bar.className = 'bar';
    const hd = document.createElement('div');
    hd.className = 'hd';
    hd.innerHTML = '<b>采购筛选</b><span>1小时内含前10分钟</span>';
    const row = document.createElement('div');
    row.className = 'row';

    const items = [
      { k: 'all', t: '全部' },
      { k: '10m', t: '10分钟内' },
      { k: '1h', t: '1小时内' },
      { k: 'slow', t: '慢慢压价' },
      { k: 'fav', t: '★ 收藏' },
    ];
    items.forEach((it, idx) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = it.t;
      if (idx === 0) b.className = 'active';
      b.addEventListener('click', () => {
        row.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        filterGoofishRows(it.k);
      });
      row.appendChild(b);
    });

    bar.append(hd, row);
    shadow.append(style, bar);
    convList.parentElement?.insertBefore(wrap, convList);
  }

  function decorateRowCountdowns() {
    if (!isImPage()) return;
    const rows = document.querySelectorAll('[class*="conversation-item--"]');
    rows.forEach((r, idx) => {
      let badge = r.querySelector('.pc-row-wait-badge');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'pc-row-wait-badge';
        badge.dataset.baseSec = String(24 + (idx % 5) * 19);
        const nameEl = r.querySelector('[class*="name--"], [class*="nick--"]') || r.firstElementChild;
        nameEl?.appendChild(badge);
      }
      const sec = Number(badge.dataset.baseSec || 30) + waitTickSec;
      badge.textContent = `等待 ${sec}秒`;
      badge.classList.toggle('hot', sec >= 60);
    });
  }

  function filterGoofishRows(kind) {
    const rows = document.querySelectorAll('[class*="conversation-item--"]');
    rows.forEach((r) => {
      const txt = r.innerText || '';
      if (kind === 'all') {
        r.style.display = '';
      } else if (kind === 'slow') {
        r.style.display = r.dataset.pcSlow === '1' || /不急|慢慢|挂着/.test(txt) ? '' : 'none';
      } else if (kind === 'fav') {
        r.style.display = r.dataset.pcFav === '1' || /★/.test(txt) ? '' : 'none';
      } else if (kind === '10m') {
        r.style.display = /刚刚|秒|分钟/.test(txt) || !/天前|昨天/.test(txt) ? '' : 'none';
      } else {
        r.style.display = !/天前/.test(txt) ? '' : 'none';
      }
    });
  }

  let paramShadow = null;

  function syncParamsDom() {
    if (!paramShadow) return;
    const setTxt = (id, val) => {
      const el = paramShadow.getElementById(id);
      if (el) el.textContent = val;
    };
    setTxt('pc-ref-p', paramsState.refPriceText);
    setTxt('pc-seller-p', paramsState.sellerPriceText);
    setTxt('pc-ceiling-p', paramsState.ceilingText);
    setTxt('pc-precomm-p', paramsState.preCommText);
    const snapBtn = paramShadow.getElementById('pc-snap-btn');
    if (snapBtn) {
      snapBtn.textContent = paramsState.snapImgCount > 0 ? `🔍 查看快照大图 (${paramsState.snapImgCount}张)` : '🔍 查看商品快照大图';
    }
    const tEl = paramShadow.getElementById('pc-pause-btn');
    if (tEl) {
      tEl.textContent = paramsState.paused ? '▶ 恢复自动议价' : '⏸ 暂停自动';
      tEl.className = paramsState.paused ? 'btn-ok' : 'btn-outline';
    }
  }

  function injectTopParamsBar() {
    if (!isImPage()) return;
    const chatMain = document.querySelector('main[class*="chat-main--"], #message-list-scrollable')?.parentElement;
    if (!chatMain || document.getElementById('pc-adspower-parameters')) return;

    const host = document.createElement('div');
    host.id = 'pc-adspower-parameters';
    paramShadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      .strip { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; padding: 10px 14px; background: #ffffff; border-bottom: 1px solid #e5e7eb; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; }
      .metrics { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; font-variant-numeric: tabular-nums; }
      .m { display: grid; gap: 1px; }
      .k { font-size: 11px; color: #6b7280; font-weight: 600; }
      .v { font-size: 14px; font-weight: 800; color: #111827; }
      .v.blue { color: #2563eb; }
      .v.grn { color: #059669; }
      .btns { display: flex; gap: 7px; flex-wrap: wrap; align-items: center; }
      button { border: 1px solid #e5e7eb; border-radius: 9px; padding: 6px 11px; font-size: 12px; font-weight: 700; cursor: pointer; background: #ffffff; color: #111827; }
      .btn-yellow { background: #ffda00; border-color: #f5cc00; color: #111827; font-weight: 800; }
      .btn-outline { background: #f9fafb; color: #111827; }
      .btn-ok { background: #059669; border-color: #059669; color: #ffffff; }
      .btn-dark { background: #111827; border-color: #111827; color: #ffffff; }
    `;
    const strip = document.createElement('div');
    strip.className = 'strip';
    strip.innerHTML = `
      <div class="metrics">
        <div class="m"><span class="k">公司参考价</span><span id="pc-ref-p" class="v">${paramsState.refPriceText}</span></div>
        <div class="m"><span class="k">闲鱼当前价</span><span id="pc-seller-p" class="v">${paramsState.sellerPriceText}</span></div>
        <div class="m"><span class="k">最高出价上限</span><span id="pc-ceiling-p" class="v blue">${paramsState.ceilingText}</span></div>
        <div class="m"><span class="k">买前10%预计提成</span><span id="pc-precomm-p" class="v grn">${paramsState.preCommText}</span></div>
      </div>
      <div class="btns">
        <button id="pc-snap-btn" type="button" class="btn-yellow">🔍 查看商品快照大图</button>
        <button id="pc-pause-btn" type="button" class="btn-outline">⏸ 暂停自动</button>
        <button id="pc-expand-btn" type="button" class="btn-dark">↗ 完整工作台</button>
      </div>
    `;
    paramShadow.append(style, strip);

    paramShadow.getElementById('pc-snap-btn')?.addEventListener('click', () => {
      window.__pcSnapshotUI?.openLightbox();
    });
    paramShadow.getElementById('pc-pause-btn')?.addEventListener('click', () => {
      paramsState.paused = !paramsState.paused;
      syncParamsDom();
      postContextToSidebar();
    });
    paramShadow.getElementById('pc-expand-btn')?.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'OPEN_WORKBENCH', hash: '#/today' });
    });

    chatMain.prepend(host);
  }

  function findChatInput() {
    const selectors = ['textarea', '[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]'];
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  function getInputValue(el) {
    if (!el) return '';
    return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? el.value : el.innerText || '';
  }

  function setInputValue(el, text) {
    if (!el) return false;
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      el.value = text;
    } else {
      el.textContent = text;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function checkLeakGuard() {
    const banner = document.getElementById('pc-adspower-leak-banner');
    if (!banner) return;
    const el = findChatInput();
    const val = getInputValue(el);
    const hit = LEAK_WORDS.find((w) => val.includes(w));
    if (hit) {
      banner.textContent = `🛑 防泄密/防封号拦截：输入框含敏感词「${hit}」（暴露底价或触发闲鱼封号），请删除后再发！`;
      banner.classList.add('visible');
    } else {
      banner.classList.remove('visible');
    }
  }

  document.addEventListener('input', checkLeakGuard, true);
  document.addEventListener('click', () => setTimeout(readActiveChatContext, 120), true);

  window.addEventListener('message', (e) => {
    if (!copilotIframe || e.source !== copilotIframe.contentWindow || e.origin !== EXT_ORIGIN) return;
    const { type, payload } = e.data || {};
    if (type === 'CLOSE_COPILOT') {
      isOpen = false;
      applyOpenClass();
    } else if (type === 'FILL_GOOFISH_INPUT') {
      const ok = setInputValue(findChatInput(), String(payload?.text || ''));
      checkLeakGuard();
      if (!ok) {
        navigator.clipboard?.writeText(String(payload?.text || '')).catch(() => {});
      }
    } else if (type === 'SYNC_CEILING' && payload) {
      if (payload.ceilingText) paramsState.ceilingText = payload.ceilingText;
      if (payload.refPriceText) paramsState.refPriceText = payload.refPriceText;
      if (payload.preCommText) paramsState.preCommText = payload.preCommText;
      if (payload.snapshot && window.__pcSnapshotUI) {
        window.__pcSnapshotUI.setSnapshot(payload.snapshot);
        paramsState.snapImgCount = (payload.snapshot.images || []).length;
      }
      syncParamsDom();
    } else if (type === 'OPEN_SNAPSHOT_MODAL') {
      window.__pcSnapshotUI?.openLightbox(payload?.snapshot);
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'TOGGLE_COPILOT') {
      isOpen = !isOpen;
      applyOpenClass();
      sendResponse({ ok: true, open: isOpen });
    }
  });

  setInterval(() => {
    waitTickSec += 1;
    decorateRowCountdowns();
  }, 1000);

  function mountAll() {
    injectLauncherAndDrawer();
    injectFiltersBar();
    injectTopParamsBar();
    decorateRowCountdowns();
    syncLatestSnapshotFromStorage();
    readActiveChatContext();
  }

  mountAll();
  const observer = new MutationObserver(() => {
    injectFiltersBar();
    injectTopParamsBar();
  });
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }
})();
