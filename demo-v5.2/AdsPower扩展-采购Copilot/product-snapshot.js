(() => {
  if (window.__pcProductSnapshotLoaded) return;
  window.__pcProductSnapshotLoaded = true;

  function extractProductId(urlStr) {
    try {
      const u = new URL(urlStr || location.href);
      return u.searchParams.get('id') || u.searchParams.get('itemId') || '';
    } catch {
      return '';
    }
  }

  function cleanImgUrl(raw) {
    if (!raw || typeof raw !== 'string') return '';
    if (raw.startsWith('data:')) return '';
    let u = raw.startsWith('//') ? `https:${raw}` : raw;
    u = u.replace(/_\d+x\d+[a-z0-9_.]*$/i, '');
    return u;
  }

  function captureGoofishItemPage() {
    if (!location.pathname.includes('/item')) return null;
    const productId = extractProductId(location.href);
    if (!productId) return null;

    const titleEl = document.querySelector('h1, [class*="title--"], [class*="desc--"]');
    const descEl = document.querySelector('[class*="desc--"], [class*="detail-desc"], article');
    const priceEl = document.querySelector('[class*="price--"], [class*="num--"]');
    const specEls = Array.from(document.querySelectorAll('[class*="param--"], [class*="tag--"], [class*="label--"]'));

    const imgs = [];
    const seen = new Set();
    document.querySelectorAll('img').forEach((img) => {
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w > 0 && w < 120 && h > 0 && h < 120) return;
      const src = cleanImgUrl(img.currentSrc || img.src || '');
      if (!src || seen.has(src)) return;
      if (/avatar|icon|logo|badge|emoji/i.test(src)) return;
      seen.add(src);
      imgs.push(src);
    });

    const titleRaw = (titleEl?.innerText || document.title || `闲鱼商品 ${productId}`).trim().slice(0, 120);
    const descRaw = (descEl?.innerText || titleRaw).trim().slice(0, 600);
    const askingPriceText = (priceEl?.innerText || '').match(/[¥￥]?\s*\d+(?:\.\d+)?/)?.[0] || '以页面为准';
    const specsText = specEls.map((el) => (el.innerText || '').trim()).filter(Boolean).slice(0, 6).join(' / ');
    const qualityRaw = /几乎全新|99新|98新|95新|全新/.exec(`${titleRaw} ${descRaw} ${specsText}`)?.[0] || '以原始描述为准';

    return {
      product_id: productId,
      source_url: location.href,
      title_raw: titleRaw,
      description_raw: descRaw,
      quality_raw: qualityRaw,
      specs_raw: specsText || '原页面规格快照',
      asking_price_text: askingPriceText.startsWith('¥') ? askingPriceText : `¥${askingPriceText.replace(/[￥\s]/g, '')}`,
      images: imgs.slice(0, 10),
      captured_at: new Date().toISOString(),
    };
  }

  function showCaptureToast(snap, ver) {
    let pill = document.getElementById('pc-item-snap-toast');
    if (!pill) {
      pill = document.createElement('div');
      pill.id = 'pc-item-snap-toast';
      pill.style.cssText =
        'position:fixed;top:16px;right:16px;z-index:2147483000;background:#111827;color:#fff;padding:10px 14px;' +
        'border-radius:12px;box-shadow:0 12px 28px rgba(17,24,39,.24);font:600 13px/1.4 -apple-system,"PingFang SC",sans-serif;' +
        'display:flex;align-items:center;gap:8px;border:1px solid rgba(255,218,0,.45);';
      document.body.appendChild(pill);
    }
    pill.innerHTML =
      `<span style="background:#FFDA00;color:#111827;font-weight:800;font-size:11px;padding:2px 7px;border-radius:6px">采购Copilot</span>` +
      `<span>已锁死买前快照 v${ver}（${snap.images.length} 张原图 · 写『${snap.quality_raw}』别多嘴追问）</span>`;
  }

  async function runCaptureOnce() {
    const snap = captureGoofishItemPage();
    if (!snap || snap.images.length === 0) return;

    try {
      const storeRes = await chrome.storage.local.get(['pcSnapshotsByProductId']);
      const map = storeRes.pcSnapshotsByProductId || {};
      const prev = map[snap.product_id];
      const sig = `${snap.title_raw}|${snap.asking_price_text}|${snap.images.length}`;
      if (prev && prev._sig === sig) return;
      const nextVer = (prev?.version_no || 0) + 1;
      snap.version_no = nextVer;
      snap._sig = sig;
      map[snap.product_id] = snap;
      await chrome.storage.local.set({ pcSnapshotsByProductId: map, pcLatestSnapshot: snap });
      chrome.runtime.sendMessage({
        type: 'COPILOT_API',
        method: 'POST',
        path: '/api/snapshots/save',
        body: { actor_id: 'liming', ...snap },
      });
      showCaptureToast(snap, nextVer);
    } catch {
      // ignore storage errors in restricted contexts
    }
  }

  if (location.pathname.includes('/item')) {
    setTimeout(runCaptureOnce, 1200);
    setTimeout(runCaptureOnce, 3200);
  }
})();
