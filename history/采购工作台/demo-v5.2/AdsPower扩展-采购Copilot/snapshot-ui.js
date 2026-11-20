(() => {
  if (window.__pcSnapshotUI) return;

  let activeSnap = {
    version_no: 1,
    title_raw: '等待匹配闲鱼商品快照',
    quality_raw: '买前原始描述自动留底',
    specs_raw: '打开商品详情页即自动存档最多10张原图',
    description_raw: '买前若卖家标称「几乎全新」或照片模糊，请勿追问划痕成色，直接按链接标准拍下并给赵仓管打重点深检标。',
    asking_price_text: '—',
    images: [],
  };

  let lightboxEl = null;
  let activeImgIdx = 0;

  function ensureLightbox() {
    if (lightboxEl) return lightboxEl;
    const dlg = document.createElement('dialog');
    dlg.id = 'pc-snap-lightbox';
    dlg.style.cssText =
      'border:0;border-radius:18px;padding:0;max-width:740px;width:92vw;background:#fff;color:#111827;' +
      'box-shadow:0 24px 60px rgba(15,23,42,.32);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;';
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close();
    });
    document.body.appendChild(dlg);
    lightboxEl = dlg;
    return dlg;
  }

  function renderLightbox() {
    const dlg = ensureLightbox();
    const imgs = activeSnap.images || [];
    const curImg = imgs[activeImgIdx] || '';

    dlg.innerHTML = `
      <div style="padding:20px;display:grid;gap:14px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
          <div>
            <span style="background:#FFDA00;color:#111827;font-weight:800;font-size:11.5px;padding:3px 8px;border-radius:6px">
              📸 买前锁死商品快照 v${activeSnap.version_no || 1}
            </span>
            <div style="font-size:16px;font-weight:800;margin-top:6px">${escapeHtml(activeSnap.title_raw)}</div>
          </div>
          <button id="pc-lb-close" type="button" style="border:1px solid #E5E7EB;background:#F9FAFB;border-radius:9px;padding:6px 12px;font-size:13px;font-weight:700;cursor:pointer">✕ 关闭</button>
        </div>
        <div style="background:#0F172A;border-radius:12px;height:360px;display:grid;place-items:center;overflow:hidden">
          ${
            curImg
              ? `<img src="${escapeAttr(curImg)}" alt="快照原图" style="max-height:350px;max-width:100%;object-fit:contain" />`
              : `<div style="color:#94A3B8;font-size:13.5px">先点开一次闲鱼商品详情页，即可自动抓取最多 10 张高清原图</div>`
          }
        </div>
        ${
          imgs.length > 1
            ? `<div style="display:flex;gap:8px;flex-wrap:wrap" id="pc-lb-thumbs">
                ${imgs
                  .map(
                    (u, i) => `
                  <button type="button" data-idx="${i}" style="border:2px solid ${
                      i === activeImgIdx ? '#2563EB' : '#E5E7EB'
                    };background:${
                      i === activeImgIdx ? '#EFF6FF' : '#F9FAFB'
                    };border-radius:9px;padding:3px 8px 3px 3px;display:inline-flex;align-items:center;gap:6px;cursor:pointer">
                    <img src="${escapeAttr(u)}" style="width:40px;height:40px;border-radius:6px;object-fit:cover" />
                    <span style="font-size:12px;font-weight:700;color:#111827">图 ${i + 1}</span>
                  </button>`
                  )
                  .join('')}
              </div>`
            : ''
        }
        <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;padding:12px 14px;display:grid;gap:6px;font-size:13px;line-height:1.5">
          <div><b>原挂牌价：</b>${escapeHtml(activeSnap.asking_price_text || '—')} · <b>标称成色：</b>${escapeHtml(activeSnap.quality_raw || '—')}</div>
          <div><b>规格摘要：</b>${escapeHtml(activeSnap.specs_raw || '—')}</div>
          <div><b>卖家原始描述存档：</b>${escapeHtml(activeSnap.description_raw || '—')}</div>
        </div>
      </div>
    `;
    dlg.querySelector('#pc-lb-close')?.addEventListener('click', () => dlg.close());
    dlg.querySelectorAll('#pc-lb-thumbs button').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeImgIdx = Number(btn.getAttribute('data-idx') || 0);
        renderLightbox();
      });
    });
  }

  function openLightbox(snapOverride) {
    if (snapOverride && typeof snapOverride === 'object') {
      activeSnap = { ...activeSnap, ...snapOverride };
    }
    activeImgIdx = 0;
    renderLightbox();
    const dlg = ensureLightbox();
    if (!dlg.open) dlg.showModal();
  }

  function setSnapshot(snap) {
    if (!snap || typeof snap !== 'object') return;
    activeSnap = { ...activeSnap, ...snap };
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(s) {
    return escapeHtml(s);
  }

  window.__pcSnapshotUI = {
    setSnapshot,
    openLightbox,
    getSnapshot: () => activeSnap,
  };
})();
