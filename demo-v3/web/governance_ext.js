/* 锚点中控 v6 · 全工作台组织与制度基建缺口治理专区（Wiki / 培训视频 / KPI 口径 / OKR 目标 + 总经办初审 & 老板终审闭环） */
(function () {
  "use strict";

  function B() {
    return window.LedgerBridge;
  }

  const localFilter = {
    wb: "ALL",
    type: "ALL",
    status: "ALL",
  };

  function govStatusBadge(st) {
    const map = {
      published: `<span class="badge badge-green">✓ 已终审生效</span>`,
      pending_boss: `<span class="badge badge-purple">👑 待老板终审</span>`,
      pending_gm: `<span class="badge badge-cyan">🏛 待总经办初审</span>`,
      rejected: `<span class="badge badge-red">✕ 被打回待重交</span>`,
      draft: `<span class="badge badge-amber">📝 草稿编写中</span>`,
      missing: `<span class="badge badge-red">🔴 待补缺口</span>`,
    };
    return map[st] || `<span class="badge badge-gray">${B().esc(st)}</span>`;
  }

  function govTypeBadge(itype) {
    const map = {
      wiki: `<span class="badge badge-blue">📖 Wiki SOP</span>`,
      video: `<span class="badge badge-amber">🎬 培训视频</span>`,
      kpi: `<span class="badge badge-purple">🎯 岗位 KPI</span>`,
      okr: `<span class="badge badge-cyan">🧭 季度 OKR</span>`,
    };
    return map[itype] || `<span class="badge badge-gray">${B().esc(itype)}</span>`;
  }

  function renderGovIssuesBox(issues, titleText) {
    const { esc, qTip } = B();
    const list = issues || [];
    const redN = list.filter((x) => x.level === "red").length;
    const yelN = list.filter((x) => x.level === "yellow").length;
    return `
      <section class="issue-box">
        <div class="issue-box-head">
          <div class="issue-box-title">
            <span>🚦 ${esc(titleText)}</span>
            ${qTip("gov_isolation")}
            ${redN ? `<span class="badge badge-red">🔴 紧急缺口/被打回 ${redN}</span>` : ""}
            ${yelN ? `<span class="badge badge-amber">🟡 待初审/待终审 ${yelN}</span>` : ""}
            ${!redN && !yelN ? `<span class="badge badge-green">🟢 当前全部达标</span>` : ""}
          </div>
          <span class="cell-sub">一处终审通过 → 对应工作台 ? 帮助弹窗与培训视频槽自动同步点亮</span>
        </div>
        <div class="issue-list">
          ${list.length === 0 ? `<div class="issue-row green"><div class="issue-main"><div class="issue-headline">🎉 当前视角下无阻塞或待补齐缺口</div></div></div>` : list.slice(0, 7).map((it) => `
            <div class="issue-row ${esc(it.level)}">
              <div class="issue-main">
                <div class="issue-headline">
                  <span class="badge ${it.level === "red" ? "badge-red" : "badge-amber"}">${esc(it.category)}</span>
                  <span>${esc(it.title)}</span>
                </div>
                <div class="issue-detail">${esc(it.detail)}</div>
              </div>
              <div class="op-btns">
                <button type="button" class="btn ${it.level === "red" ? "btn-danger" : "btn-amber"} btn-xs" data-open-gov-item="${esc(it.item_id)}">${esc(it.action_label || "立即处理 ›")}</button>
              </div>
            </div>
          `).join("")}
        </div>
      </section>
    `;
  }

  function renderGovItemsTable(rows) {
    const { state, esc } = B();
    return `
      <div class="table-wrap">
        <table class="ledger-table">
          <thead>
            <tr>
              <th>槽位编码 / 缺口标题</th>
              <th>类型</th>
              <th>责任人 / 截止</th>
              <th>核心内容摘要（链接 / KPI公式 / OKR里程碑）</th>
              <th>状态 & 版本</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${rows.length === 0 ? `<tr><td colspan="6">当前筛选条件下暂无条目</td></tr>` : rows.map((it) => `
              <tr class="${it.status === "rejected" || (it.status === "missing" && it.priority === "critical") ? "row-danger" : it.status === "missing" ? "row-warn" : ""}">
                <td>
                  <strong>${esc(it.title)}</strong>
                  <span class="cell-sub mono">${esc(it.slot_code)} · 挂载点：${esc(it.page_anchor_note || "工作台帮助槽")}${it.bound_step_code ? ` · 🔗 联动步骤 ${esc(it.bound_step_code)}` : ""}</span>
                </td>
                <td>${govTypeBadge(it.item_type)}</td>
                <td>
                  <strong>${esc(it.assignee_staff)}</strong>
                  <span class="cell-sub mono">${esc(it.owner_dept)} · 限 ${esc(it.due_date)}</span>
                </td>
                <td style="max-width:440px;">
                  <div>${esc(it.summary_note || "-")}</div>
                  ${it.kpi_formula ? `<div class="kpi-formula-box mono"><strong>公式：</strong>${esc(it.kpi_formula)}<br/><span style="color:var(--ink-secondary);">${esc(it.kpi_thresholds)}</span></div>` : ""}
                  ${(it.okr_krs && it.okr_krs.length > 0) ? `<div class="kpi-formula-box">${it.okr_krs.map((kr) => `<div>• ${esc(kr)}</div>`).join("")}</div>` : ""}
                  ${it.resource_url ? `<span class="cell-sub mono">🔗 <a href="${esc(it.resource_url)}" target="_blank">${esc(it.resource_url)}</a>${it.video_duration ? ` (${esc(it.video_duration)})` : ""}</span>` : `<span class="cell-sub" style="color:var(--amber-ink);">尚未回填外部文档/视频链接</span>`}
                  ${it.status === "rejected" && it.last_reject_reason ? `<div style="margin-top:4px;color:var(--red-ink);font-weight:700;font-size:11.5px;">💬 ${esc(it.last_reject_reason)}</div>` : ""}
                </td>
                <td>
                  ${govStatusBadge(it.status)}
                  <span class="cell-sub mono">${it.current_version > 0 ? `v${it.current_version} (${it.history.length}次记录)` : "未提报"}</span>
                </td>
                <td>
                  <div class="op-btns">
                    <button type="button" class="btn ${it.status === "missing" || it.status === "rejected" ? "btn-primary" : "btn-outline"} btn-xs" data-open-gov-item="${esc(it.id)}">
                      ${it.status === "missing" ? "📤 提报补齐" : it.status === "rejected" ? "🔄 修订重交" : (it.status === "pending_boss" && state.viewerRole === "boss") ? "👑 终审拍板" : (it.status === "pending_gm" && state.viewerRole === "gm_office") ? "🏛 初审" : "查阅/历史"}
                    </button>
                  </div>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  // ==================== 1. 老板端(11专区) & 总经办端(01首屏)：全司六大工作台基建缺口总览与审批台 ====================
  function renderBossAndGmGovHub() {
    const { state, esc, qTip, matchSearch, renderFoldCard } = B();
    const gov = (state.boot && state.boot.governance) || {};
    const wbCards = gov.workbench_cards || [];
    const typeSum = gov.by_type_summary || [];
    const items = (gov.items || []).filter((it) => {
      if (localFilter.wb !== "ALL" && it.workbench_key !== localFilter.wb) return false;
      if (localFilter.type !== "ALL" && it.item_type !== localFilter.type) return false;
      if (localFilter.status === "GAP" && !["missing", "rejected", "draft"].includes(it.status)) return false;
      if (localFilter.status === "REVIEW" && !["pending_gm", "pending_boss"].includes(it.status)) return false;
      if (localFilter.status === "PUBLISHED" && it.status !== "published") return false;
      return matchSearch(it);
    });

    const pendingBoss = gov.pending_boss_items || [];
    const pendingGm = gov.pending_gm_items || [];
    const isBoss = state.viewerRole === "boss";

    return `
      <div class="page-header">
        <div>
          <h2>${isBoss ? "👑 老板终审与工作台治理专区" : "🏛 总经办统筹工作台"} · 全司 Wiki / 培训视频 / KPI / OKR 缺口台账 ${qTip("gov_isolation")}</h2>
          <span class="cell-sub">独立于「委托客户/执照/支付宝/号卡」受托资产线之外的管理运营公司组织基建专区：总经办与各主管在此提报补缺，老板一键终审锁死后全工作台 ? 帮助槽实时点亮</span>
        </div>
        <div class="op-btns">
          <button type="button" class="btn btn-primary btn-sm" data-open-gov-create="${esc(localFilter.wb === "ALL" ? "sales" : localFilter.wb)}">+ 登记/派发新缺口槽位</button>
        </div>
      </div>

      ${renderGovIssuesBox(gov.gov_issues || [], isBoss ? "工作台软基建 · 待老板拍板与高危制度缺口箱" : "总经办沈悦 · 今日待初审与催办缺口行动箱")}

      <!-- 四大治理维度汇总条 -->
      <div class="stat-strip" style="grid-template-columns: repeat(4, minmax(0, 1fr));">
        ${typeSum.map((ts) => `
          <div class="stat-pill-card" data-gov-filter-type="${esc(ts.key)}">
            <div class="stat-pill-top"><span>${esc(ts.label)}</span></div>
            <div class="stat-pill-val">
              <strong class="num">${ts.published}/${ts.target} 已生效</strong>
              <span class="badge ${ts.gap > 0 ? "badge-red" : "badge-green"}">${ts.gap > 0 ? `净缺口 ${ts.gap}` : "已齐"}${ts.in_review ? ` · 审${ts.in_review}` : ""}</span>
            </div>
          </div>
        `).join("")}
      </div>

      <!-- 六大工作台完备度矩阵卡片（3x2 网格） -->
      <div class="wb-gov-grid">
        ${wbCards.map((wc) => {
          const d = wc.dimensions || {};
          return `
            <div class="wb-gov-card ${localFilter.wb === wc.workbench_key ? "active-wb" : ""}" data-gov-filter-wb="${esc(wc.workbench_key)}">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                <strong style="font-size:13.5px;">${esc(wc.workbench_label)}</strong>
                <span class="badge ${wc.gap_total > 0 ? "badge-amber" : "badge-green"}">完备率 ${wc.completion_pct}%</span>
              </div>
              <div class="cell-sub" style="margin-top:2px;">主管/负责人：<strong>${esc(wc.lead_staff)}</strong> · ${esc(wc.notes)}</div>
              <div class="progress-bar" style="width:100%;margin-top:6px;"><div class="progress-fill ${wc.completion_pct < 50 ? "danger" : wc.completion_pct < 85 ? "warn" : ""}" style="width:${wc.completion_pct}%"></div></div>
              <div class="wb-dim-mini-grid">
                ${["wiki", "video", "kpi", "okr"].map((k) => {
                  const dm = d[k] || { published: 0, target: 0, gap: 0 };
                  const shortLbl = k === "wiki" ? "Wiki" : k === "video" ? "视频" : k.toUpperCase();
                  return `
                    <div class="wb-dim-mini ${dm.gap > 0 ? "has-gap" : ""}">
                      <div style="font-weight:700;">${shortLbl}</div>
                      <div class="mono">${dm.published}/${dm.target}${dm.gap > 0 ? `(缺${dm.gap})` : "✓"}</div>
                    </div>
                  `;
                }).join("")}
              </div>
            </div>
          `;
        }).join("")}
      </div>

      <!-- 老板端专属：待老板终审拍板队列 -->
      ${isBoss && pendingBoss.length > 0 ? `
        <div class="panel-card" style="border:2px solid var(--purple);margin-bottom:14px;">
          <div class="panel-head" style="background:var(--purple-bg);">
            <h3>👑 待老板终审拍板队列 (${pendingBoss.length} 项 · 批准即全公司锁死生效并点亮对应工作台/教程槽位)</h3>
            <span class="badge badge-purple">总经办已初审把关</span>
          </div>
          <div class="table-wrap">
            <table class="ledger-table">
              <thead><tr><th>所属工作台</th><th>类型</th><th>标题 & 核心公式/视频预览</th><th>提报人</th><th>老板拍板</th></tr></thead>
              <tbody>
                ${pendingBoss.map((it) => `
                  <tr>
                    <td><strong>${esc(it.workbench_label)}</strong></td>
                    <td>${govTypeBadge(it.item_type)}</td>
                    <td>
                      <strong>${esc(it.title)}</strong>
                      ${it.bound_step_code ? `<span class="badge badge-amber">🔗 批准后自动点亮教程步骤 ${esc(it.bound_step_code)} 视频</span>` : ""}
                      <span class="cell-sub">${esc(it.summary_note)}</span>
                      ${it.kpi_formula ? `<div class="kpi-formula-box mono">${esc(it.kpi_formula)} · ${esc(it.kpi_thresholds)}</div>` : ""}
                      ${it.resource_url ? `<span class="cell-sub mono">🔗 <a href="${esc(it.resource_url)}" target="_blank">${esc(it.resource_url)}</a></span>` : ""}
                    </td>
                    <td>${esc(it.assignee_staff)}</td>
                    <td>
                      <div class="op-btns">
                        <button type="button" class="btn btn-outline btn-xs" data-open-gov-item="${esc(it.id)}">详情</button>
                        <button type="button" class="btn btn-success btn-xs" data-gov-quick-verdict="${esc(it.id)}" data-verdict="approve">✓ 批准锁死生效</button>
                        <button type="button" class="btn btn-danger btn-xs" data-gov-quick-verdict="${esc(it.id)}" data-verdict="reject">✕ 打回重改</button>
                      </div>
                    </td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>
      ` : ""}

      <!-- 总经办端专属：待总经办初审队列 -->
      ${!isBoss && pendingGm.length > 0 ? `
        <div class="panel-card" style="border:2px solid var(--cyan);margin-bottom:14px;">
          <div class="panel-head" style="background:var(--cyan-bg);">
            <h3>🏛 待总经办初审队列 (${pendingGm.length} 项 · 核验口径与格式无误后转呈老板终审)</h3>
          </div>
          <div class="table-wrap">
            <table class="ledger-table">
              <thead><tr><th>所属工作台</th><th>类型</th><th>标题 & 提报说明</th><th>提交主管</th><th>总经办初审</th></tr></thead>
              <tbody>
                ${pendingGm.map((it) => `
                  <tr>
                    <td><strong>${esc(it.workbench_label)}</strong></td>
                    <td>${govTypeBadge(it.item_type)}</td>
                    <td>
                      <strong>${esc(it.title)}</strong>
                      <span class="cell-sub">${esc(it.summary_note)}</span>
                      ${it.resource_url ? `<span class="cell-sub mono">🔗 <a href="${esc(it.resource_url)}" target="_blank">${esc(it.resource_url)}</a> (${esc(it.video_duration || "文档")})</span>` : ""}
                    </td>
                    <td>${esc(it.assignee_staff)}</td>
                    <td>
                      <div class="op-btns">
                        <button type="button" class="btn btn-outline btn-xs" data-open-gov-item="${esc(it.id)}">审阅详情</button>
                        <button type="button" class="btn btn-primary btn-xs" data-gov-quick-verdict="${esc(it.id)}" data-verdict="approve">✓ 初审通过呈老板</button>
                        <button type="button" class="btn btn-danger btn-xs" data-gov-quick-verdict="${esc(it.id)}" data-verdict="reject">✕ 退回补改</button>
                      </div>
                    </td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>
      ` : ""}

      <!-- 筛选栏 -->
      <div class="filter-bar">
        <div class="pill-group">
          <button type="button" class="pill ${localFilter.wb === "ALL" ? "active" : ""}" data-gov-filter-wb="ALL">全部工作台</button>
          <button type="button" class="pill ${localFilter.type === "ALL" ? "active" : ""}" data-gov-filter-type="ALL">全类型</button>
          <button type="button" class="pill ${localFilter.type === "kpi" ? "active" : ""}" data-gov-filter-type="kpi">🎯 KPI</button>
          <button type="button" class="pill ${localFilter.type === "okr" ? "active" : ""}" data-gov-filter-type="okr">🧭 OKR</button>
          <button type="button" class="pill ${localFilter.type === "wiki" ? "active" : ""}" data-gov-filter-type="wiki">📖 Wiki</button>
          <button type="button" class="pill ${localFilter.type === "video" ? "active" : ""}" data-gov-filter-type="video">🎬 培训视频</button>
        </div>
        <div class="pill-group">
          <button type="button" class="pill ${localFilter.status === "ALL" ? "active" : ""}" data-gov-filter-status="ALL">全部状态 (${items.length})</button>
          <button type="button" class="pill ${localFilter.status === "GAP" ? "active" : ""}" data-gov-filter-status="GAP">🔴 待补缺口/被打回</button>
          <button type="button" class="pill ${localFilter.status === "REVIEW" ? "active" : ""}" data-gov-filter-status="REVIEW">⏳ 提审流转中</button>
          <button type="button" class="pill ${localFilter.status === "PUBLISHED" ? "active" : ""}" data-gov-filter-status="PUBLISHED">🟢 已生效</button>
        </div>
      </div>

      ${wbCards
        .filter((wc) => localFilter.wb === "ALL" || wc.workbench_key === localFilter.wb)
        .map((wc) => {
          const wRows = items.filter((x) => x.workbench_key === wc.workbench_key);
          if (wRows.length === 0) return "";
          const gapN = wRows.filter((x) => ["missing", "rejected"].includes(x.status)).length;
          return renderFoldCard({
            id: `gov_wb:${wc.workbench_key}`,
            title: `${wc.workbench_label}（主管：${wc.lead_staff} · ${wRows.length} 项）`,
            variant: gapN > 0 ? "warn" : "",
            pillsHtml: `
              ${gapN > 0 ? `<span class="badge badge-red">${gapN} 项待补/重交</span>` : `<span class="badge badge-green">无阻塞缺口</span>`}
              <span class="badge badge-blue">完备度 ${wc.completion_pct}%</span>
            `,
            actionHtml: `<button type="button" class="btn btn-outline btn-xs" data-open-gov-create="${esc(wc.workbench_key)}">+ 派新缺口</button>`,
            bodyHtml: renderGovItemsTable(wRows),
          });
        })
        .join("")}
    `;
  }

  // ==================== 2. 总经办端专视图 02：KPI 与 OKR 结构化口径总库 ====================
  function renderGovKpiOkrView() {
    const { state, esc, matchSearch } = B();
    const gov = (state.boot && state.boot.governance) || {};
    const rows = (gov.items || []).filter((x) => ["kpi", "okr"].includes(x.item_type) && matchSearch(x));
    return `
      <div class="page-header">
        <div>
          <h2>🎯 全司六大工作台 KPI 考核公式与季度 OKR 口径总库</h2>
          <span class="cell-sub">只管考核规则定义、数据取数映射表与红黄绿阈值锁死（防私改标准），日常算薪跑分留在各业务表自动执行</span>
        </div>
        <button type="button" class="btn btn-primary btn-sm" data-open-gov-create="gm_office" data-preset-type="kpi">+ 新建 KPI / OKR 缺口项</button>
      </div>
      <div class="panel-card">
        ${renderGovItemsTable(rows)}
      </div>
    `;
  }

  // ==================== 3. 总经办端专视图 03：Wiki 与实操培训视频槽位表 ====================
  function renderGovWikiVideoView() {
    const { state, esc, matchSearch } = B();
    const gov = (state.boot && state.boot.governance) || {};
    const rows = (gov.items || []).filter((x) => ["wiki", "video"].includes(x.item_type) && matchSearch(x));
    return `
      <div class="page-header">
        <div>
          <h2>🎬 全工作台 ? 帮助弹窗 Wiki 文档与实操培训视频槽位表</h2>
          <span class="cell-sub">文档写在钉钉/飞书 Wiki，视频存在钉钉盘/OSS；此处统一追踪各工作台「待录/待补」缺口并在终审后自动点亮前端链接</span>
        </div>
        <button type="button" class="btn btn-primary btn-sm" data-open-gov-create="sales" data-preset-type="video">+ 登记待录视频 / Wiki 缺口</button>
      </div>
      <div class="panel-card">
        ${renderGovItemsTable(rows)}
      </div>
    `;
  }

  // ==================== 4. 各工作台主管视图：本部门待补缺口提报台 ====================
  function renderSupervisorMyGovView(onlyPublished = false) {
    const { state, esc } = B();
    const gov = (state.boot && state.boot.governance) || {};
    const allMy = gov.items || [];
    const myCard = (gov.workbench_cards || []).find((c) => c.workbench_key === gov.focus_workbench);
    const rows = onlyPublished
      ? allMy.filter((x) => x.status === "published")
      : allMy.filter((x) => x.status !== "published");

    return `
      <div class="page-header">
        <div>
          <h2>🧭 ${esc(myCard ? myCard.workbench_label : `${state.viewerStaff} 主管端`)} · ${onlyPublished ? "已生效制度·视频·KPI标准库" : "待补 Wiki / 培训视频 / KPI 缺口交件台"}</h2>
          <span class="cell-sub">职责隔离：您仅需在此认领并提报本工作台的 SOP 链接、实操培训视频与岗位 KPI 草案，经总经办初审与老板终审后全司生效</span>
        </div>
        ${!onlyPublished ? `<button type="button" class="btn btn-outline btn-sm" data-open-gov-create="${esc(gov.focus_workbench || "sales")}">+ 主动申报本台新制度/视频槽</button>` : ""}
      </div>

      ${!onlyPublished ? renderGovIssuesBox(gov.gov_issues || [], `${state.viewerStaff}主管 · 本工作台待补齐与被打回修订项`) : ""}

      ${myCard ? `
        <div class="stat-strip" style="grid-template-columns: repeat(4, minmax(0, 1fr));">
          ${["wiki", "video", "kpi", "okr"].map((k) => {
            const dm = myCard.dimensions[k] || { label: k, published: 0, target: 0, gap: 0, in_review: 0 };
            return `
              <div class="stat-pill-card">
                <div class="stat-pill-top"><span>${esc(dm.label)}</span></div>
                <div class="stat-pill-val">
                  <strong class="num">${dm.published}/${dm.target} 已上线</strong>
                  <span class="badge ${dm.gap > 0 ? "badge-red" : "badge-green"}">${dm.gap > 0 ? `缺 ${dm.gap}` : "达标"}${dm.in_review ? ` · 审${dm.in_review}` : ""}</span>
                </div>
              </div>
            `;
          }).join("")}
        </div>
      ` : ""}

      <div class="panel-card">
        <div class="panel-head">
          <h3>${onlyPublished ? `✅ 本工作台已终审生效标准 (${rows.length})` : `📋 本工作台待补齐 / 审批流转中清单 (${rows.length})`}</h3>
        </div>
        ${renderGovItemsTable(rows)}
      </div>
    `;
  }

  // ==================== 5. 右侧穿透抽屉：结构化提报表单 + 总经办初审/老板终审 + 永久历史意见时间线 ====================
  async function openGovItemDrawer(itemId) {
    const { state, apiCall, openDrawer, closeDrawer, reloadData, toast, esc } = B();
    try {
      const res = await apiCall(`/api/governance/item?id=${encodeURIComponent(itemId)}`);
      const it = res.data;
      const canSubmit = state.viewerRole !== "employee";
      const canGmReview = state.viewerRole === "gm_office" && it.status === "pending_gm";
      const canBossReview = state.viewerRole === "boss" && ["pending_boss", "pending_gm"].includes(it.status);

      const bodyHtml = `
        <div id="gov-drawer-err" class="form-error-box hidden"></div>
        <div class="kv-grid">
          <div class="kv-item"><label>槽位唯一编码 / 类型</label><div class="mono">${esc(it.slot_code)} · ${govTypeBadge(it.item_type)}</div></div>
          <div class="kv-item"><label>归属工作台</label><div><strong>${esc(it.workbench_label)}</strong></div></div>
          <div class="kv-item"><label>责任部门 / 具体负责人</label><div>${esc(it.owner_dept)} · <strong>${esc(it.assignee_staff)}</strong></div></div>
          <div class="kv-item"><label>当前状态 & 截止日</label><div>${govStatusBadge(it.status)} · 限 ${esc(it.due_date)}</div></div>
          <div class="kv-item"><label>前端挂载位置</label><div>${esc(it.page_anchor_note || "-")}</div></div>
          <div class="kv-item"><label>关联自动点亮教程步骤</label><div class="mono">${it.bound_step_code ? `🔗 步骤 ${esc(it.bound_step_code)}（终审通过即点亮）` : "独立工作台槽位"}</div></div>
        </div>

        ${it.status === "rejected" && it.last_reject_reason ? `
          <div class="warn-flat-box">
            🚨 上一版被退回意见（请在下方修正后提交新版本，旧版意见永久保留）：<br/>${esc(it.last_reject_reason)}
          </div>
        ` : ""}

        ${(canGmReview || canBossReview) ? `
          <div class="panel-card" style="border:2px solid ${canBossReview ? "var(--purple)" : "var(--cyan)"};background:${canBossReview ? "var(--purple-bg)" : "var(--cyan-bg)"};padding:13px 15px;">
            <div style="font-weight:800;margin-bottom:8px;">
              ${canBossReview ? "👑 老板终审拍板台（批准后全司锁死生效，若绑教程步骤则实时点亮视频/Wiki）" : "🏛 总经办初审把关台（通过后自动转呈老板终审队列）"}
            </div>
            <div class="op-btns">
              <input id="gov-review-note" class="input-control" style="flex:1;background:#fff;" placeholder="填写审批评语；若打回重改必须写明 ≥4 字具体缺失原因..." />
              <button type="button" class="btn btn-success" id="btn-gov-approve">${canBossReview ? "✓ 批准正式上线" : "✓ 初审通过呈老板"}</button>
              <button type="button" class="btn btn-danger" id="btn-gov-reject">✕ 打回重改</button>
            </div>
          </div>
        ` : ""}

        ${canSubmit ? `
          <div class="panel-card" style="padding:14px 16px;">
            <div style="font-weight:800;margin-bottom:10px;">
              📤 ${it.current_version > 0 ? `提交修订版 (v${it.current_version + 1})` : "首次提报补齐缺口"}（禁空、禁填纯 "0"，缺数据请如实写「待核」）
            </div>
            <div class="form-grid">
              ${(it.item_type === "wiki" || it.item_type === "video") ? `
                <div class="form-field ${it.item_type === "wiki" ? "span-2" : ""}">
                  <label>${it.item_type === "wiki" ? "钉钉 / 飞书 Wiki 正式文档链接 *" : "实操培训视频播放链接（钉钉盘 / 内网盘 / OSS）*"}</label>
                  <input id="gf-url" class="input-control mono" value="${esc(it.resource_url || "")}" placeholder="https://..." />
                </div>
              ` : `
                <div class="form-field span-2">
                  <label>关联制度备份文档链接（选填，钉钉/飞书 Wiki）</label>
                  <input id="gf-url" class="input-control mono" value="${esc(it.resource_url || "")}" placeholder="选填：https://alidocs.dingtalk.com/..." />
                </div>
              `}

              ${it.item_type === "video" ? `
                <div class="form-field">
                  <label>视频时长 (MM:SS) *</label>
                  <input id="gf-dur" class="input-control mono" value="${esc(it.video_duration || "")}" placeholder="如 04:35" />
                </div>
              ` : ""}

              ${it.item_type === "kpi" ? `
                <div class="form-field span-2">
                  <label>KPI 标准计算公式 *</label>
                  <input id="gf-formula" class="input-control mono" value="${esc(it.kpi_formula || "")}" placeholder="如：质检准确率 = (出库总台数 - 描述不符退货数) / 出库总台数 × 100%" />
                </div>
                <div class="form-field span-2">
                  <label>底层取数数据库表 / 字段映射</label>
                  <input id="gf-source" class="input-control mono" value="${esc(it.kpi_data_source || "")}" placeholder="如：warehouse_qc_orders (quality_mismatch_return)" />
                </div>
                <div class="form-field span-2">
                  <label>红黄绿考核及格线与奖惩权重 *</label>
                  <input id="gf-thresh" class="input-control" value="${esc(it.kpi_thresholds || "")}" placeholder="如：🟢 ≥99% 达标；🟡 97%~99% 预警；🔴 <97% 复检扣分" />
                </div>
              ` : ""}

              ${it.item_type === "okr" ? `
                <div class="form-field span-2">
                  <label>季度目标 (O) 与可量化关键结果 (KR1~KR3，每行一条) *</label>
                  <textarea id="gf-okr" class="input-control" rows="4" placeholder="O：本季度核心目标...\nKR1：具体量化结果1...\nKR2：具体量化结果2...">${esc((it.okr_krs || []).join("\n"))}</textarea>
                </div>
              ` : ""}

              <div class="form-field span-2">
                <label>本次提报/修订要点说明 *</label>
                <textarea id="gf-summary" class="input-control" rows="2" placeholder="简述覆盖的防呆要点或针对上次退回意见的补充内容...">${esc(it.status === "missing" ? "" : (it.summary_note || ""))}</textarea>
              </div>
            </div>
            <div style="margin-top:10px;text-align:right;">
              <button type="button" class="btn btn-primary" id="btn-gov-submit-form">
                🚀 ${state.viewerRole === "boss" ? "老板直接签发上线" : state.viewerRole === "gm_office" ? "提交呈报老板终审" : "提交至总经办初审"}
              </button>
            </div>
          </div>
        ` : ""}

        <div class="panel-card" style="padding:14px 16px;">
          <div style="font-weight:800;margin-bottom:8px;">📜 历史提报与审批留痕时间线（共 ${(it.history || []).length} 个版本 · 退回意见永久保留）</div>
          ${(it.history || []).length === 0 ? `<span class="cell-sub">当前尚无历史提报记录。</span>` : (it.history || []).map((h) => `
            <div class="sub-history-item ${h.status === "rejected" ? "rejected" : ""}">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <div>
                  <span class="badge ${h.status === "approved" ? "badge-green" : h.status === "rejected" ? "badge-red" : "badge-purple"}">v${h.version_no} · ${esc(h.status)}</span>
                  <strong>提报人：${esc(h.submitted_by)} (${esc(h.submitted_role)})</strong>
                </div>
                <span class="cell-sub mono">${esc(h.submitted_at)}</span>
              </div>
              <div class="cell-sub mono" style="margin-top:4px;color:var(--ink-primary);">快照：${esc(JSON.stringify(h.payload || {}))}</div>
              ${h.gm_note ? `<div style="margin-top:4px;font-size:12px;color:var(--cyan-ink);">🏛 总经办初审（${esc(h.gm_reviewed_by)}）：${esc(h.gm_note)}</div>` : ""}
              ${h.boss_note ? `<div style="margin-top:4px;font-size:12px;font-weight:700;color:${h.status === "rejected" ? "var(--red-ink)" : "var(--green)"};">👑 老板裁决：${esc(h.boss_note)}</div>` : ""}
            </div>
          `).join("")}
        </div>
      `;

      openDrawer("工作台基建缺口治理", `${it.type_label} · ${it.title}`, bodyHtml, "", () => openGovItemDrawer(itemId));

      const showErr = (msg) => {
        const el = document.getElementById("gov-drawer-err");
        if (el) {
          el.textContent = "⛔ " + msg;
          el.classList.remove("hidden");
        }
      };

      const subBtn = document.getElementById("btn-gov-submit-form");
      if (subBtn) {
        subBtn.onclick = async () => {
          try {
            const payload = {
              item_id: it.id,
              resource_url: document.getElementById("gf-url") ? document.getElementById("gf-url").value.trim() : "",
              video_duration: document.getElementById("gf-dur") ? document.getElementById("gf-dur").value.trim() : "",
              kpi_formula: document.getElementById("gf-formula") ? document.getElementById("gf-formula").value.trim() : "",
              kpi_data_source: document.getElementById("gf-source") ? document.getElementById("gf-source").value.trim() : "",
              kpi_thresholds: document.getElementById("gf-thresh") ? document.getElementById("gf-thresh").value.trim() : "",
              okr_krs: document.getElementById("gf-okr") ? document.getElementById("gf-okr").value : [],
              summary_note: document.getElementById("gf-summary") ? document.getElementById("gf-summary").value.trim() : "",
            };
            const r = await apiCall("/api/governance/submit", "POST", payload);
            toast(`已成功提报 v${r.version_no}！`, "success");
            await reloadData();
            await openGovItemDrawer(it.id);
          } catch (e) {
            showErr(e.message);
          }
        };
      }

      const doVerdict = async (verdict) => {
        try {
          const note = document.getElementById("gov-review-note").value.trim();
          await apiCall("/api/governance/review", "POST", { item_id: it.id, verdict, note });
          toast(verdict === "approve" ? "✅ 审批通过！" : "已打回修订（历史意见永久保留）", "success");
          closeDrawer();
          await reloadData();
        } catch (e) {
          showErr(e.message);
        }
      };
      const appBtn = document.getElementById("btn-gov-approve");
      if (appBtn) appBtn.onclick = () => doVerdict("approve");
      const rejBtn = document.getElementById("btn-gov-reject");
      if (rejBtn) rejBtn.onclick = () => doVerdict("reject");
    } catch (e) {
      toast("加载治理条目失败：" + e.message, "error");
    }
  }

  function openCreateGovSlotDrawer(presetWb = "sales", presetType = "wiki") {
    const { state, openDrawer, closeDrawer, apiCall, reloadData, toast, esc } = B();
    const gov = (state.boot && state.boot.governance) || {};
    const wbMeta = gov.workbench_meta || {};
    const typeLabels = gov.item_type_labels || {};

    const html = `
      <div id="gov-create-err" class="form-error-box hidden"></div>
      <form class="form-grid">
        <div class="form-field">
          <label>归属工作台 *</label>
          <select id="gc-wb" class="select-control">
            ${Object.entries(wbMeta).map(([k, m]) => `<option value="${esc(k)}" ${k === presetWb ? "selected" : ""}>${esc(m.label)} (主管:${esc(m.supervisor)})</option>`).join("")}
          </select>
        </div>
        <div class="form-field">
          <label>缺口类型 *</label>
          <select id="gc-type" class="select-control">
            ${Object.entries(typeLabels).map(([k, lbl]) => `<option value="${esc(k)}" ${k === presetType ? "selected" : ""}>${esc(lbl)}</option>`).join("")}
          </select>
        </div>
        <div class="form-field span-2">
          <label>缺口标题（需补齐的具体 SOP / 视频 / KPI 指标 / 季度 OKR）*</label>
          <input id="gc-title" class="input-control" placeholder="如：《抖店虚拟卡券核销争议举证录屏》 / 客服晚班转化率 KPI 口径" />
        </div>
        <div class="form-field">
          <label>指派具体责任人 *</label>
          <select id="gc-staff" class="select-control">
            <option value="沈悦">沈悦（总经办）</option>
            <option value="陆铭" ${presetWb === "sales" ? "selected" : ""}>陆铭（销售主管）</option>
            <option value="苏晴" ${presetWb === "cs" ? "selected" : ""}>苏晴（客服主管）</option>
            <option value="郑凯" ${presetWb === "procurement" ? "selected" : ""}>郑凯（采购主管）</option>
            <option value="马强" ${presetWb === "warehouse" ? "selected" : ""}>马强（仓管主管）</option>
            <option value="周安" ${presetWb === "account_ops" ? "selected" : ""}>周安（开店中控主管）</option>
          </select>
        </div>
        <div class="form-field">
          <label>优先级 & 要求截止日期 *</label>
          <div class="op-btns">
            <select id="gc-prio" class="select-control">
              <option value="critical">🔴 高危必补 (critical)</option>
              <option value="high" selected>🟠 重点缺口 (high)</option>
              <option value="normal">🔵 常规完善 (normal)</option>
            </select>
            <input id="gc-due" type="date" class="input-control mono" value="2026-11-25" />
          </div>
        </div>
        <div class="form-field">
          <label>前端工作台挂载位置说明</label>
          <input id="gc-anchor" class="input-control" placeholder="如：仓管工作台 > 打包复核页 ?" />
        </div>
        <div class="form-field">
          <label>联动开店教程步骤码（选填，如 S08 / D15）</label>
          <input id="gc-step" class="input-control mono" placeholder="选填：填后终审通过自动点亮该步骤" />
        </div>
        <div class="form-field span-2">
          <label>缺口背景与验收要求说明</label>
          <textarea id="gc-note" class="input-control" rows="2" placeholder="说明需要包含哪些防呆要点或公式维度..."></textarea>
        </div>
      </form>
    `;

    const footer = `
      <button type="button" class="btn btn-outline" id="btn-gc-cancel">取消</button>
      <button type="button" class="btn btn-primary" id="btn-gc-save">📌 确认登记缺口并派单</button>
    `;
    openDrawer("登记工作台基建缺口", "新增 Wiki / 培训视频 / KPI / OKR 待补槽位", html, footer);
    document.getElementById("btn-gc-cancel").onclick = closeDrawer;
    document.getElementById("btn-gc-save").onclick = async () => {
      try {
        await apiCall("/api/governance/create-slot", "POST", {
          workbench_key: document.getElementById("gc-wb").value,
          item_type: document.getElementById("gc-type").value,
          title: document.getElementById("gc-title").value.trim(),
          assignee_staff: document.getElementById("gc-staff").value,
          priority: document.getElementById("gc-prio").value,
          due_date: document.getElementById("gc-due").value,
          page_anchor_note: document.getElementById("gc-anchor").value.trim(),
          bound_step_code: document.getElementById("gc-step").value.trim(),
          summary_note: document.getElementById("gc-note").value.trim(),
        });
        toast("已成功登记新缺口槽位并指派责任人！", "success");
        closeDrawer();
        await reloadData();
      } catch (e) {
        const errEl = document.getElementById("gov-create-err");
        errEl.textContent = "⛔ " + e.message;
        errEl.classList.remove("hidden");
      }
    };
  }

  function bindGovernanceEvents() {
    document.body.addEventListener("click", async (e) => {
      const { state, apiCall, toast, reloadData, renderCurrentView } = B();

      const openItem = e.target.closest("[data-open-gov-item]");
      if (openItem) {
        e.stopPropagation();
        await openGovItemDrawer(openItem.dataset.openGovItem);
        return;
      }

      const openCreate = e.target.closest("[data-open-gov-create]");
      if (openCreate) {
        e.stopPropagation();
        openCreateGovSlotDrawer(openCreate.dataset.openGovCreate || "sales", openCreate.dataset.presetType || "wiki");
        return;
      }

      const fWb = e.target.closest("[data-gov-filter-wb]");
      if (fWb) {
        e.stopPropagation();
        const val = fWb.dataset.govFilterWb;
        localFilter.wb = localFilter.wb === val && val !== "ALL" ? "ALL" : val;
        if (localFilter.wb !== "ALL") state.openFolds.add(`gov_wb:${localFilter.wb}`);
        renderCurrentView();
        return;
      }

      const fType = e.target.closest("[data-gov-filter-type]");
      if (fType) {
        e.stopPropagation();
        const val = fType.dataset.govFilterType;
        localFilter.type = localFilter.type === val && val !== "ALL" ? "ALL" : val;
        renderCurrentView();
        return;
      }

      const fSt = e.target.closest("[data-gov-filter-status]");
      if (fSt) {
        e.stopPropagation();
        localFilter.status = fSt.dataset.govFilterStatus;
        renderCurrentView();
        return;
      }

      const quickV = e.target.closest("[data-gov-quick-verdict]");
      if (quickV) {
        e.stopPropagation();
        const verdict = quickV.dataset.verdict;
        const itemId = quickV.dataset.govQuickVerdict;
        let note = "";
        if (verdict === "reject") {
          note = window.prompt("请输入退回补改的具体原因（至少 4 个字，历史意见将永久保留）：", "请补充计算口径边界与财务对账衔接说明后再提交");
          if (note === null) return;
        }
        try {
          await apiCall("/api/governance/review", "POST", { item_id: itemId, verdict, note });
          toast(verdict === "approve" ? "🎉 审批通过！已同步刷新工作台生效状态" : "已退回责任人补改", "success");
          await reloadData();
        } catch (err) {
          toast("⛔ " + err.message, "error");
        }
        return;
      }
    });
  }

  window.LedgerGovernance = {
    bindGovernanceEvents,
    renderBossAndGmGovHub,
    renderGovKpiOkrView,
    renderGovWikiVideoView,
    renderSupervisorMyGovView,
    openGovItemDrawer,
  };
})();
