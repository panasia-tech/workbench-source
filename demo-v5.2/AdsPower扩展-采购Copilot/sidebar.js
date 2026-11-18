(() => {
  let dash = null;
  let curConvId = 'CONV-001';
  let curCaseId = 'CASE-011';
  let curAnchorCode = 'P3';

  const $ = (id) => document.getElementById(id);

  function showToast(msg) {
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function fmtY(cents) {
    return '¥' + Math.round(Number(cents || 0) / 100).toLocaleString('zh-CN');
  }

  function resolveImgUrl(raw) {
    if (!raw) return '';
    if (raw.startsWith('http') || raw.startsWith('data:')) return raw;
    const clean = raw.replace(/^\.\//, '');
    return `http://127.0.0.1:5360/${clean}`;
  }

  async function callApi(method, path, body) {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id && chrome.runtime.sendMessage) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'COPILOT_API', method, path, body }, (resp) => {
          resolve(resp || { ok: false });
        });
      });
    }
    try {
      const opts = { method: method || 'GET', headers: { 'Content-Type': 'application/json' } };
      if (body && method !== 'GET') opts.body = JSON.stringify(body);
      const r = await fetch(`http://127.0.0.1:5360${path}`, opts);
      const data = await r.json();
      return { ok: r.ok, online: true, data };
    } catch (e) {
      return { ok: false, online: false, error: String(e) };
    }
  }

  function openFullWorkbench(hash) {
    const h = hash || '#/today';
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: 'OPEN_WORKBENCH', hash: h });
    } else {
      window.open(`http://127.0.0.1:5360/${h}`, '_blank');
    }
  }

  function postToParent(type, payload) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type, payload }, '*');
      }
    } catch {
      // ignore cross-frame errors
    }
  }

  async function copyAndFill(text, label) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // fallback
    }
    postToParent('FILL_GOOFISH_INPUT', { text });
    showToast(label || '已复制并填入输入框！');
  }

  async function loadDashboard() {
    const res = await callApi('GET', '/api/dashboard');
    const dot = $('conn-dot');
    const txt = $('conn-text');
    if (res.ok && res.data?.data) {
      dash = res.data.data;
      dot?.classList.remove('off');
      if (txt) txt.textContent = '已连工作台 :5360';
      renderAll();
    } else {
      dot?.classList.add('off');
      if (txt) txt.textContent = '离线模式';
    }
  }

  function getCurConv() {
    if (!dash?.conversations?.length) return null;
    return dash.conversations.find((c) => c.conv_id === curConvId) || dash.conversations[0];
  }

  function getIssueCases() {
    return (dash?.cases || []).filter((c) => c.order_bucket === 'issue' && c.ticket);
  }

  function getCurIssueCase() {
    const list = getIssueCases();
    return list.find((c) => c.case_id === curCaseId) || list[0] || null;
  }

  function renderSessionAndMarket() {
    const convs = dash?.conversations || [];
    const sel = $('conv-select');
    if (sel) {
      sel.innerHTML = convs
        .map(
          (c) =>
            `<option value="${c.conv_id}" ${c.conv_id === curConvId ? 'selected' : ''}>` +
            `${c.is_favorite_seller ? '★ ' : ''}${c.seller_name} · ${c.title.slice(0, 18)}` +
            `</option>`
        )
        .join('');
    }

    const cv = getCurConv();
    if (!cv) return;
    curConvId = cv.conv_id;

    // Snapshot strip
    const snap = cv.item_snapshot || {};
    const imgs = (snap.images?.length ? snap.images : cv.evidence_urls || ['./evidence/IMG_5878.PNG']).map(resolveImgUrl);
    $('snap-thumb').src = imgs[0] || '';
    $('snap-title').textContent = snap.title_raw || cv.title;
    $('snap-sub').textContent = `${snap.quality_raw || '已锁死原话'} · 共 ${imgs.length} 张原图`;

    // Quick buttons state
    $('btn-fav-seller').textContent = cv.is_favorite_seller ? '★ 已收藏(团队)' : '☆ 收藏卖家';
    $('btn-slow-toggle').textContent = Number(cv.slow_group) === 1 ? '⏳ 已在慢压池' : '⏳ 移入慢慢压价';
    $('btn-pause-toggle').textContent = cv.pause_state === 'paused' ? '▶ 恢复自动' : '⏸ 暂停自动';

    // Sync ceiling & snapshot up to content.js top bar
    const basePrice = cv.agreed_price_cents || cv.target_price_cents || cv.seller_price_cents;
    const preComm = Math.max(0, Math.round(((cv.ref_price_cents - basePrice) * 0.10) / 100));
    postToParent('SYNC_CEILING', {
      refPriceText: fmtY(cv.ref_price_cents),
      ceilingText: fmtY(cv.ceiling_price_cents),
      preCommText: `¥${preComm}`,
      snapshot: { ...snap, images: imgs },
    });

    $('diff-ref-txt').textContent = `比参考价省 ${fmtY(Math.max(0, cv.ref_price_cents - basePrice))}`;
    $('pre-comm-txt').textContent = `买前10%预计 ¥${preComm}`;

    // 5% Refund & Dispute Redline Shield for current account
    const accts = dash?.account_risk_shield?.accounts || [];
    const curAcct = accts.find((a) => a.account_id === cv.account_id || a.account_label.includes(cv.account_id)) || accts[0];
    const riskEl = $('acct-risk-txt');
    const riskCard = $('acct-risk-card');
    if (curAcct && riskEl && riskCard) {
      riskEl.innerHTML =
        `<b>${curAcct.account_id}</b>：退款率 <b>${curAcct.refund_rate_pct}%</b> · 纠纷率 <b>${curAcct.dispute_rate_pct}%</b>（红线≤5.0%，剩 ${curAcct.remaining_refund_quota} 单缓冲）<br/>` +
        `<span style="color:${curAcct.risk_level === 'grn' ? '#047857' : '#b45309'}">${curAcct.status_badge} · 非必要禁扯皮/禁点小二介入！</span>`;
      riskCard.style.background = curAcct.risk_level === 'grn' ? '#ecfdf5' : '#fffbeb';
      riskCard.style.borderColor = curAcct.risk_level === 'grn' ? '#10b981' : '#f59e0b';
    }

    // Render SVG bilateral quote chart
    const rds = (dash.negotiation_rounds || []).filter((r) => r.conv_id === cv.conv_id);
    const svgBox = $('svg-chart-box');
    if (rds.length > 0 && svgBox) {
      const vals = [...rds.map((r) => Number(r.quote_cents)), Number(cv.ceiling_price_cents), Number(cv.target_price_cents)].filter((v) => v > 0);
      const minV = Math.min(...vals) * 0.96;
      const maxV = Math.max(...vals) * 1.03;
      const span = Math.max(1000, maxV - minV);
      const toY = (v) => Math.round(98 - ((v - minV) / span) * 76);
      const stepX = rds.length === 1 ? 0 : 236 / (rds.length - 1);
      const pts = rds.map((r, i) => {
        const isSeller = /卖|挂价/.test(`${r.round_label}${r.verdict}`);
        return { x: Math.round(28 + i * stepX), y: toY(Number(r.quote_cents)), c: Number(r.quote_cents), isSeller };
      });
      const sLine = pts.filter((p) => p.isSeller).map((p) => `${p.x},${p.y}`).join(' ');
      const bLine = pts.filter((p) => !p.isSeller).map((p) => `${p.x},${p.y}`).join(' ');
      const ceilY = toY(Number(cv.ceiling_price_cents));

      svgBox.innerHTML = `
        <svg viewBox="0 0 292 114" style="width:100%;height:112px;display:block">
          <line x1="14" y1="${ceilY}" x2="278" y2="${ceilY}" stroke="#dc2626" stroke-width="1.2" stroke-dasharray="4 3" />
          ${sLine ? `<polyline points="${sLine}" fill="none" stroke="#f97316" stroke-width="2.2" stroke-linecap="round" />` : ''}
          ${bLine ? `<polyline points="${bLine}" fill="none" stroke="#2563eb" stroke-width="2.2" stroke-linecap="round" />` : ''}
          ${pts
            .map(
              (p) => `
            <circle cx="${p.x}" cy="${p.y}" r="3.8" fill="${p.isSeller ? '#f97316' : '#2563eb'}" />
            <text x="${p.x}" y="${p.isSeller ? Math.max(11, p.y - 6) : Math.min(110, p.y + 12)}" text-anchor="middle" font-size="9.5" font-weight="700" fill="${p.isSeller ? '#c2410c' : '#1d4ed8'}">¥${Math.round(p.c / 100)}</text>`
            )
            .join('')}
        </svg>
      `;
    }

    // Safe buyer templates
    const fY = Math.round(cv.first_offer_cents / 100);
    const tY = Math.round(cv.target_price_cents / 100);
    const tpls = [
      { t: `① 首轮诚心试探（报 ¥${fY}）`, s: `老板你好，诚心想收这台，功能正常无拆修的话，${fY} 元包顺丰保价能出吗？合适我现在直接拍。` },
      { t: `② 目标价促成改价（报 ¥${tY}）`, s: `理解哥，我再加一点凑个实在数 ${tY} 元，到货当天验完秒确认收货绝不墨迹，改好链接标价我秒付！` },
      { t: '③ 只核序列号（不追问成色留底牌）', s: '老板麻烦把机器背面铭牌或关于本机序列号拍清楚发我核对下保修哈，核对完马上拍下付款！' },
    ];
    const tplBox = $('safe-tpl-list');
    if (tplBox) {
      tplBox.innerHTML = tpls
        .map(
          (x, i) => `
        <button type="button" class="tpl-btn" data-idx="${i}">
          <b>${x.t}</b>
          <small>${x.s}</small>
        </button>`
        )
        .join('');
      tplBox.querySelectorAll('.tpl-btn').forEach((b) => {
        b.addEventListener('click', () => {
          const item = tpls[Number(b.dataset.idx)];
          copyAndFill(item.s, `已填入：${item.t}`);
        });
      });
    }

    // Market Dock
    $('mkt-first').textContent = fmtY(cv.first_offer_cents);
    $('mkt-target').textContent = fmtY(cv.target_price_cents);
    $('mkt-ceil').textContent = fmtY(cv.ceiling_price_cents);
    $('mkt-ref').textContent = fmtY(cv.ref_price_cents);
    const stTag = $('mkt-status-tag');
    if (stTag) {
      stTag.textContent = cv.matched_status === 'conflict_pending' ? '⚠️ 规格冲突待核' : `✓ ${cv.model_code}`;
      stTag.className = cv.matched_status === 'conflict_pending' ? 'tag red' : 'tag acc';
    }

    const seenModels = new Set();
    const pubModels = (dash.pricebook || []).filter((p) => {
      if (p.status === 'archived' || seenModels.has(p.model_code)) return false;
      seenModels.add(p.model_code);
      return true;
    });
    const fixSel = $('fix-model-select');
    if (fixSel) {
      fixSel.innerHTML = pubModels
        .map(
          (m) =>
            `<option value="${m.model_code}" ${m.model_code === cv.model_code ? 'selected' : ''}>` +
            `${m.spec_label} (参考 ${fmtY(m.ref_price_cents)})</option>`
        )
        .join('');
    }

    const vers = (dash.pricebook || []).filter((p) => p.model_code === cv.model_code);
    const maxRef = Math.max(100000, ...vers.map((v) => Number(v.ref_price_cents || 0)));
    const verBox = $('ver-bars-box');
    if (verBox) {
      verBox.innerHTML = vers
        .map(
          (v) => `
        <div class="v-row">
          <span style="color:#6b7280">v${v.version_no} (${v.status === 'published' ? '现行' : '历史'})</span>
          <div class="v-bar"><i style="width:${Math.round((v.ref_price_cents / maxRef) * 100)}%"></i></div>
          <b>${fmtY(v.ref_price_cents)}</b>
        </div>`
        )
        .join('');
    }
  }

  function renderTicketsDock() {
    const list = getIssueCases();
    const sel = $('ticket-select');
    if (sel) {
      sel.innerHTML = list
        .map(
          (c) =>
            `<option value="${c.case_id}" ${c.case_id === curCaseId ? 'selected' : ''}>` +
            `${c.ticket.ticket_id} · ${c.title.slice(0, 20)}</option>`
        )
        .join('');
    }

    const ic = getCurIssueCase();
    if (!ic) return;
    curCaseId = ic.case_id;
    const bp = ic.bargain_plan || {};
    const track = bp.arrival_track || ic.step_progress?.arrival_track || 'sf_express_refuse';

    $('btn-track-sf').className = track === 'sf_express_refuse' ? 'btn pri' : 'btn';
    $('btn-track-signed').className = track === 'signed_platform_return' ? 'btn pri' : 'btn';
    $('tk-summary').textContent = `${ic.step_progress?.summary || ''} · ${ic.ticket.evidence_warehouse}`;
    $('tk-comm-tag').textContent = `到货10%预计 ${fmtY(bp.estimated_comm_cents || 0)}`;

    const coreList = [
      {
        t: '📞 零封号电联加微信话术',
        s: bp.psychology_arsenal?.safe_add_wechat?.phone_script || '',
      },
      {
        t: `🔪 50% 半价首刀（报“${Math.round((bp.half_price_keep_cents || 0) / 100)}可以接受”）`,
        s: bp.psychology_arsenal?.half_price_first_cut?.short_wechat_quote || '',
      },
      {
        t: '🎯 卖家急问少退点 → 假装毫不在意「不用啦，谢谢」',
        s: bp.psychology_arsenal?.indifferent_pushback?.step1_brush_off || '',
      },
      {
        t: '📝 微信防反水《四要素定案确认卡》',
        s: bp.psychology_arsenal?.wechat_4elem_lock?.script || '',
      },
    ];
    const coreBox = $('tk-core-scripts');
    if (coreBox) {
      coreBox.innerHTML = coreList
        .map(
          (x, i) => `
        <button type="button" class="tpl-btn" data-cidx="${i}">
          <b>${x.t}</b>
          <small>${x.s.slice(0, 68)}…</small>
        </button>`
        )
        .join('');
      coreBox.querySelectorAll('.tpl-btn').forEach((b) => {
        b.addEventListener('click', () => {
          const item = coreList[Number(b.dataset.cidx)];
          copyAndFill(item.s, `已复制：${item.t}`);
        });
      });
    }

    // 12 Psychology + Game Theory Anchors
    const anchors = [...(bp.psych_anchors || []), ...(bp.game_anchors || [])];
    const aSel = $('anchor-select');
    if (aSel && anchors.length) {
      if (!anchors.some((a) => a.code === curAnchorCode)) curAnchorCode = anchors[0].code;
      aSel.innerHTML = anchors
        .map(
          (a) =>
            `<option value="${a.code}" ${a.code === curAnchorCode ? 'selected' : ''}>` +
            `${a.code.startsWith('P') ? '🧠' : '♟️'} ${a.code} · ${a.name}</option>`
        )
        .join('');
      const picked = anchors.find((a) => a.code === curAnchorCode) || anchors[0];
      $('anchor-quote').textContent = picked.script;
    }
  }

  function renderEarningsDock() {
    const e = dash?.daily_earnings || {
      daily_target_cents: 100000,
      today_expected_cents: 0,
      remaining_to_target_cents: 100000,
      progress_pct: 0,
      confirmed_cents: 0,
      paid_cents: 0,
    };
    $('earn-target-lbl').textContent = `今日目标 ${fmtY(e.daily_target_cents)}`;
    $('earn-today-big').textContent = `¥${(e.today_expected_cents / 100).toFixed(2)}`;
    $('earn-bar-fill').style.width = `${e.progress_pct || 0}%`;
    $('earn-remain-lbl').textContent = `已完成 ${e.progress_pct}% · 距目标还差 ¥${(e.remaining_to_target_cents / 100).toFixed(2)}`;

    $('e-col-exp').textContent = `¥${Math.round(e.today_expected_cents / 100)}`;
    $('e-col-conf').textContent = `¥${Math.round(e.confirmed_cents / 100)}`;
    $('e-col-paid').textContent = `¥${Math.round(e.paid_cents / 100)}`;

    const stSum = dash?.statement_reconciliation?.summary;
    if (stSum) {
      const bEl = $('stmt-badge');
      const tEl = $('stmt-summary-txt');
      if (bEl) {
        bEl.textContent = stSum.all_clear ? '✓ 已抓全' : `漏抓 ${stSum.missing_count} 笔`;
        bEl.className = stSum.all_clear ? 'tag grn' : 'tag red';
      }
      if (tEl) {
        tEl.textContent = stSum.all_clear
          ? `昨日账单 ${stSum.total_count} 笔已全部与采购单对齐核平！`
          : `昨日账单共 ${stSum.total_count} 笔：查出 ${stSum.missing_count} 笔漏抓单（${fmtY(stSum.missing_amount_cents)}）· ${stSum.amount_diff_count} 笔实付差额待补抓！`;
      }
    }

    const rowsBox = $('comm-rows-box');
    if (rowsBox) {
      rowsBox.innerHTML = (dash?.commissions || [])
        .slice(0, 6)
        .map(
          (cm) => `
        <div class="tpl-btn" style="cursor:default">
          <div style="display:flex;justify-content:space-between">
            <b>${cm.policy_mode?.startsWith('post_arrival') ? '到货退差 10%' : '买前省钱 10%'}</b>
            <b style="color:#059669">${fmtY(cm.estimated_cents)}</b>
          </div>
          <small>${cm.note}</small>
        </div>`
        )
        .join('');
    }
  }

  function renderAll() {
    renderSessionAndMarket();
    renderTicketsDock();
    renderEarningsDock();
  }

  // Wire UI Events
  document.querySelectorAll('.dock button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-dock');
      document.querySelectorAll('.dock button').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.id === `pane-${target}`));
    });
  });

  $('conv-select')?.addEventListener('change', (e) => {
    curConvId = e.target.value;
    renderSessionAndMarket();
  });

  $('ticket-select')?.addEventListener('change', (e) => {
    curCaseId = e.target.value;
    renderTicketsDock();
  });

  $('anchor-select')?.addEventListener('change', (e) => {
    curAnchorCode = e.target.value;
    renderTicketsDock();
  });

  $('btn-refresh')?.addEventListener('click', () => {
    loadDashboard();
    showToast('已同步最新工作台数据');
  });

  $('btn-open-full')?.addEventListener('click', () => openFullWorkbench('#/today'));
  $('btn-close')?.addEventListener('click', () => postToParent('CLOSE_COPILOT', {}));

  $('btn-view-snap')?.addEventListener('click', () => {
    const cv = getCurConv();
    if (!cv) return;
    const snap = cv.item_snapshot || {};
    const imgs = (snap.images?.length ? snap.images : cv.evidence_urls || ['./evidence/IMG_5878.PNG']).map(resolveImgUrl);
    postToParent('OPEN_SNAPSHOT_MODAL', { snapshot: { ...snap, images: imgs } });
    showToast('已请求打开快照高清大图灯箱');
  });

  $('btn-fav-seller')?.addEventListener('click', async () => {
    const cv = getCurConv();
    if (!cv) return;
    const sid = cv.seller_id || `SELLER-${cv.conv_id}`;
    await callApi('POST', '/api/sellers/favorite', {
      actor_id: 'liming',
      seller_id: sid,
      seller_name: cv.seller_name,
      scope: 'team',
      remove: Boolean(cv.is_favorite_seller),
    });
    await loadDashboard();
    showToast(cv.is_favorite_seller ? '已取消收藏卖家' : '★ 已收藏卖家并共享给采购组');
  });

  $('btn-slow-toggle')?.addEventListener('click', async () => {
    const cv = getCurConv();
    if (!cv) return;
    const nextSlow = Number(cv.slow_group) !== 1;
    await callApi('POST', `/api/conversations/${cv.conv_id}/group`, {
      actor_id: 'liming',
      slow_group: nextSlow,
    });
    await loadDashboard();
    showToast(nextSlow ? '⏳ 已移入慢慢压价长线池' : '已移回常规会话跟进');
  });

  $('btn-pause-toggle')?.addEventListener('click', async () => {
    const cv = getCurConv();
    if (!cv) return;
    const path = cv.pause_state === 'paused' ? `/api/conversations/${cv.conv_id}/resume` : `/api/conversations/${cv.conv_id}/pause`;
    await callApi('POST', path, { actor_id: 'liming' });
    await loadDashboard();
    showToast(cv.pause_state === 'paused' ? '已恢复后台自动议价' : '⏸ 已暂停自动助手，由你亲自聊');
  });

  $('btn-tag-warehouse')?.addEventListener('click', async () => {
    const cv = getCurConv();
    const linked = (dash?.cases || []).find((c) => c.conv_id === cv?.conv_id) || dash?.cases?.[0];
    if (!linked) return;
    await callApi('POST', `/api/cases/${linked.case_id}/step/assess-bargain`, {
      actor_id: 'liming',
      seller_wrote_like_new: true,
      photos_blurry_incomplete: true,
      defects_fully_disclosed: false,
      suspect_condition_tag: true,
      warehouse_focus_points: ['强光查屏幕划痕/亮斑坏点', '查底壳与四角磕碰掉漆', '核原厂泡沫内衬与配件'],
    });
    await loadDashboard();
    showToast('🎯 已给赵仓管打上「质疑成色·派送10m重点深检」红靶标！');
  });

  $('btn-fix-model')?.addEventListener('click', async () => {
    const cv = getCurConv();
    const mc = $('fix-model-select')?.value;
    if (!cv || !mc) return;
    await callApi('POST', `/api/conversations/${cv.conv_id}/correct-match`, {
      actor_id: 'liming',
      model_code: mc,
      resume_auto: true,
    });
    await loadDashboard();
    showToast(`✓ 已修正匹配为 ${mc} 并解除冲突拦截`);
  });

  async function switchTrack(track) {
    const ic = getCurIssueCase();
    if (!ic?.ticket) return;
    await callApi('POST', `/api/aftersales/${ic.ticket.ticket_id}/step1-triage`, {
      actor_id: 'liming',
      route_choice: 'bargain_keep',
      arrival_track: track,
    });
    await loadDashboard();
    showToast(track === 'signed_platform_return' ? '已切到 📦 已签收先退货等开口轨' : '已切到 ⚡ 顺丰派送10m拒签闪电战轨');
  }

  $('btn-track-sf')?.addEventListener('click', () => switchTrack('sf_express_refuse'));
  $('btn-track-signed')?.addEventListener('click', () => switchTrack('signed_platform_return'));

  $('btn-copy-anchor')?.addEventListener('click', async () => {
    const ic = getCurIssueCase();
    const bp = ic?.bargain_plan || {};
    const anchors = [...(bp.psych_anchors || []), ...(bp.game_anchors || [])];
    const picked = anchors.find((a) => a.code === curAnchorCode) || anchors[0];
    if (!picked || !ic?.ticket) return;
    await copyAndFill(picked.script, `已复制 ${picked.code} 话术并记入留痕！`);
    if (ic.ticket.platform_return_no) {
      await callApi('POST', `/api/aftersales/${ic.ticket.ticket_id}/bargain-round`, {
        actor_id: 'liming',
        round_no: 2,
        role_side: 'buyer',
        tactic_code: picked.code,
        ask_refund_cents: bp.target_b_cents || 30000,
        text: picked.script,
      });
      await loadDashboard();
    }
  });

  $('btn-copy-corp')?.addEventListener('click', () => {
    const ic = getCurIssueCase();
    const txt = ic?.bargain_plan?.corp_alipay_seller_script || '';
    if (txt) copyAndFill(txt, '已复制整单全退走次日10点支付宝对公话术！');
  });

  $('btn-open-case-step')?.addEventListener('click', () => {
    const ic = getCurIssueCase();
    openFullWorkbench(ic ? `#/case/${ic.case_id}?step=8` : '#/cases?bucket=issue');
  });

  $('btn-open-reconcile')?.addEventListener('click', () => {
    openFullWorkbench('#/cases?reconcile=1');
  });

  loadDashboard();
})();
