/* 锚点中控 v5 · 三端协同（老板端 / 主管端 / 员工端）+ 统筹看缺口引擎 + 33步企支↔闲鱼双轨开店教程状态机 + AdsPower 免明文 Authenticator 领用台 */
(function () {
  "use strict";

  function B() {
    return window.LedgerBridge;
  }

  // ==================== 1. 辅助徽章与格式化 ====================
  function stepStateBadge(st) {
    const map = {
      approved: `<span class="badge badge-green">✓ 已完成</span>`,
      active: `<span class="badge badge-blue">● 当前待办</span>`,
      submitted: `<span class="badge badge-amber">⏳ 待主管审核</span>`,
      rejected: `<span class="badge badge-red">✕ 被打回重交</span>`,
      skipped: `<span class="badge badge-gray">↷ 特批跳过</span>`,
      locked: `<span class="badge badge-gray">🔒 待前序(可预览)</span>`,
    };
    return map[st] || `<span class="badge badge-gray">${B().esc(st)}</span>`;
  }

  function caseSummaryBadge(cs) {
    const { esc } = B();
    if (!cs) {
      return `<span class="badge badge-amber" title="该平台尚未发布标准开店教程，请由主管端编排">⚠️ 待补平台教程</span>`;
    }
    if (cs.status === "completed") {
      return `<span class="link-chip" data-open-wizard="${esc(cs.id)}" title="点击查看完整已归档开店教程记录">✅ ${cs.done_steps}/${cs.total_steps} 步已闭环</span>`;
    }
    if (cs.has_rejected) {
      return `<span class="link-chip" style="background:#fff1f2;border-color:#fda4af;color:#be123c;" data-open-wizard="${esc(cs.id)}">🚨 ${cs.done_steps}/${cs.total_steps} · ${esc(cs.current_step_code)}被打回</span>`;
    }
    if (cs.cross_blocked_msg) {
      return `<span class="link-chip" style="background:#fffbeb;border-color:#fcd34d;color:#b45309;" data-open-wizard="${esc(cs.id)}" title="${esc(cs.cross_blocked_msg)}">🔒 ${cs.done_steps}/${cs.total_steps} · 跨轨锁(${esc(cs.current_step_code)})</span>`;
    }
    if (cs.has_pending_review) {
      return `<span class="link-chip" style="background:#fffbeb;border-color:#fde68a;color:#92400e;" data-open-wizard="${esc(cs.id)}">⏳ ${cs.done_steps}/${cs.total_steps} · ${esc(cs.current_step_code)}待审</span>`;
    }
    return `<span class="link-chip" data-open-wizard="${esc(cs.id)}">🔵 ${cs.done_steps}/${cs.total_steps} · 进行至 ${esc(cs.current_step_code || "完结")}</span>`;
  }

  function getCaseForTarget(kind, targetId) {
    const cases = (B().state.boot && B().state.boot.onboarding_cases) || [];
    return cases.find((c) => c.target_kind === kind && c.target_id === targetId) || null;
  }

  // ==================== 2. 首屏红→黄→绿「问题与缺口行动箱」渲染 ====================
  function renderIssueBox(issues, boxTitle) {
    const { esc, qTip } = B();
    const list = issues || [];
    const redCnt = list.filter((x) => x.level === "red").length;
    const yelCnt = list.filter((x) => x.level === "yellow").length;

    return `
      <section class="issue-box">
        <div class="issue-box-head">
          <div class="issue-box-title">
            <span>🚦 ${esc(boxTitle || "首屏红黄绿问题与缺口行动箱")}</span>
            ${qTip("gap_radar")}
            ${redCnt ? `<span class="badge badge-red">🔴 立即动手 ${redCnt}</span>` : ""}
            ${yelCnt ? `<span class="badge badge-amber">🟡 待办/待审 ${yelCnt}</span>` : ""}
            ${!redCnt && !yelCnt ? `<span class="badge badge-green">🟢 当前无阻塞项</span>` : ""}
          </div>
          <span class="cell-sub">红=现在要动手 · 黄=提醒/等审批 · 绿=正常运行</span>
        </div>
        <div class="issue-list">
          ${list.slice(0, 8).map((it) => {
            let btnAttr = `data-jump-view="${esc(it.jump_view || "overview")}"`;
            if (it.case_id) {
              btnAttr = `data-open-wizard="${esc(it.case_id)}"`;
            } else if (it.jump_view === "sup_authoring" && it.platform) {
              btnAttr = `data-start-author-plat="${esc(it.platform)}"`;
            }
            const btnCls = it.level === "red" ? "btn-danger" : it.level === "yellow" ? "btn-amber" : "btn-outline";
            return `
              <div class="issue-row ${esc(it.level)}">
                <div class="issue-main">
                  <div class="issue-headline">
                    <span class="badge ${it.level === "red" ? "badge-red" : it.level === "yellow" ? "badge-amber" : "badge-green"}">${esc(it.category)}</span>
                    <span>${esc(it.title)}</span>
                  </div>
                  <div class="issue-detail">${esc(it.detail)}</div>
                </div>
                <div class="op-btns">
                  <button type="button" class="btn ${btnCls} btn-xs" ${btnAttr}>${esc(it.action_label || "立即查看 ›")}</button>
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </section>
    `;
  }

  // ==================== 3. 老板端首屏：全维「统筹看缺口」矩阵（镶嵌在 01 总览顶部） ====================
  function renderBossGapTopSection() {
    const { state, esc, qTip, renderFoldCard } = B();
    const go = (state.boot && state.boot.gap_overview) || {};
    const lpRows = (go.lp_gap_rows || []).filter((r) => state.lpFilter === "ALL" || r.legal_person_id === state.lpFilter);
    const cov = go.tutorial_coverage || [];
    const pubCnt = cov.filter((c) => c.has_published).length;
    const missCnt = cov.filter((c) => !c.has_published).length;
    const totalShortage = lpRows.reduce((s, r) => s + (r.total_gap_count || 0), 0);

    const gapCardsHtml = lpRows.map((row) => {
      const dims = Object.entries(row.dimensions || {});
      const platGaps = (row.platform_gaps || []).filter((pg) => pg.target > 0 || pg.ready > 0 || pg.building > 0);
      return `
        <div class="gap-lp-card">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
            <div class="op-btns">
              <strong style="font-size:14px;">👤 法人矩阵统筹：${esc(row.legal_person_name)}</strong>
              ${row.total_gap_count > 0
                ? `<span class="badge badge-red">待补总缺口 ${row.total_gap_count} 项</span>`
                : `<span class="badge badge-green">✓ 标准配额已满编</span>`}
              <span class="cell-sub">${esc(row.notes || "")}</span>
            </div>
            <div class="op-btns">
              <button type="button" class="btn btn-primary btn-xs" data-open-dispatch-modal="${esc(row.legal_person_id)}">+ 按缺口派发开店单</button>
            </div>
          </div>

          <div class="gap-dim-grid">
            ${dims.map(([dk, dm]) => `
              <div class="gap-dim-box ${dm.gap > 0 ? "has-gap" : ""}">
                <span class="gap-dim-label">${esc(dm.label)}</span>
                <div class="gap-dim-nums mono">
                  <strong style="font-size:15px;color:${dm.gap > 0 ? "var(--red-ink)" : "var(--green)"};">${dm.ready}${dm.building ? `+${dm.building}建` : ""} / ${dm.target}</strong>
                  <span class="badge ${dm.gap > 0 ? "badge-red" : "badge-green"}">${dm.gap > 0 ? `缺 ${dm.gap}` : "齐"}</span>
                </div>
              </div>
            `).join("")}
          </div>

          <div class="gap-plat-strip">
            <span class="cell-sub" style="font-weight:700;align-self:center;">各平台目标/就绪/在建/缺口：</span>
            ${platGaps.map((pg) => `
              <div class="gap-plat-chip ${pg.gap > 0 ? "shortage" : pg.building > 0 ? "building" : ""}">
                <strong>${esc(pg.platform_label)}</strong>
                <span class="mono">${pg.ready}成${pg.building ? `·${pg.building}建` : ""}/${pg.target}标</span>
                ${pg.gap > 0 ? `<span class="badge badge-red">缺${pg.gap}</span>` : `<span class="badge badge-green">达标</span>`}
                ${!pg.has_tutorial ? `<span class="badge badge-amber" title="主管尚未发布该平台教程">无教程</span>` : ""}
                ${pg.gap > 0 ? `<button type="button" class="btn btn-outline btn-xs" data-quick-dispatch-lp="${esc(row.legal_person_id)}" data-quick-dispatch-plat="${esc(pg.platform)}">派单</button>` : ""}
              </div>
            `).join("")}
          </div>
        </div>
      `;
    }).join("");

    const covHtml = `
      <div style="display:flex;flex-wrap:wrap;gap:6px;">
        ${cov.map((c) => `
          <div class="gap-plat-chip ${c.has_published ? "" : "shortage"}">
            <strong>${esc(c.label)}</strong>
            ${c.has_published
              ? `<span class="badge badge-green">✓ ${c.step_count}步教程 (${esc(c.version)})</span>`
              : c.pending_status === "pending_boss"
              ? `<span class="badge badge-purple">⏳ 待老板终审 (${c.step_count}步)</span>`
              : `<span class="badge badge-red">缺教程</span>`}
          </div>
        `).join("")}
      </div>
    `;

    return `
      ${renderIssueBox(go.issues || [], "老板统筹 · 首屏红黄绿问题与缺口行动箱")}

      ${renderFoldCard({
        id: "boss:gap_matrix",
        title: `📊 全维缺口自动统筹表（法人基建缺口 + 13平台开店缺口 + 教程缺口）`,
        tipKey: "gap_radar",
        variant: totalShortage > 0 ? "warn" : "",
        pillsHtml: `
          <span class="badge ${totalShortage > 0 ? "badge-red" : "badge-green"}">${totalShortage > 0 ? `净缺口 ${totalShortage} 项` : "全满编"}</span>
          <span class="badge badge-blue">已上线教程 ${pubCnt}/${cov.length}</span>
          ${missCnt > 0 ? `<span class="badge badge-amber">${missCnt} 个平台待主管补教程</span>` : ""}
        `,
        actionHtml: `<button type="button" class="btn btn-outline btn-xs" data-jump-view="onboarding_hub">进入开店全流程监控 →</button>`,
        padded: true,
        bodyHtml: `
          ${gapCardsHtml}
          <div style="margin-top:8px;">
            <div style="font-weight:700;margin-bottom:6px;">📚 企业支付宝 + 13 类业务平台标准教程覆盖度（无教程平台禁止盲目派单）：</div>
            ${covHtml}
          </div>
        `
      })}
    `;
  }

  // ==================== 4. 老板端视图 02：开店全流程监控 · 新教程终审 · 跳步特批 ====================
  function renderBossOnboardingHub() {
    const { state, esc, qTip, matchLP, matchSearch, renderFoldCard } = B();
    const cases = ((state.boot && state.boot.onboarding_cases) || []).filter(
      (k) => matchLP(k.legal_person_id) && matchSearch(k)
    );
    const tpls = (state.boot && state.boot.tutorial_templates) || [];
    const pendingTpls = tpls.filter((t) => t.status === "pending_boss");
    const pendingSkips = (state.boot && state.boot.pending_skip_requests) || [];

    const activeCases = cases.filter((c) => c.status !== "completed");
    const completedCases = cases.filter((c) => c.status === "completed");

    return `
      <div class="page-header">
        <div>
          <h2>开店全流程双轨监控 · 教程上线终审 · 例外跳步特批 ${qTip("dual_track_gate")}</h2>
          <span class="cell-sub">每家店与每个企业支付宝均挂载手把手原子步骤教程；Gate-1(C10企业管家)与Gate-2(D15 T+1账单API核实)自动执行跨轨强关联锁死</span>
        </div>
        <div class="op-btns">
          <button type="button" class="btn btn-primary btn-sm" data-open-dispatch-modal="${esc(state.lpFilter === "ALL" ? "lp-wyq" : state.lpFilter)}">+ 新派开店/开户任务单</button>
        </div>
      </div>

      <div class="stat-strip">
        <div class="stat-pill-card">
          <div class="stat-pill-top"><span>在建开户/开店任务</span>${qTip("dual_track_gate")}</div>
          <div class="stat-pill-val"><strong class="num">${activeCases.length}</strong><span class="badge badge-amber">实时阻断追踪中</span></div>
        </div>
        <div class="stat-pill-card">
          <div class="stat-pill-top"><span>已闭环归档店铺/企支</span></div>
          <div class="stat-pill-val"><strong class="num">${completedCases.length}</strong><span class="badge badge-green">15步/18步全绿</span></div>
        </div>
        <div class="stat-pill-card">
          <div class="stat-pill-top"><span>待老板终审新教程</span></div>
          <div class="stat-pill-val"><strong class="num">${pendingTpls.length}</strong><span class="badge ${pendingTpls.length ? "badge-purple" : "badge-gray"}">${pendingTpls.length ? "主管已提审" : "无待审"}</span></div>
        </div>
        <div class="stat-pill-card">
          <div class="stat-pill-top"><span>待老板特批跳步申请</span></div>
          <div class="stat-pill-val"><strong class="num">${pendingSkips.length}</strong><span class="badge ${pendingSkips.length ? "badge-red" : "badge-gray"}">${pendingSkips.length ? "双闸风控拦截" : "无申请"}</span></div>
        </div>
      </div>

      ${pendingTpls.length > 0 ? `
      <div class="panel-card" style="border-color:var(--purple-border);margin-bottom:14px;">
        <div class="panel-head" style="background:var(--purple-bg);">
          <h3>👑 待老板终审发布的新编平台教程 (${pendingTpls.length})</h3>
          <span class="badge badge-purple">终审通过后立即消除对应平台教程缺口并允许主管派单</span>
        </div>
        <div class="table-wrap">
          <table class="ledger-table">
            <thead>
              <tr><th>编号 / 版本</th><th>适用平台</th><th>教程标题 & 摘要</th><th>编写主管</th><th>阶段 / 原子步</th><th>终审操作</th></tr>
            </thead>
            <tbody>
              ${pendingTpls.map((t) => `
                <tr>
                  <td class="mono"><strong>${esc(t.code)}</strong><span class="cell-sub">${esc(t.version)}</span></td>
                  <td><span class="badge badge-blue">${esc(t.platform || t.target_kind)}</span></td>
                  <td><strong>${esc(t.title)}</strong><span class="cell-sub">${esc(t.summary)}</span></td>
                  <td>${esc(t.author_staff)}</td>
                  <td class="mono">${t.stage_count} 阶段 · <strong>${t.step_count} 步</strong></td>
                  <td>
                    <div class="op-btns">
                      <button type="button" class="btn btn-outline btn-xs" data-preview-tpl="${esc(t.id)}">预览步骤</button>
                      <button type="button" class="btn btn-success btn-xs" data-boss-tpl-verdict="${esc(t.id)}" data-verdict="approve">✓ 批准正式上线</button>
                      <button type="button" class="btn btn-danger btn-xs" data-boss-tpl-verdict="${esc(t.id)}" data-verdict="reject">打回修改</button>
                    </div>
                  </td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>` : ""}

      ${pendingSkips.length > 0 ? `
      <div class="panel-card" style="border-color:var(--red-border);margin-bottom:14px;">
        <div class="panel-head" style="background:var(--red-bg);">
          <h3>🛡 待老板特批的员工跳步申请 (${pendingSkips.length})</h3>
          <span class="badge badge-red">双闸严控：批准后步骤记为 skipped，驳回后员工必须按规补齐</span>
        </div>
        <div class="table-wrap">
          <table class="ledger-table">
            <thead>
              <tr><th>申请店铺/账户</th><th>申请跳过步骤</th><th>员工申请理由</th><th>申请人 / 时间</th><th>老板裁决</th></tr>
            </thead>
            <tbody>
              ${pendingSkips.map((sk) => `
                <tr>
                  <td><strong>${esc(sk.case_title)}</strong></td>
                  <td class="mono"><span class="badge badge-amber">${esc(sk.step_code)}</span></td>
                  <td>${esc(sk.reason)}</td>
                  <td>${esc(sk.requested_by)}<span class="cell-sub mono">${esc(sk.requested_at)}</span></td>
                  <td>
                    <div class="op-btns">
                      <button type="button" class="btn btn-outline btn-xs" data-open-wizard="${esc(sk.case_id)}" data-wizard-step="${esc(sk.step_code)}">查看上下文</button>
                      <button type="button" class="btn btn-amber btn-xs" data-boss-skip-verdict="${esc(sk.id)}" data-verdict="approve">特批允许跳过</button>
                      <button type="button" class="btn btn-danger btn-xs" data-boss-skip-verdict="${esc(sk.id)}" data-verdict="reject">严词驳回</button>
                    </div>
                  </td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>` : ""}

      <div class="panel-card" style="margin-bottom:14px;">
        <div class="panel-head">
          <h3>🚧 正在推进 / 卡点阻断中的开户与开店任务 (${activeCases.length})</h3>
          <span class="cell-sub">点击「打开步进教程」可直接查看该店 15/18 步全节点轨道、跨轨锁原因、提交材料与审核记录</span>
        </div>
        <div class="table-wrap">
          <table class="ledger-table">
            <thead>
              <tr>
                <th>任务对象</th>
                <th>轨道类型</th>
                <th>负责员工 / 主管</th>
                <th>步骤进度</th>
                <th>当前停留节点 & 阻断诊断</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              ${activeCases.length === 0 ? `<tr><td colspan="6">当前所有在册任务均已 100% 闭环！</td></tr>` : activeCases.map((k) => `
                <tr class="${k.has_rejected ? "row-danger" : k.cross_blocked_msg ? "row-warn" : ""}">
                  <td>
                    <strong>${esc(k.case_title)}</strong>
                    <span class="cell-sub">${esc(k.template_title)}</span>
                  </td>
                  <td>
                    <span class="badge ${k.target_kind === "alipay" ? "badge-purple" : "badge-green"}">
                      ${k.target_kind === "alipay" ? "💳 企支开户15步轨" : "🐟 闲鱼开店18步轨"}
                    </span>
                  </td>
                  <td><strong>${esc(k.assigned_staff)}</strong><span class="cell-sub">审：${esc(k.supervisor_staff)}</span></td>
                  <td>
                    <span class="mono"><strong>${k.done_steps}/${k.total_steps}</strong> (${k.progress_pct}%)</span>
                    <div class="progress-bar"><div class="progress-fill ${k.has_rejected ? "danger" : k.cross_blocked_msg ? "warn" : ""}" style="width:${k.progress_pct}%"></div></div>
                  </td>
                  <td>
                    ${caseSummaryBadge(k)}
                    <span class="cell-sub">${esc(k.cross_blocked_msg || k.current_step_title || "-")}</span>
                  </td>
                  <td>
                    <div class="op-btns">
                      <button type="button" class="btn btn-primary btn-xs" data-open-wizard="${esc(k.id)}">📖 打开步进教程</button>
                      ${k.linked_alipay_case_id ? `<button type="button" class="btn btn-outline btn-xs" data-open-wizard="${esc(k.linked_alipay_case_id)}">🔗 看关联企支</button>` : ""}
                    </div>
                  </td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>

      ${renderFoldCard({
        id: "boss:completed_cases",
        title: `✅ 已完成全部建店/开户验收的存量档案 (${completedCases.length})`,
        pillsHtml: `<span class="badge badge-green">随时可点开回溯每一步留痕证据与手把手教程</span>`,
        bodyHtml: `
          <div class="table-wrap">
            <table class="ledger-table">
              <thead>
                <tr><th>账户/店铺</th><th>适用教程</th><th>经办员工</th><th>完成进度</th><th>归档日期</th><th>回溯</th></tr>
              </thead>
              <tbody>
                ${completedCases.map((k) => `
                  <tr>
                    <td><strong>${esc(k.case_title)}</strong></td>
                    <td>${esc(k.template_title)}</td>
                    <td>${esc(k.assigned_staff)}</td>
                    <td><span class="badge badge-green">✓ ${k.done_steps}/${k.total_steps} 步全绿</span></td>
                    <td class="mono">${esc(k.completed_at || "-")}</td>
                    <td><button type="button" class="btn btn-outline btn-xs" data-open-wizard="${esc(k.id)}">查阅步骤留痕</button></td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        `
      })}
    `;
  }

  // ==================== 5. 主管端视图 S1：日常步骤材料审核台 ====================
  function renderSupervisorReviewsView() {
    const { state, esc, qTip } = B();
    const go = (state.boot && state.boot.gap_overview) || {};
    const cases = (state.boot && state.boot.onboarding_cases) || [];
    const pendingCases = cases.filter((c) => c.has_pending_review);
    const blockedOrRej = cases.filter((c) => c.status !== "completed" && !c.has_pending_review);

    return `
      <div class="page-header">
        <div>
          <h2>🧭 主管端 · 开店步骤材料审核与卡点疏通台 ${qTip("dual_track_gate")}</h2>
          <span class="cell-sub">主管职责：审核员工提交的关键防呆节点材料（通过后自动放行下游关联闲鱼店认证/上架；打回时历史驳回意见永久保留不覆盖）</span>
        </div>
      </div>

      ${renderIssueBox(go.issues || [], "主管周安 · 今日优先审核与教程编排行动箱")}

      <div class="panel-card" style="margin-bottom:14px;border-color:var(--amber-border);">
        <div class="panel-head" style="background:var(--amber-bg);">
          <h3>⏳ 待主管立即审核的步骤材料 (${pendingCases.length})</h3>
          <span class="badge badge-amber">例如审过企支 D15 即可立即解锁关联闲鱼店 S18 上架开售！</span>
        </div>
        <div class="table-wrap">
          <table class="ledger-table">
            <thead>
              <tr><th>提审账户/店铺</th><th>轨道</th><th>提交员工</th><th>待审步骤</th><th>当前总进度</th><th>审核操作</th></tr>
            </thead>
            <tbody>
              ${pendingCases.length === 0 ? `<tr><td colspan="6">当前待审队列已清空！</td></tr>` : pendingCases.map((k) => `
                <tr>
                  <td><strong>${esc(k.case_title)}</strong><span class="cell-sub">${esc(k.notes)}</span></td>
                  <td><span class="badge ${k.target_kind === "alipay" ? "badge-purple" : "badge-green"}">${k.target_kind === "alipay" ? "企业支付宝轨" : "闲鱼店铺轨"}</span></td>
                  <td><strong>${esc(k.assigned_staff)}</strong></td>
                  <td><span class="badge badge-amber">${esc(k.current_step_code)} · ${esc(k.current_step_title)}</span></td>
                  <td class="mono">${k.done_steps}/${k.total_steps}</td>
                  <td>
                    <button type="button" class="btn btn-primary btn-xs" data-open-wizard="${esc(k.id)}" data-wizard-step="${esc(k.current_step_code)}">🔍 审阅材料并裁决</button>
                  </td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>

      <div class="panel-card">
        <div class="panel-head">
          <h3>📋 团队其余在建任务跟进表 (${blockedOrRej.length})</h3>
        </div>
        <div class="table-wrap">
          <table class="ledger-table">
            <thead>
              <tr><th>账户/店铺</th><th>负责员工</th><th>当前进度</th><th>实时状态与跨轨锁诊断</th><th>操作</th></tr>
            </thead>
            <tbody>
              ${blockedOrRej.map((k) => `
                <tr>
                  <td><strong>${esc(k.case_title)}</strong></td>
                  <td>${esc(k.assigned_staff)}</td>
                  <td class="mono">${k.done_steps}/${k.total_steps} (${k.progress_pct}%)</td>
                  <td>${caseSummaryBadge(k)} <span class="cell-sub">${esc(k.cross_blocked_msg || k.notes)}</span></td>
                  <td><button type="button" class="btn btn-outline btn-xs" data-open-wizard="${esc(k.id)}">查看详情</button></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ==================== 6. 主管端视图 S2：教程编排工坊（含元教程 8 步指引 + 可视化三层编辑器） ====================
  function renderSupervisorAuthoringView() {
    const { state, esc, qTip, renderFoldCard } = B();
    const go = (state.boot && state.boot.gap_overview) || {};
    const cov = go.tutorial_coverage || [];
    const tpls = (state.boot && state.boot.tutorial_templates) || [];
    const draft = state.authorDraft;

    return `
      <div class="page-header">
        <div>
          <h2>🧭 主管端 · 各平台开店教程实操编排工坊 ${qTip("role_3portals")}</h2>
          <span class="cell-sub">主管先跑通 1 家样板店并全程录屏截图 → 按「阶段 → 原子步骤 → 材料+红色防呆+跨轨锁」编排 → 提交老板终审上线后即可向员工批量派单</span>
        </div>
        <div class="op-btns">
          <button type="button" class="btn btn-outline btn-sm" data-preview-tpl="tpl-authoring-meta">📘 阅读《主管做教程8步工作法》</button>
          <button type="button" class="btn btn-primary btn-sm" data-start-author-plat="xiaohongshu_shop">+ 新建空白平台开店教程</button>
        </div>
      </div>

      <div class="panel-card" style="margin-bottom:14px;">
        <div class="panel-head">
          <h3>🎯 13 类业务平台 + 企业支付宝 教程覆盖与缺口矩阵</h3>
          <span class="cell-sub">点击任意「缺教程」平台右侧按钮，即可一键按标准模板骨架创建该平台开店教程</span>
        </div>
        <div class="table-wrap">
          <table class="ledger-table">
            <thead>
              <tr><th>平台/对象</th><th>当前教程状态</th><th>已发布版本 & 步骤数</th><th>草稿/待老板终审</th><th>主管操作</th></tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>💳 企业支付宝（强关联基座）</strong></td>
                <td><span class="badge badge-green">✓ 已上线运行</span></td>
                <td class="mono">v2.4 · 15 原子步（含 C10 / D15 双闸）</td>
                <td>-</td>
                <td><button type="button" class="btn btn-outline btn-xs" data-edit-tpl="tpl-alipay-ent">查看/修订模板</button></td>
              </tr>
              ${cov.map((c) => {
                const matchTpl = tpls.find((t) => t.platform === c.platform);
                return `
                  <tr class="${!c.has_published ? "row-warn" : ""}">
                    <td><strong>${esc(c.label)}</strong> <span class="cell-sub mono">(${esc(c.platform)})</span></td>
                    <td>
                      ${c.has_published
                        ? `<span class="badge badge-green">✓ 已正式发布</span>`
                        : c.pending_status === "pending_boss"
                        ? `<span class="badge badge-purple">⏳ 已交老板终审</span>`
                        : c.pending_status === "draft"
                        ? `<span class="badge badge-amber">📝 草稿编写中</span>`
                        : `<span class="badge badge-red">⚠️ 空白缺教程</span>`}
                    </td>
                    <td class="mono">${c.has_published ? `${esc(c.version)} · ${c.step_count} 步` : "-"}</td>
                    <td>${!c.has_published && c.pending_status ? `${esc(c.pending_status)} (${c.step_count}步)` : "-"}</td>
                    <td>
                      <div class="op-btns">
                        ${matchTpl
                          ? `<button type="button" class="btn btn-outline btn-xs" data-edit-tpl="${esc(matchTpl.id)}">✏️ 编辑此教程</button>
                             <button type="button" class="btn btn-outline btn-xs" data-preview-tpl="${esc(matchTpl.id)}">预览</button>`
                          : `<button type="button" class="btn btn-primary btn-xs" data-start-author-plat="${esc(c.platform)}">+ 立即编写此平台教程</button>`}
                      </div>
                    </td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      </div>

      ${draft ? renderAuthoringEditorCard(draft) : renderFoldCard({
        id: "sup:tpl_list",
        title: `📚 现有全部教程库 (${tpls.length} 套：含企业支付宝15步、闲鱼18步、微信小店、做教程元指南)`,
        pillsHtml: `<span class="badge badge-blue">点击任意模板「编辑」即可打开三层可视化步骤编排器</span>`,
        bodyHtml: `
          <div class="table-wrap">
            <table class="ledger-table">
              <thead><tr><th>编码</th><th>教程名称</th><th>状态</th><th>阶段/步骤</th><th>单店悬赏</th><th>操作</th></tr></thead>
              <tbody>
                ${tpls.map((t) => `
                  <tr>
                    <td class="mono"><strong>${esc(t.code)}</strong> (${esc(t.version)})</td>
                    <td><strong>${esc(t.title)}</strong><span class="cell-sub">${esc(t.summary)}</span></td>
                    <td><span class="badge ${t.status === "published" ? "badge-green" : t.status === "pending_boss" ? "badge-purple" : "badge-amber"}">${esc(t.status)}</span></td>
                    <td class="mono">${t.stage_count} 阶段 / ${t.step_count} 步</td>
                    <td class="mono">${t.reward_points}分 · ¥${t.reward_yuan}</td>
                    <td>
                      <div class="op-btns">
                        <button type="button" class="btn btn-primary btn-xs" data-edit-tpl="${esc(t.id)}">✏️ 打开编排器</button>
                        <button type="button" class="btn btn-outline btn-xs" data-preview-tpl="${esc(t.id)}">只读预览</button>
                      </div>
                    </td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        `
      })}
    `;
  }

  function renderAuthoringEditorCard(draft) {
    const { state, esc } = B();
    const platLabels = (state.boot && state.boot.meta && state.boot.meta.platform_labels) || {};
    return `
      <div class="panel-card" id="authoring-studio-card" style="border:2px solid var(--purple);padding:16px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;border-bottom:1px solid var(--border-light);padding-bottom:10px;">
          <div>
            <span class="badge badge-purple">🛠 三层可视化教程编排器（阶段 → 原子步骤 → 防呆红字 & 材料 & 跨轨锁）</span>
            <h3 style="margin:4px 0 0;">正在编排：${esc(draft.title || "新建平台开店教程")}</h3>
          </div>
          <div class="op-btns">
            <button type="button" class="btn btn-outline btn-sm" id="btn-close-author">收起编辑器</button>
            <button type="button" class="btn btn-outline btn-sm" data-save-author="0">💾 保存草稿</button>
            <button type="button" class="btn btn-primary btn-sm" data-save-author="1">🚀 保存并提交老板终审</button>
          </div>
        </div>

        <div class="form-grid" style="margin-bottom:14px;">
          <div class="form-field">
            <label>教程唯一编码 *</label>
            <input id="au-code" class="input-control mono" value="${esc(draft.code)}" />
          </div>
          <div class="form-field">
            <label>适用业务平台 *</label>
            <select id="au-platform" class="select-control">
              <option value="" ${!draft.platform ? "selected" : ""}>-- 企业支付宝或元教程 --</option>
              ${Object.entries(platLabels).map(([k, v]) => `<option value="${esc(k)}" ${draft.platform === k ? "selected" : ""}>${esc(v)} (${esc(k)})</option>`).join("")}
            </select>
          </div>
          <div class="form-field">
            <label>教程标题 *</label>
            <input id="au-title" class="input-control" value="${esc(draft.title)}" />
          </div>
          <div class="form-field">
            <label>版本号 / 建店SLA天数 / 积分奖励</label>
            <div class="op-btns">
              <input id="au-version" class="input-control mono" style="width:90px;" value="${esc(draft.version || "v1.0")}" />
              <input id="au-sla" type="number" class="input-control mono" style="width:85px;" value="${draft.sla_days || 14}" title="SLA天数" />
              <input id="au-points" type="number" class="input-control mono" style="width:85px;" value="${draft.reward_points || 8}" title="奖励积分" />
            </div>
          </div>
          <div class="form-field span-2">
            <label>教程总摘要与防关联核心原则</label>
            <input id="au-summary" class="input-control" value="${esc(draft.summary || "")}" />
          </div>
        </div>

        <div id="au-stages-wrap">
          ${(draft.stages || []).map((stg, sIdx) => `
            <div class="author-stage-card" data-stg-idx="${sIdx}">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
                <div class="op-btns" style="flex:1;">
                  <span class="badge badge-blue">阶段 ${sIdx + 1}</span>
                  <input class="input-control mono au-stg-code" data-sidx="${sIdx}" style="width:105px;" value="${esc(stg.stage_code || stg.code || `P${sIdx + 1}`)}" placeholder="阶段编码" />
                  <input class="input-control au-stg-title" data-sidx="${sIdx}" style="flex:1;" value="${esc(stg.title || "")}" placeholder="阶段标题" />
                  <input class="input-control au-stg-dur" data-sidx="${sIdx}" style="width:130px;" value="${esc(stg.duration_note || stg.duration || "当天完成")}" placeholder="耗时提示" />
                </div>
                <div class="op-btns">
                  <button type="button" class="btn btn-outline btn-xs" data-au-add-step="${sIdx}">+ 加原子步骤</button>
                  ${draft.stages.length > 1 ? `<button type="button" class="btn btn-danger btn-xs" data-au-del-stage="${sIdx}">删阶段</button>` : ""}
                </div>
              </div>

              ${(stg.steps || []).map((stp, pIdx) => {
                const firstMat = (stp.materials && stp.materials[0]) || {};
                const matLabel = Array.isArray(firstMat) ? firstMat[1] : (firstMat.label || "");
                const matKey = Array.isArray(firstMat) ? firstMat[0] : (firstMat.field_key || `m_${sIdx}_${pIdx}`);
                return `
                  <div class="author-step-card">
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">
                      <div class="op-btns" style="flex:1;">
                        <input class="input-control mono au-stp-code" data-sidx="${sIdx}" data-pidx="${pIdx}" style="width:76px;font-weight:700;" value="${esc(stp.step_code || stp.code || `S0${pIdx + 1}`)}" />
                        <input class="input-control au-stp-title" data-sidx="${sIdx}" data-pidx="${pIdx}" style="flex:1;font-weight:700;" value="${esc(stp.title || "")}" placeholder="步骤动作标题（一句话动宾结构）" />
                      </div>
                      <div class="op-btns">
                        <label style="font-size:11.5px;display:inline-flex;align-items:center;gap:4px;">
                          <input type="checkbox" class="au-stp-rev" data-sidx="${sIdx}" data-pidx="${pIdx}" ${stp.require_review ? "checked" : ""} /> 需主管审材料
                        </label>
                        <label style="font-size:11.5px;display:inline-flex;align-items:center;gap:4px;">
                          <input type="checkbox" class="au-stp-lockin" data-sidx="${sIdx}" data-pidx="${pIdx}" ${stp.unlock_vault_lockin ? "checked" : ""} /> 含密码单向锁库
                        </label>
                        ${stg.steps.length > 1 ? `<button type="button" class="btn btn-danger btn-xs" data-au-del-step="${sIdx}:${pIdx}">✕</button>` : ""}
                      </div>
                    </div>
                    <div class="form-grid">
                      <div class="form-field">
                        <label>手把手操作指引 (guide)</label>
                        <textarea class="input-control au-stp-guide" data-sidx="${sIdx}" data-pidx="${pIdx}" rows="2">${esc(stp.guide || "")}</textarea>
                      </div>
                      <div class="form-field">
                        <label style="color:var(--red-ink);">🚨 红色平铺防呆警告 (warn_text · 严禁踩坑红线)</label>
                        <textarea class="input-control au-stp-warn" data-sidx="${sIdx}" data-pidx="${pIdx}" rows="2">${esc(stp.warn_text || stp.warn || "")}</textarea>
                      </div>
                      <div class="form-field">
                        <label>员工必填留痕材料名称（禁空禁0校验）</label>
                        <input class="input-control au-stp-mat" data-sidx="${sIdx}" data-pidx="${pIdx}" data-matkey="${esc(matKey)}" value="${esc(matLabel)}" placeholder="如：实名通过回执截图 / 商户号 mch_id" />
                      </div>
                      <div class="form-field">
                        <label>跨轨强关联锁规则 (选填，如 require_alipay_step:C10 或 D15)</label>
                        <input class="input-control mono au-stp-gate" data-sidx="${sIdx}" data-pidx="${pIdx}" value="${esc(stp.cross_gate_rule || "")}" placeholder="留空无跨轨锁；填 require_alipay_step:C10 锁企业认证" />
                      </div>
                    </div>
                  </div>
                `;
              }).join("")}
            </div>
          `).join("")}
        </div>

        <div style="display:flex;justify-content:space-between;margin-top:10px;">
          <button type="button" class="btn btn-outline btn-sm" id="btn-au-add-stage">+ 新增一个教程阶段</button>
          <div class="op-btns">
            <button type="button" class="btn btn-outline btn-sm" data-save-author="0">💾 仅保存草稿</button>
            <button type="button" class="btn btn-primary btn-sm" data-save-author="1">🚀 提交给老板终审上线</button>
          </div>
        </div>
      </div>
    `;
  }

  // ==================== 7. 主管端视图 S3：缺口统筹派单与员工负载 ====================
  function renderSupervisorDispatchView() {
    const { state, esc, qTip } = B();
    const go = (state.boot && state.boot.gap_overview) || {};
    const workloads = go.staff_workload || [];
    const lpRows = go.lp_gap_rows || [];

    return `
      <div class="page-header">
        <div>
          <h2>🧭 主管端 · 缺口统筹拆单与员工开店负载面板 ${qTip("gap_radar")}</h2>
          <span class="cell-sub">按法人标准配额缺口向员工派发重复性建店任务单（系统硬防呆：若目标平台尚无已发布教程，禁止盲派裸单）</span>
        </div>
        <button type="button" class="btn btn-primary btn-sm" data-open-dispatch-modal="lp-wyq">+ 新建派单任务</button>
      </div>

      <div class="stat-strip">
        ${workloads.map((w) => `
          <div class="stat-pill-card">
            <div class="stat-pill-top"><span>🛠 员工：${esc(w.staff)}</span></div>
            <div class="stat-pill-val">
              <strong class="num">${w.in_progress} 在建</strong>
              <span class="badge ${w.rejected > 0 ? "badge-red" : "badge-green"}">${w.rejected > 0 ? `${w.rejected} 被打回` : `已完 ${w.completed}`}</span>
            </div>
          </div>
        `).join("")}
      </div>

      ${lpRows.map((row) => `
        <div class="gap-lp-card">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <strong>👤 ${esc(row.legal_person_name)} · 待补总缺口 ${row.total_gap_count} 项</strong>
            <button type="button" class="btn btn-primary btn-xs" data-open-dispatch-modal="${esc(row.legal_person_id)}">+ 针对此法人派单</button>
          </div>
          <div class="gap-plat-strip">
            ${(row.platform_gaps || []).filter((pg) => pg.target > 0).map((pg) => `
              <div class="gap-plat-chip ${pg.gap > 0 ? "shortage" : ""}">
                <strong>${esc(pg.platform_label)}</strong>
                <span class="mono">目标${pg.target} / 就绪${pg.ready} / 在建${pg.building}</span>
                ${pg.gap > 0
                  ? pg.has_tutorial
                    ? `<button type="button" class="btn btn-primary btn-xs" data-quick-dispatch-lp="${esc(row.legal_person_id)}" data-quick-dispatch-plat="${esc(pg.platform)}">派单补缺(${pg.gap})</button>`
                    : `<button type="button" class="btn btn-amber btn-xs" data-start-author-plat="${esc(pg.platform)}" title="Lock阻断：该平台尚无已上线教程，请先编写教程">🔒 先补教程</button>`
                  : `<span class="badge badge-green">✓ 满编</span>`}
              </div>
            `).join("")}
          </div>
        </div>
      `).join("")}
    `;
  }

  // ==================== 8. 员工端视图 E1：今日手把手开店任务台 ====================
  function renderEmployeeTasksView() {
    const { state, esc, qTip } = B();
    const go = (state.boot && state.boot.gap_overview) || {};
    const staff = state.viewerStaff;
    const myCases = ((state.boot && state.boot.onboarding_cases) || []).filter((c) => c.assigned_staff === staff);
    const activeMyCases = myCases.filter((c) => c.status !== "completed");
    const doneMyCases = myCases.filter((c) => c.status === "completed");

    return `
      <div class="page-header">
        <div>
          <h2>🛠 员工端（${esc(staff)}）· 手把手开店与开户任务执行台 ${qTip("dual_track_gate")}</h2>
          <span class="cell-sub">无需死记二三十个开店节点！点开任意任务卡即按「一步一屏」手把手执行，后续未解锁步骤亦可点击只读预览提前备料</span>
        </div>
        <div class="op-btns">
          <button type="button" class="btn btn-outline btn-sm" data-jump-view="emp_adspower">🔐 去领用我的专窗 & 6位动态码 →</button>
        </div>
      </div>

      ${renderIssueBox(go.issues || [], `${staff} · 今日待办红黄绿行动箱`)}

      <div class="panel-card" style="margin-bottom:14px;">
        <div class="panel-head">
          <h3>📌 我名下正在推进的开户/开店任务 (${activeMyCases.length})</h3>
          <span class="badge badge-green">按序通关 · 防呆红字必读 · 严禁填 0</span>
        </div>
        ${activeMyCases.length === 0
          ? `<div class="panel-body">🎉 当前你名下暂无未完结的建店任务！可在下方查阅已归档店铺或切换顶栏员工视角体验。</div>`
          : `<div class="table-wrap">
              <table class="ledger-table">
                <thead>
                  <tr><th>店铺 / 支付宝名称</th><th>绑定教程</th><th>当前进度</th><th>当前待办步骤与锁状态</th><th>立即实操</th></tr>
                </thead>
                <tbody>
                  ${activeMyCases.map((k) => `
                    <tr class="${k.has_rejected ? "row-danger" : k.cross_blocked_msg ? "row-warn" : ""}">
                      <td><strong>${esc(k.case_title)}</strong><span class="cell-sub">${esc(k.notes)}</span></td>
                      <td><span class="badge ${k.target_kind === "alipay" ? "badge-purple" : "badge-blue"}">${esc(k.template_title)}</span></td>
                      <td>
                        <span class="mono"><strong>${k.done_steps}/${k.total_steps}</strong> (${k.progress_pct}%)</span>
                        <div class="progress-bar"><div class="progress-fill ${k.has_rejected ? "danger" : k.cross_blocked_msg ? "warn" : ""}" style="width:${k.progress_pct}%"></div></div>
                      </td>
                      <td>
                        ${caseSummaryBadge(k)}
                        <span class="cell-sub">${esc(k.cross_blocked_msg || k.current_step_title || "")}</span>
                      </td>
                      <td>
                        <div class="op-btns">
                          <button type="button" class="btn btn-primary btn-xs" data-open-wizard="${esc(k.id)}">👉 进入手把手步骤</button>
                          ${k.linked_alipay_case_id ? `<button type="button" class="btn btn-outline btn-xs" data-open-wizard="${esc(k.linked_alipay_case_id)}">🔗 去办关联企支</button>` : ""}
                        </div>
                      </td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            </div>`}
      </div>

      <details class="panel-card">
        <summary style="padding:11px 16px;cursor:pointer;font-weight:700;">✅ 我已完成归档的店铺与支付宝 (${doneMyCases.length})</summary>
        <div class="table-wrap">
          <table class="ledger-table">
            <thead><tr><th>名称</th><th>教程</th><th>步骤闭环</th><th>完成时间</th><th>查看</th></tr></thead>
            <tbody>
              ${doneMyCases.map((k) => `
                <tr>
                  <td><strong>${esc(k.case_title)}</strong></td>
                  <td>${esc(k.template_title)}</td>
                  <td><span class="badge badge-green">✓ ${k.done_steps}/${k.total_steps}</span></td>
                  <td class="mono">${esc(k.completed_at || "-")}</td>
                  <td><button type="button" class="btn btn-outline btn-xs" data-open-wizard="${esc(k.id)}">复盘教程</button></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </details>
    `;
  }

  // ==================== 9. 员工端视图 E2：免明文托管 AdsPower 专窗 & 6位 Authenticator 动态码领用台 ====================
  function renderEmployeeAdsPowerView() {
    const { state, esc, qTip } = B();
    const staff = state.viewerStaff;
    const items = ((state.boot && state.boot.vault && state.boot.vault.items) || []);
    const adsById = {};
    for (const w of ((state.boot && state.boot.adspower_profiles) || [])) {
      adsById[w.id] = w;
    }

    return `
      <div class="page-header">
        <div>
          <h2>🔐 员工端（${esc(staff)}）· 免明文托管专窗 & AdsPower Authenticator 领用台 ${qTip("adspower_blind_custody")}</h2>
          <span class="cell-sub">零明文泄露铁律：登录密码已由系统加密同步至 AdsPower 自动填充（员工调明文接口硬返 403）；此处仅提供本人授权专窗一键拉起与 6 位实时动态验证码</span>
        </div>
      </div>

      <div class="warn-flat-box" style="border-left-color:var(--blue);background:#eff6ff;border-color:#bfdbfe;color:#1e3a8a;">
        🛡 安全边界说明：您当前以【员工：${esc(staff)}】身份登录，仅可见分配在您名下的 ${items.length} 个业务账号凭证槽。登录密码全程免明文托管，遇到二次验证请点击右侧「获取 6 位 Authenticator 动态码」。
      </div>

      <div class="emp-vault-grid">
        ${items.length === 0 ? `<div class="panel-card"><div class="panel-body">当前员工名下暂无关联授权账号。</div></div>` : items.map((it) => {
          const otpObj = state.empTotpCache[it.id];
          const adsWin = it.adspower_profile_id ? adsById[it.adspower_profile_id] : null;
          return `
            <div class="panel-card" style="padding:14px 16px;">
              <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">
                <div>
                  <span class="badge ${it.category === "alipay" ? "badge-purple" : "badge-green"}">${it.category === "alipay" ? "企业支付宝" : "业务平台号"}</span>
                  ${adsWin ? `<span class="badge badge-blue mono">🪟 ${esc(adsWin.profile_code)} (#${esc(adsWin.ads_serial_no)})</span>` : `<span class="badge badge-gray">真机App端</span>`}
                  <h3 style="margin:6px 0 2px;font-size:14.5px;">${esc(it.title)}</h3>
                  <div class="cell-sub mono">登录名：${esc(it.login_account)} · 登录密码：<strong>🔒 免明文托管(AdsPower自动填充)</strong></div>
                </div>
                <span class="badge ${it.adspower_sync_status === "synced" ? "badge-green" : "badge-gray"}">
                  ${it.adspower_sync_status === "synced" ? "✓ 已桥接AdsPower" : "本地托管"}
                </span>
              </div>

              <div style="margin-top:12px;padding-top:10px;border-top:1px dashed var(--border-light);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
                <div class="op-btns">
                  ${adsWin ? `<button type="button" class="btn btn-primary btn-xs" data-open-adspower-win="${esc(adsWin.id)}">🚀 一键拉起 AdsPower 专窗</button>` : ""}
                  ${it.has_totp && it.employee_totp_enabled
                    ? `<button type="button" class="btn btn-outline btn-xs" data-emp-fetch-totp="${esc(it.id)}">🔢 ${otpObj ? "刷新动态码" : "获取 6 位 Authenticator 码"}</button>`
                    : `<span class="cell-sub">无需 2FA 动态码</span>`}
                </div>

                ${otpObj ? `
                  <div class="op-btns">
                    <div class="emp-totp-display mono" title="RFC 6238 实时 6 位验证码（与 AdsPower Authenticator 同源）">
                      <span>${esc(otpObj.code)}</span>
                      <span style="font-size:11px;letter-spacing:0;color:#fde047;">剩 ${otpObj.remaining_seconds}s</span>
                    </div>
                    <button type="button" class="btn btn-outline btn-xs" data-copy-raw="${esc(otpObj.code)}">复制验证码</button>
                  </div>
                ` : ""}
              </div>
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  // ==================== 10. 一步一屏开店教程大弹窗（支持15步企支↔18步闲鱼双轨跳切、locked只读预览、材料禁0、单向锁密、主管审核、双闸跳步） ====================
  async function openWizardModal(caseId, preferStepCode = null) {
    const { state, apiCall, toast, esc } = B();
    try {
      const res = await apiCall(`/api/onboarding/case?id=${encodeURIComponent(caseId)}`);
      const detail = res.data;
      state.activeWizardCaseId = caseId;
      state.activeWizardDetail = detail;

      const allSteps = [];
      for (const stg of detail.stages || []) {
        for (const stp of stg.steps || []) allSteps.push(stp);
      }
      const chosenCode = preferStepCode || detail.current_step_code || (allSteps[0] && allSteps[0].step_code);
      state.activeWizardStepCode = chosenCode;

      renderActiveWizardModal();
      document.getElementById("wizard-modal-backdrop").classList.remove("hidden");
      document.getElementById("wizard-modal").classList.remove("hidden");
    } catch (e) {
      toast("加载开店教程实例失败：" + e.message, "error");
    }
  }

  function closeWizardModal() {
    const { state } = B();
    state.activeWizardCaseId = null;
    state.activeWizardDetail = null;
    document.getElementById("wizard-modal-backdrop").classList.add("hidden");
    document.getElementById("wizard-modal").classList.add("hidden");
  }

  function renderActiveWizardModal() {
    const { state, esc } = B();
    const d = state.activeWizardDetail;
    if (!d) return;

    const headLeft = document.getElementById("wizard-modal-head-left");
    const bodyEl = document.getElementById("wizard-modal-body");

    const allSteps = [];
    for (const stg of d.stages || []) {
      for (const stp of stg.steps || []) allSteps.push({ ...stp, stage_title: stg.title, stage_code: stg.stage_code });
    }
    const focusStep = allSteps.find((s) => s.step_code === state.activeWizardStepCode) || allSteps[0];
    const isReadonlyPreview = focusStep && focusStep.step_state === "locked";

    headLeft.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span class="badge ${d.target_kind === "alipay" ? "badge-purple" : "badge-green"}">
          ${d.target_kind === "alipay" ? "💳 企业支付宝 15 步开户轨" : "🐟 闲鱼店铺 18 步建店轨"}
        </span>
        <strong style="font-size:16px;">${esc(d.case_title)}</strong>
        <span class="badge badge-blue mono">总进度 ${d.done_steps}/${d.total_steps} (${d.progress_pct}%)</span>
        <span class="cell-sub">负责员工：<strong>${esc(d.assigned_staff)}</strong> · 审核主管：<strong>${esc(d.supervisor_staff)}</strong> · 当前视角：<strong>${esc(state.viewerRole)} (${esc(state.viewerStaff)})</strong></span>
      </div>
    `;

    // 顶部双轨强关联状态条
    let dualBarHtml = "";
    if (d.linked_alipay_case) {
      const ali = d.linked_alipay_case;
      const c10Ok = (ali.approved_codes || []).includes("C10");
      const d15Ok = (ali.approved_codes || []).includes("D15");
      dualBarHtml = `
        <div class="dual-track-bar ${!c10Ok || !d15Ok ? "locked" : ""}">
          <div>
            <strong>🔗 企支 ↔ 闲鱼双轨强关联实时门禁：</strong>
            <span>上游绑定企业支付宝 <b>${esc(ali.case_title)}</b></span>
            <span class="badge ${c10Ok ? "badge-green" : "badge-red"}" style="margin-left:6px;">Gate-1 (C10第1天企业管家授权→解锁S09企业认证): ${c10Ok ? "✓ 已放行" : "🔒 未完成锁死"}</span>
            <span class="badge ${d15Ok ? "badge-green" : "badge-amber"}" style="margin-left:6px;">Gate-2 (D15唯一0.xx元+T+1账单API核实→解锁S18开售): ${d15Ok ? "✓ 已放行" : "🔒 待核实锁死"}</span>
          </div>
          <button type="button" class="btn btn-primary btn-xs" data-open-wizard="${esc(ali.id)}">👉 切换至上游企业支付宝教程 (${ali.approved_codes.length}/15步) →</button>
        </div>
      `;
    } else if (d.target_kind === "alipay") {
      const downStores = ((state.boot && state.boot.onboarding_cases) || []).filter((x) => x.linked_alipay_case_id === d.id);
      if (downStores.length > 0) {
        dualBarHtml = `
          <div class="dual-track-bar">
            <div>
              <strong>🔗 下游强关联闲鱼店铺 (${downStores.length} 家)：</strong>
              <span class="cell-sub">本支付宝完成 <b>C10</b> 自动解锁下游店铺 S09 企业认证；完成 <b>D15</b> 自动解锁下游店铺 S18 正式开售！</span>
            </div>
            <div class="op-btns">
              ${downStores.map((ds) => `<button type="button" class="btn btn-outline btn-xs" data-open-wizard="${esc(ds.id)}">🐟 看 ${esc(ds.case_title)} (${ds.done_steps}/${ds.total_steps})</button>`).join("")}
            </div>
          </div>
        `;
      }
    }

    // 阶段与全部节点横向可视轨道
    const railHtml = `
      <div class="stage-rail-wrap">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-weight:700;font-size:12.5px;">🧭 ${esc(d.template.title)}（点击任意节点切换，含 🔒 未解锁后续步骤只读预览）</span>
          ${d.current_step_code && focusStep && focusStep.step_code !== d.current_step_code
            ? `<button type="button" class="btn btn-primary btn-xs" data-wizard-focus="${esc(d.current_step_code)}">↩ 回到当前待办步骤 (${esc(d.current_step_code)})</button>`
            : ""}
        </div>
        <div class="step-rail">
          ${allSteps.map((s) => {
            const icon = s.step_state === "approved" ? "✓" : s.step_state === "active" ? "●" : s.step_state === "submitted" ? "⏳" : s.step_state === "rejected" ? "✕" : s.step_state === "skipped" ? "↷" : "🔒";
            return `
              <button type="button"
                class="step-pill-node st-${esc(s.step_state)} ${focusStep && focusStep.step_code === s.step_code ? "selected-focus" : ""}"
                data-wizard-focus="${esc(s.step_code)}"
                title="${esc(s.stage_title)} · ${esc(s.title)}">
                <span class="mono">${icon} ${esc(s.step_code)}</span>
                <span>${esc(s.title.length > 10 ? s.title.slice(0, 10) + "…" : s.title)}</span>
              </button>
            `;
          }).join("")}
        </div>
      </div>
    `;

    if (!focusStep) {
      bodyEl.innerHTML = dualBarHtml + railHtml;
      return;
    }

    const latestMaterials = (focusStep.latest_submission && focusStep.latest_submission.materials) || {};
    const crossLocked = Boolean(focusStep.cross_gate && focusStep.cross_gate.locked);
    const canSubmitNow = !isReadonlyPreview && !crossLocked && ["active", "rejected"].includes(focusStep.step_state);
    const canReviewNow = focusStep.step_state === "submitted" && (state.viewerRole === "supervisor" || state.viewerRole === "boss");

    bodyEl.innerHTML = `
      ${dualBarHtml}
      ${railHtml}

      <div class="step-exec-card">
        ${isReadonlyPreview ? `
          <div class="preview-readonly-banner">
            <span>👁 只读预览模式：该步骤（${esc(focusStep.step_code)}）需等前序步骤完成后解锁提交，您可提前查看操作标准、防呆红线与所需材料。</span>
            ${d.current_step_code ? `<button type="button" class="btn btn-primary btn-xs" data-wizard-focus="${esc(d.current_step_code)}">↩ 立即回到当前步骤 (${esc(d.current_step_code)})</button>` : ""}
          </div>
        ` : ""}

        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;">
          <div>
            <div class="op-btns" style="margin-bottom:4px;">
              <span class="badge badge-blue mono">${esc(focusStep.stage_code)} · 第 ${focusStep.sort_order}/${d.total_steps} 步</span>
              ${stepStateBadge(focusStep.step_state)}
              <span class="badge badge-gray">执行人：${esc(focusStep.owner_role)}</span>
              ${focusStep.require_review ? `<span class="badge badge-purple">🔎 需主管审核放行</span>` : `<span class="badge badge-green">⚡ 提交即自动流转下一步</span>`}
            </div>
            <h3 style="margin:4px 0;font-size:17px;">${esc(focusStep.step_code)} · ${esc(focusStep.title)}</h3>
            <div class="cell-sub">🎯 交付成功标准：<strong>${esc(focusStep.deliver_note || "按要求提交留痕材料")}</strong> · KPI口径：${esc(focusStep.kpi_impact)}</div>
          </div>
        </div>

        ${focusStep.warn_text ? `
          <div class="warn-flat-box">
            🚨 防呆必读红线（严禁违规）：${esc(focusStep.warn_text)}
          </div>
        ` : ""}

        ${crossLocked ? `
          <div class="cross-lock-card">
            <div style="font-weight:800;font-size:13.5px;margin-bottom:4px;">🔒 跨轨强关联门禁硬锁止（Lock 组件：未满足上游企业支付宝前置条件，禁止强闯）</div>
            <div style="font-size:12.5px;line-height:1.55;">${esc(focusStep.cross_gate.reason)}</div>
            <div style="margin-top:8px;">
              ${focusStep.cross_gate.upstream_case_id
                ? `<button type="button" class="btn btn-amber btn-xs" data-open-wizard="${esc(focusStep.cross_gate.upstream_case_id)}" data-wizard-step="${esc(focusStep.cross_gate.required_step_code)}">👉 一键跳去办理上游支付宝 ${esc(focusStep.cross_gate.required_step_code)} 步骤 →</button>`
                : ""}
            </div>
          </div>
        ` : ""}

        <div style="margin-top:10px;">
          <div style="font-weight:700;margin-bottom:5px;">📋 手把手实操步骤说明：</div>
          <div class="guide-pre-box">${esc(focusStep.guide)}</div>
        </div>

        <!-- 十要素完整帮助与 7 字段防呆矩阵折叠卡 -->
        <details class="panel-card" style="margin-top:12px;">
          <summary style="padding:10px 14px;cursor:pointer;font-weight:700;color:var(--blue-dark);">
            ❓ 展开本步「十要素」完整规范 & 7字段防呆矩阵 & 演示视频说明
          </summary>
          <div style="padding:12px 14px;border-top:1px solid var(--border-light);background:#fafcff;">
            <div class="kv-grid" style="margin-bottom:10px;">
              <div class="kv-item"><label>① 何时用 / 触发时机</label><div>${esc(focusStep.when_to_use || "前序节点核验完成后立即进入")}</div></div>
              <div class="kv-item"><label>② 异常停止条件</label><div>${esc(focusStep.stop_condition || "出现风控弹窗或实名异常立即停手报主管")}</div></div>
              <div class="kv-item"><label>③ 实操演示视频</label><div>${focusStep.video_url ? `<span class="badge badge-green">🎬 已终审点亮</span> <a href="${esc(focusStep.video_url)}" target="_blank">点击播放实操录屏</a>` : `<span class="badge badge-gray">待录（诚实标注：请严格按上方图文步骤执行）</span>`}</div></div>
              <div class="kv-item"><label>④ 关联知识库 Wiki</label><div><span class="mono">${esc(focusStep.wiki_url || "待补")}</span></div></div>
            </div>
            ${(focusStep.guards && focusStep.guards.length > 0) ? `
              <div style="font-weight:700;margin-bottom:4px;">🛡 7字段防呆矩阵 G(前置条件, 常见错误, 系统拦截, 防呆提示, 补救措施, 责任人, 留痕证据)：</div>
              <table class="poka-table">
                <thead><tr><th>前置条件</th><th>高频踩坑错误</th><th>系统拦截机制</th><th>防呆提示</th><th>出错补救</th><th>责任人</th><th>留痕证据</th></tr></thead>
                <tbody>
                  ${focusStep.guards.map((g) => `
                    <tr>
                      <td>${esc(g.pre)}</td>
                      <td style="color:var(--red-ink);font-weight:600;">${esc(g.mistake)}</td>
                      <td>${esc(g.block)}</td>
                      <td>${esc(g.tip)}</td>
                      <td>${esc(g.recover)}</td>
                      <td>${esc(g.owner)}</td>
                      <td>${esc(g.evidence)}</td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            ` : ""}
          </div>
        </details>

        <!-- 单向密码锁入老板保险箱（针对新设密码步骤，免明文回显） -->
        ${focusStep.unlock_vault_lockin ? `
          <div class="panel-card" style="margin-top:12px;border-color:var(--blue-border);background:#f8fbff;padding:12px 14px;">
            <div style="font-weight:700;color:var(--blue-dark);margin-bottom:6px;">
              🔐 新设账号密码「单向加密锁库 & 同步 AdsPower Authenticator」（员工录入后不可反查明文）
            </div>
            <div class="form-grid">
              <div class="form-field">
                <label>登录账号/邮箱/会员名</label>
                <input id="wiz-lockin-acc" class="input-control mono" placeholder="如 4fc2142b92@example.invalid" />
              </div>
              <div class="form-field">
                <label>新设登录密码 *</label>
                <input id="wiz-lockin-pwd" type="password" class="input-control mono" placeholder="输入后直接ENCv1加密锁库并注入AdsPower" />
              </div>
              <div class="form-field">
                <label>二级密码/6位支付盾密（选填）</label>
                <input id="wiz-lockin-sec" type="password" class="input-control mono" placeholder="选填：支付密码" />
              </div>
              <div class="form-field" style="justify-content:flex-end;">
                <button type="button" class="btn btn-primary btn-sm" id="btn-wiz-lockin-save" data-target-kind="${esc(d.target_kind)}" data-target-id="${esc(d.target_id)}" data-case-title="${esc(d.case_title)}">
                  🔒 单向加密锁入密码总库 & 推送 AdsPower
                </button>
              </div>
            </div>
          </div>
        ` : ""}

        <!-- 必填留痕材料录入与提交区 -->
        <div class="panel-card" style="margin-top:12px;padding:14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <strong>📝 本步留痕材料填报（禁空、禁填纯 "0"，缺数据请如实填「待核」）</strong>
            <span class="cell-sub">每次重交均生成独立版本号 v1, v2… 绝不覆盖历史审核意见</span>
          </div>

          <div class="form-grid">
            ${(focusStep.materials || []).map((m) => `
              <div class="form-field ${(focusStep.materials || []).length === 1 ? "span-2" : ""}">
                <label>${esc(m.label)} ${m.required ? "*" : ""}</label>
                <input class="input-control wiz-mat-input"
                  data-mat-key="${esc(m.field_key)}"
                  value="${esc(latestMaterials[m.field_key] || "")}"
                  placeholder="${esc(m.placeholder || "请填写留痕凭证说明、截图文件名或核验结果")}"
                  ${canSubmitNow ? "" : "disabled"} />
              </div>
            `).join("")}

            ${focusStep.require_confirm ? `
              <div class="form-field span-2">
                <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;color:var(--red-ink);font-weight:700;">
                  <input type="checkbox" id="wiz-step-confirm" ${canSubmitNow ? "" : "disabled"} ${focusStep.step_state === "approved" ? "checked" : ""} />
                  本人已逐条核对本步防呆红线并确认真实无误（严禁跳步或虚假勾选）
                </label>
              </div>
            ` : ""}
          </div>

          <div style="margin-top:12px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
            <div>
              ${isReadonlyPreview
                ? `<span class="badge badge-gray">🔒 当前为后续步骤只读预览，完成前序步骤后自动解锁提交按钮</span>`
                : crossLocked
                ? `<span class="badge badge-red">🔒 已由跨轨强关联门禁锁止：请先完成上方提示的上游企业支付宝步骤</span>`
                : focusStep.step_state === "approved"
                ? `<span class="badge badge-green">✓ 本步已验收归档</span>`
                : focusStep.step_state === "submitted"
                ? `<span class="badge badge-amber">⏳ 已提交材料，正等待主管（${esc(d.supervisor_staff)}）审核放行</span>`
                : `<span class="cell-sub">核对无误后点击右侧提交</span>`}
            </div>
            <div class="op-btns">
              ${canSubmitNow ? `
                <button type="button" class="btn btn-primary" id="btn-wiz-submit-step" data-case-id="${esc(d.id)}" data-step-code="${esc(focusStep.step_code)}">
                  ${focusStep.step_state === "rejected" ? "🔄 补齐材料重新提交审核" : focusStep.require_review ? "📤 提交材料交主管审核" : "✅ 确认完成并进入下一步 →"}
                </button>
              ` : ""}
            </div>
          </div>
        </div>

        <!-- 主管 / 老板在线审核操作区（当步骤处于 submitted 待审态时直接显现） -->
        ${canReviewNow ? `
          <div class="panel-card" style="margin-top:12px;border:2px solid var(--amber);background:#fffdf5;padding:14px;">
            <div style="font-weight:800;color:var(--amber-ink);margin-bottom:8px;">
              🧭 主管/老板审核裁决台（当前待审版本 v${focusStep.latest_submission ? focusStep.latest_submission.version_no : 1} · 提交人：${esc(focusStep.latest_submission ? focusStep.latest_submission.submitted_by : "")}）
            </div>
            <div class="op-btns" style="width:100%;">
              <input id="wiz-review-note" class="input-control" style="flex:1;" placeholder="填写审核评语；若打回重交必须写明 ≥4 字具体缺失点（历史意见将永久保留）" />
              <button type="button" class="btn btn-success" data-wiz-review="approve" data-case-id="${esc(d.id)}" data-step-code="${esc(focusStep.step_code)}">✓ 审核通过（自动解锁后续/下游）</button>
              <button type="button" class="btn btn-danger" data-wiz-review="reject" data-case-id="${esc(d.id)}" data-step-code="${esc(focusStep.step_code)}">✕ 打回重交</button>
            </div>
          </div>
        ` : ""}

        <!-- 历史提交版本与驳回原因永久留痕时间线 -->
        ${(focusStep.history && focusStep.history.length > 0) ? `
          <div style="margin-top:14px;">
            <div style="font-weight:700;font-size:12.5px;">📜 历史提交与审核留痕记录（共 ${focusStep.history.length} 个版本 · 驳回意见永久保留不覆盖）：</div>
            ${focusStep.history.map((h) => `
              <div class="sub-history-item ${h.status === "rejected" ? "rejected" : ""}">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                  <div>
                    <span class="badge ${h.status === "approved" ? "badge-green" : h.status === "rejected" ? "badge-red" : "badge-amber"}">v${h.version_no} · ${esc(h.status)}</span>
                    <strong>提交人：${esc(h.submitted_by)}</strong>
                    <span class="cell-sub mono" style="display:inline;margin-left:6px;">${esc(h.submitted_at)}</span>
                  </div>
                  ${h.reviewed_by ? `<span class="cell-sub">审核：${esc(h.reviewed_by)} (${esc(h.reviewed_at)})</span>` : ""}
                </div>
                <div class="cell-sub mono" style="margin-top:4px;color:var(--ink-primary);">提交材料：${esc(JSON.stringify(h.materials || {}))}</div>
                ${h.review_note ? `<div style="margin-top:4px;font-weight:700;color:${h.status === "rejected" ? "var(--red-ink)" : "var(--green)"};">💬 审核意见：${esc(h.review_note)}</div>` : ""}
              </div>
            `).join("")}
          </div>
        ` : ""}

        <!-- 双闸例外跳步申请折叠区 -->
        ${(!isReadonlyPreview && focusStep.step_state !== "approved" && focusStep.step_state !== "skipped") ? `
          <details style="margin-top:12px;border-top:1px dashed var(--border-light);padding-top:10px;">
            <summary style="cursor:pointer;font-size:12px;color:var(--ink-muted);">⚠️ 特殊场景双闸申请跳过此步（须写明 ≥4 字原因并经老板终审特批）</summary>
            ${focusStep.skip_request && focusStep.skip_request.status === "pending"
              ? `<div class="sub-history-item" style="margin-top:8px;">
                   <span class="badge badge-amber">待老板特批中</span> 申请人：${esc(focusStep.skip_request.requested_by)} · 理由：${esc(focusStep.skip_request.reason)}
                   ${state.viewerRole === "boss" ? `
                     <div class="op-btns" style="margin-top:6px;">
                       <button type="button" class="btn btn-amber btn-xs" data-boss-skip-verdict="${esc(focusStep.skip_request.id)}" data-verdict="approve">老板特批跳过</button>
                       <button type="button" class="btn btn-danger btn-xs" data-boss-skip-verdict="${esc(focusStep.skip_request.id)}" data-verdict="reject">老板驳回申请</button>
                     </div>
                   ` : ""}
                 </div>`
              : `<div class="op-btns" style="margin-top:8px;">
                   <input id="wiz-skip-reason" class="input-control" style="flex:1;" placeholder="请详细说明申请跳过该步骤的客观原因（如独立采购买号无需企业店亮照）..." />
                   <button type="button" class="btn btn-outline btn-sm" id="btn-wiz-req-skip" data-case-id="${esc(d.id)}" data-step-code="${esc(focusStep.step_code)}">提交跳步特批申请</button>
                 </div>`}
          </details>
        ` : ""}
      </div>
    `;
  }

  // ==================== 11. 只读模板预览抽屉 & 缺口派单抽屉 ====================
  async function openTemplatePreviewDrawer(tplId) {
    const { apiCall, openDrawer, esc, toast } = B();
    try {
      const res = await apiCall(`/api/tutorials/template?id=${encodeURIComponent(tplId)}`);
      const t = res.data;
      const html = `
        <div class="kv-grid">
          <div class="kv-item"><label>模板编码 / 版本</label><div class="mono">${esc(t.code)} · ${esc(t.version)}</div></div>
          <div class="kv-item"><label>状态 / 编写人</label><div><span class="badge badge-blue">${esc(t.status)}</span> · ${esc(t.author_staff)}</div></div>
          <div class="kv-item"><label>建店SLA / 奖励</label><div>${t.sla_days} 天 · ${t.reward_points} 积分 (¥${t.reward_yuan})</div></div>
          <div class="kv-item"><label>适用平台</label><div>${esc(t.platform || t.target_kind)}</div></div>
        </div>
        <p style="margin:6px 0;font-size:12.5px;color:var(--ink-secondary);">${esc(t.summary)}</p>
        ${(t.stages || []).map((stg) => `
          <div class="panel-card">
            <div class="panel-head">
              <h3>${esc(stg.stage_code)} · ${esc(stg.title)}</h3>
              <span class="badge badge-gray">${esc(stg.duration_note)}</span>
            </div>
            <div class="panel-body" style="display:flex;flex-direction:column;gap:10px;">
              ${(stg.steps || []).map((s) => `
                <div style="border:1px solid var(--border-light);border-radius:8px;padding:10px 12px;background:#fafcff;">
                  <div style="display:flex;justify-content:space-between;gap:8px;">
                    <strong>${esc(s.step_code)} · ${esc(s.title)}</strong>
                    <div class="op-btns">
                      ${s.require_review ? `<span class="badge badge-purple">需主管审</span>` : ""}
                      ${s.cross_gate_rule ? `<span class="badge badge-amber mono">锁:${esc(s.cross_gate_rule)}</span>` : ""}
                    </div>
                  </div>
                  ${s.warn_text ? `<div style="color:var(--red-ink);font-size:12px;font-weight:700;margin-top:4px;">🚨 ${esc(s.warn_text)}</div>` : ""}
                  <div style="font-size:12px;color:var(--ink-secondary);margin-top:4px;white-space:pre-line;">${esc(s.guide)}</div>
                </div>
              `).join("")}
            </div>
          </div>
        `).join("")}
      `;
      openDrawer("标准开店教程预览", t.title, html);
    } catch (e) {
      toast(e.message, "error");
    }
  }

  function openDispatchDrawer(presetLpId = "lp-wyq", presetPlat = "xianyu") {
    const { state, openDrawer, closeDrawer, apiCall, reloadData, toast, esc } = B();
    const b = state.boot;
    const lps = b.legal_persons || [];
    const ents = b.business_entities || [];
    const alis = b.alipay_accounts || [];
    const platLabels = (b.meta && b.meta.platform_labels) || {};
    const covMap = {};
    for (const c of ((b.gap_overview && b.gap_overview.tutorial_coverage) || [])) {
      covMap[c.platform] = c.has_published;
    }

    const html = `
      <div id="dispatch-err" class="form-error-box hidden"></div>
      <form id="dispatch-form" class="form-grid">
        <div class="form-field">
          <label>派单任务类型 *</label>
          <select id="dp-kind" class="select-control">
            <option value="platform">🛍 新开业务平台店铺/账号（自动挂对应平台教程）</option>
            <option value="alipay">💳 新开企业支付宝账户（自动挂15步开户教程）</option>
          </select>
        </div>
        <div class="form-field">
          <label>指派开店执行员工 *</label>
          <select id="dp-staff" class="select-control">
            <option value="赵宇">赵宇</option>
            <option value="陈晓雯">陈晓雯</option>
            <option value="林婷">林婷</option>
            <option value="李航">李航</option>
          </select>
        </div>
        <div class="form-field">
          <label>归属法人 *</label>
          <select id="dp-lp" class="select-control">
            ${lps.map((lp) => `<option value="${esc(lp.id)}" ${lp.id === presetLpId ? "selected" : ""}>${esc(lp.name)}</option>`).join("")}
          </select>
        </div>
        <div class="form-field">
          <label>归属营业执照主体 *</label>
          <select id="dp-ent" class="select-control">
            ${ents.map((e) => `<option value="${esc(e.id)}" ${e.legal_person_id === presetLpId ? "selected" : ""}>${esc(e.entity_code)} · ${esc(e.entity_name)}</option>`).join("")}
          </select>
        </div>
        <div class="form-field span-2" id="dp-plat-field">
          <label>目标业务平台（仅已上线标准教程的平台可派单，空白平台将触发 Lock 防呆拦截）*</label>
          <select id="dp-plat" class="select-control">
            ${Object.entries(platLabels).map(([k, v]) => `
              <option value="${esc(k)}" ${k === presetPlat ? "selected" : ""}>
                ${covMap[k] ? "✅ [教程已就绪]" : "🔒 [缺教程·禁盲派]"} ${esc(v)} (${esc(k)})
              </option>
            `).join("")}
          </select>
        </div>
        <div class="form-field span-2" id="dp-ali-field">
          <label>强关联绑定的上游企业支付宝（若为闲鱼店，自动建立 Gate-1 C10 & Gate-2 D15 双轨锁！）</label>
          <select id="dp-ali" class="select-control">
            <option value="">-- 暂不绑定或非企支直连通道 --</option>
            ${alis.filter((a) => a.trade_direction === "sales_only").map((a) => `<option value="${esc(a.id)}" ${a.id === "ali-18" ? "selected" : ""}>${esc(a.account_code)} · ${esc(a.account_name)} (${esc(a.entity_code)})</option>`).join("")}
          </select>
        </div>
        <div class="form-field span-2">
          <label>拟建店铺 / 账户展示名称 *</label>
          <input id="dp-name" class="input-control" value="" placeholder="如：山屿严选生活4店 / 星澜微信小店3店" required />
        </div>
      </form>
    `;

    const footer = `
      <button type="button" class="btn btn-outline" id="btn-dp-cancel">取消</button>
      <button type="button" class="btn btn-primary" id="btn-dp-submit">🚀 确认创建台账槽位并派发教程单</button>
    `;
    openDrawer("按缺口统筹派单", "新建开店/开户标准作业任务单", html, footer);

    document.getElementById("btn-dp-cancel").onclick = closeDrawer;
    document.getElementById("btn-dp-submit").onclick = async () => {
      const errEl = document.getElementById("dispatch-err");
      errEl.classList.add("hidden");
      try {
        const res = await apiCall("/api/gap/dispatch-case", "POST", {
          target_kind: document.getElementById("dp-kind").value,
          assigned_staff: document.getElementById("dp-staff").value,
          legal_person_id: document.getElementById("dp-lp").value,
          business_entity_id: document.getElementById("dp-ent").value,
          platform: document.getElementById("dp-plat").value,
          alipay_account_id: document.getElementById("dp-ali").value,
          display_name: document.getElementById("dp-name").value.trim(),
        });
        toast("已成功派发开店任务单并生成全流程节点实例！", "success");
        closeDrawer();
        await reloadData();
        if (res.case_id) openWizardModal(res.case_id);
      } catch (e) {
        errEl.textContent = "⛔ " + e.message;
        errEl.classList.remove("hidden");
      }
    };
  }

  // ==================== 12. 主管编排器 DOM 状态同步与保存 ====================
  function syncDraftFromInputs() {
    const d = B().state.authorDraft;
    if (!d || !document.getElementById("au-code")) return d;
    d.code = document.getElementById("au-code").value.trim();
    d.platform = document.getElementById("au-platform").value;
    d.target_kind = d.platform ? "platform" : (d.target_kind || "platform");
    d.title = document.getElementById("au-title").value.trim();
    d.version = document.getElementById("au-version").value.trim() || "v1.0";
    d.sla_days = Number(document.getElementById("au-sla").value || 14);
    d.reward_points = Number(document.getElementById("au-points").value || 8);
    d.summary = document.getElementById("au-summary").value.trim();

    document.querySelectorAll(".au-stg-code").forEach((el) => {
      const s = Number(el.dataset.sidx);
      if (d.stages[s]) d.stages[s].stage_code = el.value.trim();
    });
    document.querySelectorAll(".au-stg-title").forEach((el) => {
      const s = Number(el.dataset.sidx);
      if (d.stages[s]) d.stages[s].title = el.value.trim();
    });
    document.querySelectorAll(".au-stg-dur").forEach((el) => {
      const s = Number(el.dataset.sidx);
      if (d.stages[s]) d.stages[s].duration_note = el.value.trim();
    });

    document.querySelectorAll(".au-stp-code").forEach((el) => {
      const s = Number(el.dataset.sidx), p = Number(el.dataset.pidx);
      if (d.stages[s] && d.stages[s].steps[p]) d.stages[s].steps[p].step_code = el.value.trim();
    });
    document.querySelectorAll(".au-stp-title").forEach((el) => {
      const s = Number(el.dataset.sidx), p = Number(el.dataset.pidx);
      if (d.stages[s] && d.stages[s].steps[p]) d.stages[s].steps[p].title = el.value.trim();
    });
    document.querySelectorAll(".au-stp-guide").forEach((el) => {
      const s = Number(el.dataset.sidx), p = Number(el.dataset.pidx);
      if (d.stages[s] && d.stages[s].steps[p]) d.stages[s].steps[p].guide = el.value;
    });
    document.querySelectorAll(".au-stp-warn").forEach((el) => {
      const s = Number(el.dataset.sidx), p = Number(el.dataset.pidx);
      if (d.stages[s] && d.stages[s].steps[p]) d.stages[s].steps[p].warn_text = el.value;
    });
    document.querySelectorAll(".au-stp-gate").forEach((el) => {
      const s = Number(el.dataset.sidx), p = Number(el.dataset.pidx);
      if (d.stages[s] && d.stages[s].steps[p]) d.stages[s].steps[p].cross_gate_rule = el.value.trim();
    });
    document.querySelectorAll(".au-stp-rev").forEach((el) => {
      const s = Number(el.dataset.sidx), p = Number(el.dataset.pidx);
      if (d.stages[s] && d.stages[s].steps[p]) d.stages[s].steps[p].require_review = el.checked ? 1 : 0;
    });
    document.querySelectorAll(".au-stp-lockin").forEach((el) => {
      const s = Number(el.dataset.sidx), p = Number(el.dataset.pidx);
      if (d.stages[s] && d.stages[s].steps[p]) d.stages[s].steps[p].unlock_vault_lockin = el.checked ? 1 : 0;
    });
    document.querySelectorAll(".au-stp-mat").forEach((el) => {
      const s = Number(el.dataset.sidx), p = Number(el.dataset.pidx);
      const lbl = el.value.trim();
      if (d.stages[s] && d.stages[s].steps[p]) {
        d.stages[s].steps[p].materials = lbl
          ? [{ field_key: el.dataset.matkey || `mat_${s}_${p}`, label: lbl, kind: "text", required: 1, placeholder: "请按要求填写留痕信息（禁填0）" }]
          : [];
      }
    });
    return d;
  }

  function startNewPlatformDraft(platformKey) {
    const { state, renderSidebar, renderCurrentView } = B();
    const platLabels = (state.boot && state.boot.meta && state.boot.meta.platform_labels) || {};
    const label = platLabels[platformKey] || platformKey;
    const upper = (platformKey || "NEW").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    state.authorDraft = {
      id: "",
      code: `TPL-${upper}-V1`,
      target_kind: "platform",
      platform: platformKey,
      title: `${label}标准入驻、防关联配置与财务清算绑定教程`,
      version: "v1.0",
      summary: `主管实操验证通过：涵盖${label}独立家宽IP核验、营业执照亮照认证、AdsPower免明文托管及专属结算账户映射。`,
      sla_days: 10,
      reward_points: 8,
      reward_yuan: 100,
      stages: [
        {
          stage_code: "P1",
          title: `阶段 1 · ${label}环境隔离与主体入驻实名`,
          duration_note: "第 1~2 天",
          steps: [
            {
              step_code: "P01",
              title: "锁定同平台未占用的 ¥10/月家宽代理 IP 并配置 AdsPower 专窗",
              guide: "1. 在台账核验所选家宽代理未挂其他同平台账号；\n2. 绑定专用手机号并初始化新密码单向锁入保险箱。",
              warn_text: "严禁与现有同平台店铺共用同一条家宽 IP！严禁本机真实网络裸连登录！",
              require_review: 0,
              unlock_vault_lockin: 1,
              cross_gate_rule: "",
              materials: [{ field_key: "px_bind_code", label: "绑定的家宽编号与AdsPower窗口号", kind: "text", required: 1 }],
            },
            {
              step_code: "P02",
              title: "上传营业执照并趁法人在场完成实名扫脸认证",
              guide: "1. 上传清晰营业执照原件图；\n2. 全程录屏法人扫脸直至出现认证成功绿色回执页。",
              warn_text: "录像必须包含最终认证成功页面，严禁中途停止录制！",
              require_review: 1,
              unlock_vault_lockin: 0,
              cross_gate_rule: "",
              materials: [{ field_key: "cert_pass_proof", label: "主体实名通过截图与扫脸留痕文件名", kind: "text", required: 1 }],
            },
          ],
        },
        {
          stage_code: "P2",
          title: `阶段 2 · 保证金缴纳、财务槽映射与首单闭环`,
          duration_note: "第 3~5 天",
          steps: [
            {
              step_code: "P03",
              title: "绑定结算商户号/企业支付宝并缴纳类目保证金",
              guide: "1. 完成对应结算通道绑定并将商户号写入本账号财务预留槽；\n2. 登记保证金原路退回账户。",
              warn_text: "采购号与销售号严格互斥，严禁绑定因公采购支付宝收款！",
              require_review: 1,
              unlock_vault_lockin: 0,
              cross_gate_rule: "",
              materials: [{ field_key: "fin_mch_proof", label: "结算商户号及保证金出资户尾号", kind: "text", required: 1 }],
            },
          ],
        },
      ],
    };
    state.view = "sup_authoring";
    renderSidebar();
    renderCurrentView();
  }

  // ==================== 13. 全局点击事件代理（三端与教程引擎专用） ====================
  function bindPortalEvents() {
    document.getElementById("wizard-modal-close").addEventListener("click", closeWizardModal);
    document.getElementById("wizard-modal-backdrop").addEventListener("click", closeWizardModal);

    // 顶栏角色切换器
    const capBtn = document.getElementById("btn-dispatch-cap");
    if (capBtn) {
      capBtn.addEventListener("click", () => {
        openDispatchCapacityDrawer();
      });
    }
    document.getElementById("role-portal-switcher").addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-portal-role]");
      if (!btn) return;
      const role = btn.dataset.portalRole;
      await switchPortalRole(role);
    });

    const supSelEl = document.getElementById("supervisor-staff-select");
    if (supSelEl) {
      supSelEl.addEventListener("change", async (e) => {
        const { state, reloadData } = B();
        state.supStaffChoice = e.target.value;
        if (state.viewerRole === "supervisor") {
          state.viewerStaff = state.supStaffChoice;
          state.view = state.viewerStaff === "周安" ? "sup_reviews" : "gov_sup_my";
          updateTopbarPortalUI();
          await reloadData();
        }
      });
    }

    document.getElementById("employee-staff-select").addEventListener("change", async (e) => {
      const { state, reloadData } = B();
      state.empStaffChoice = e.target.value;
      if (state.viewerRole === "employee") {
        state.viewerStaff = state.empStaffChoice;
        state.empTotpCache = {};
        updateTopbarPortalUI();
        await reloadData();
      }
    });

    // 员工动态码倒计时每秒跳动并在归零时自动刷新
    setInterval(() => {
      const { state, renderCurrentView } = B();
      if (state.viewerRole !== "employee") return;
      let changed = false;
      for (const [cid, info] of Object.entries(state.empTotpCache || {})) {
        if (info && info.remaining_seconds > 0) {
          info.remaining_seconds -= 1;
          changed = true;
          if (info.remaining_seconds <= 0) {
            delete state.empTotpCache[cid];
          }
        }
      }
      if (changed && state.view === "emp_adspower") {
        renderCurrentView();
      }
    }, 1000);

    document.body.addEventListener("click", async (e) => {
      const { state, apiCall, toast, reloadData, renderSidebar, renderCurrentView } = B();

      // 打开一步一屏向导大弹窗
      const openWiz = e.target.closest("[data-open-wizard]");
      if (openWiz) {
        e.stopPropagation();
        await openWizardModal(openWiz.dataset.openWizard, openWiz.dataset.wizardStep || null);
        return;
      }

      // 切换向导内的步骤节点（含 locked 只读预览）
      const focusNode = e.target.closest("[data-wizard-focus]");
      if (focusNode) {
        e.stopPropagation();
        state.activeWizardStepCode = focusNode.dataset.wizardFocus;
        renderActiveWizardModal();
        return;
      }

      // 员工/操作员在向导内单向锁入密码 & 同步 AdsPower
      const lockInBtn = e.target.closest("#btn-wiz-lockin-save");
      if (lockInBtn) {
        e.stopPropagation();
        const pwd = (document.getElementById("wiz-lockin-pwd").value || "").trim();
        const acc = (document.getElementById("wiz-lockin-acc").value || "").trim();
        const sec = (document.getElementById("wiz-lockin-sec").value || "").trim();
        if (pwd.length < 6) {
          toast("新设密码长度至少 6 位", "error");
          return;
        }
        try {
          const r = await apiCall("/api/vault/employee-lock-in", "POST", {
            target_table: lockInBtn.dataset.targetKind === "alipay" ? "alipay_accounts" : "platform_accounts",
            target_id: lockInBtn.dataset.targetId,
            title: lockInBtn.dataset.caseTitle,
            login_account: acc,
            login_password: pwd,
            secondary_password: sec,
          });
          document.getElementById("wiz-lockin-pwd").value = "";
          document.getElementById("wiz-lockin-sec").value = "";
          toast(r.message || "密码已单向加密锁库并注入 AdsPower！", "success");
          await reloadData();
        } catch (err) {
          toast("⛔ " + err.message, "error");
        }
        return;
      }

      // 提交当前步骤材料
      const subStepBtn = e.target.closest("#btn-wiz-submit-step");
      if (subStepBtn) {
        e.stopPropagation();
        const materials = {};
        document.querySelectorAll(".wiz-mat-input").forEach((inp) => {
          materials[inp.dataset.matKey] = inp.value.trim();
          if (inp.value.trim() === "0") {
            toast("⛔ 严禁填纯数字 0！若暂无数据请如实填写『待核』", "error");
          }
        });
        const confirmEl = document.getElementById("wiz-step-confirm");
        const confirmed = confirmEl ? confirmEl.checked : true;
        try {
          const r = await apiCall("/api/onboarding/submit-step", "POST", {
            case_id: subStepBtn.dataset.caseId,
            step_code: subStepBtn.dataset.stepCode,
            materials,
            confirmed,
          });
          toast(r.status === "approved" ? "✅ 本步已完成并自动进入下一步！" : "📤 材料已提交 (v" + r.version_no + ")，等待主管审核！", "success");
          state.activeWizardDetail = r.case_detail;
          state.activeWizardStepCode = r.case_detail.current_step_code || subStepBtn.dataset.stepCode;
          renderActiveWizardModal();
          await reloadData();
        } catch (err) {
          toast("⛔ " + err.message, "error");
        }
        return;
      }

      // 主管/老板审核步骤材料（通过 / 打回）
      const revBtn = e.target.closest("[data-wiz-review]");
      if (revBtn) {
        e.stopPropagation();
        const verdict = revBtn.dataset.wizReview;
        const note = (document.getElementById("wiz-review-note").value || "").trim();
        try {
          const r = await apiCall("/api/onboarding/review-step", "POST", {
            case_id: revBtn.dataset.caseId,
            step_code: revBtn.dataset.stepCode,
            verdict,
            review_note: note,
          });
          toast(verdict === "approve" ? "✅ 审核通过！下游关联限制已同步刷新" : "已打回员工重交（历史意见已保留）", "success");
          state.activeWizardDetail = r.case_detail;
          state.activeWizardStepCode = r.case_detail.current_step_code || revBtn.dataset.stepCode;
          renderActiveWizardModal();
          await reloadData();
        } catch (err) {
          toast("⛔ " + err.message, "error");
        }
        return;
      }

      // 员工提交双闸跳步申请
      const reqSkipBtn = e.target.closest("#btn-wiz-req-skip");
      if (reqSkipBtn) {
        e.stopPropagation();
        const reason = (document.getElementById("wiz-skip-reason").value || "").trim();
        try {
          const r = await apiCall("/api/onboarding/skip-request", "POST", {
            case_id: reqSkipBtn.dataset.caseId,
            step_code: reqSkipBtn.dataset.stepCode,
            reason,
          });
          toast("已提交跳步申请，待老板终审裁决", "info");
          state.activeWizardDetail = r.case_detail;
          renderActiveWizardModal();
          await reloadData();
        } catch (err) {
          toast("⛔ " + err.message, "error");
        }
        return;
      }

      // 老板裁决跳步申请
      const bossSkipBtn = e.target.closest("[data-boss-skip-verdict]");
      if (bossSkipBtn) {
        e.stopPropagation();
        const verdict = bossSkipBtn.dataset.verdict;
        const note = window.prompt(verdict === "approve" ? "请输入老板特批放行备注：" : "请输入驳回跳步申请的意见：", verdict === "approve" ? "特殊采购号场景特批放行" : "违反企业店合规铁律，严禁跳步，必须补齐企业管家授权！");
        if (note === null) return;
        try {
          const r = await apiCall("/api/onboarding/skip-verdict", "POST", {
            skip_id: bossSkipBtn.dataset.bossSkipVerdict,
            verdict,
            boss_note: note,
          });
          toast(verdict === "approve" ? "已特批跳过该步" : "已驳回违规跳步申请", "success");
          if (state.activeWizardCaseId && r.case_detail && r.case_detail.id === state.activeWizardCaseId) {
            state.activeWizardDetail = r.case_detail;
            renderActiveWizardModal();
          }
          await reloadData();
        } catch (err) {
          toast("⛔ " + err.message, "error");
        }
        return;
      }

      // 预览模板
      const prevTpl = e.target.closest("[data-preview-tpl]");
      if (prevTpl) {
        e.stopPropagation();
        await openTemplatePreviewDrawer(prevTpl.dataset.previewTpl);
        return;
      }

      // 老板终审新编教程上线
      const bossTplBtn = e.target.closest("[data-boss-tpl-verdict]");
      if (bossTplBtn) {
        e.stopPropagation();
        const verdict = bossTplBtn.dataset.verdict;
        try {
          await apiCall("/api/tutorials/publish-verdict", "POST", {
            template_id: bossTplBtn.dataset.bossTplVerdict,
            verdict,
            boss_note: verdict === "approve" ? "老板终审通过，准予正式上线派单" : "请补充防呆红字后再提审",
          });
          toast(verdict === "approve" ? "🎉 教程已正式上线！对应平台缺口现已开放派单" : "已退回主管草稿修订", "success");
          await reloadData();
        } catch (err) {
          toast("⛔ " + err.message, "error");
        }
        return;
      }

      // 主管打开/新建平台教程
      const startAu = e.target.closest("[data-start-author-plat]");
      if (startAu) {
        e.stopPropagation();
        if (state.viewerRole === "boss") {
          await switchPortalRole("supervisor");
        }
        startNewPlatformDraft(startAu.dataset.startAuthorPlat);
        return;
      }

      const editTpl = e.target.closest("[data-edit-tpl]");
      if (editTpl) {
        e.stopPropagation();
        try {
          const res = await apiCall(`/api/tutorials/template?id=${encodeURIComponent(editTpl.dataset.editTpl)}`);
          state.authorDraft = res.data;
          state.view = "sup_authoring";
          renderSidebar();
          renderCurrentView();
        } catch (err) {
          toast(err.message, "error");
        }
        return;
      }

      if (e.target.closest("#btn-close-author")) {
        state.authorDraft = null;
        renderCurrentView();
        return;
      }

      if (e.target.closest("#btn-au-add-stage")) {
        syncDraftFromInputs();
        state.authorDraft.stages.push({
          stage_code: `P${state.authorDraft.stages.length + 1}`,
          title: "新增阶段标题",
          duration_note: "1~2 天",
          steps: [{ step_code: `N0${state.authorDraft.stages.length + 1}`, title: "新原子步骤", guide: "", warn_text: "", require_review: 0, materials: [] }],
        });
        renderCurrentView();
        return;
      }

      const addStp = e.target.closest("[data-au-add-step]");
      if (addStp) {
        syncDraftFromInputs();
        const sIdx = Number(addStp.dataset.auAddStep);
        const stg = state.authorDraft.stages[sIdx];
        stg.steps.push({
          step_code: `P${sIdx + 1}S${stg.steps.length + 1}`,
          title: "新增原子操作步骤",
          guide: "填写明确的操作路径与核验点",
          warn_text: "",
          require_review: 0,
          materials: [{ field_key: `m_${Date.now()}`, label: "步骤执行回执说明", kind: "text", required: 1 }],
        });
        renderCurrentView();
        return;
      }

      const delStg = e.target.closest("[data-au-del-stage]");
      if (delStg) {
        syncDraftFromInputs();
        state.authorDraft.stages.splice(Number(delStg.dataset.auDelStage), 1);
        renderCurrentView();
        return;
      }

      const delStp = e.target.closest("[data-au-del-step]");
      if (delStp) {
        syncDraftFromInputs();
        const [sIdx, pIdx] = delStp.dataset.auDelStep.split(":").map(Number);
        state.authorDraft.stages[sIdx].steps.splice(pIdx, 1);
        renderCurrentView();
        return;
      }

      const saveAu = e.target.closest("[data-save-author]");
      if (saveAu) {
        const d = syncDraftFromInputs();
        const submitBoss = saveAu.dataset.saveAuthor === "1";
        try {
          await apiCall("/api/tutorials/save-template", "POST", {
            ...d,
            submit_for_boss: submitBoss,
          });
          toast(submitBoss ? "🚀 已保存并提交老板终审！" : "💾 教程草稿已保存", "success");
          state.authorDraft = null;
          await reloadData();
        } catch (err) {
          toast("⛔ " + err.message, "error");
        }
        return;
      }

      // 缺口派单抽屉
      const openDp = e.target.closest("[data-open-dispatch-modal]");
      if (openDp) {
        e.stopPropagation();
        openDispatchDrawer(openDp.dataset.openDispatchModal || "lp-wyq", "xianyu");
        return;
      }

      const quickDp = e.target.closest("[data-quick-dispatch-lp]");
      if (quickDp) {
        e.stopPropagation();
        openDispatchDrawer(quickDp.dataset.quickDispatchLp, quickDp.dataset.quickDispatchPlat);
        return;
      }

      // 员工领用 6 位 Authenticator 动态码
      const empTotpBtn = e.target.closest("[data-emp-fetch-totp]");
      if (empTotpBtn) {
        e.stopPropagation();
        const cid = empTotpBtn.dataset.empFetchTotp;
        try {
          const r = await apiCall("/api/vault/employee-totp", "POST", { credential_id: cid });
          state.empTotpCache[cid] = r.data;
          toast("已生成 6 位实时 Authenticator 动态码（免明文托管）", "success");
          renderCurrentView();
        } catch (err) {
          toast("⛔ " + err.message, "error");
        }
        return;
      }

      // 一键推送密码+fakey 同步至 AdsPower Authenticator
      const syncAdsBtn = e.target.closest("[data-sync-adspower-cred]");
      if (syncAdsBtn) {
        e.stopPropagation();
        try {
          const r = await apiCall("/api/adspower/sync-credential", "POST", {
            credential_id: syncAdsBtn.dataset.syncAdspowerCred,
            adspower_profile_id: syncAdsBtn.dataset.adsProfileId || "",
          });
          toast(r.data && r.data.message ? r.data.message : "已同步密码与 2FA 种子至 AdsPower！", "success");
          await reloadData();
        } catch (err) {
          toast("⛔ " + err.message, "error");
        }
        return;
      }

      // 一键拉起 AdsPower 隔离专窗
      const openAdsWin = e.target.closest("[data-open-adspower-win]");
      if (openAdsWin) {
        e.stopPropagation();
        try {
          const r = await apiCall("/api/adspower/open-window", "POST", {
            adspower_profile_id: openAdsWin.dataset.openAdspowerWin,
          });
          toast(r.data && r.data.message ? r.data.message : "已发送启动 AdsPower 专窗指令", "success");
        } catch (err) {
          toast("⛔ " + err.message, "error");
        }
        return;
      }
    });
  }

  function updateTopbarPortalUI() {
    const { state } = B();
    const role = state.viewerRole;
    document.querySelectorAll("#role-portal-switcher [data-portal-role]").forEach((b) => {
      b.classList.toggle("active", b.dataset.portalRole === role);
    });

    const supSel = document.getElementById("supervisor-staff-select");
    const empSel = document.getElementById("employee-staff-select");
    const vaultBtn = document.getElementById("btn-vault-status");
    const capBtn = document.getElementById("btn-dispatch-cap");
    const quickWrap = document.getElementById("boss-quick-create-wrap");
    const exportWrap = document.getElementById("boss-export-wrap");
    const lpWrap = document.getElementById("lp-switcher-wrap");
    const roleBadge = document.getElementById("role-scope-badge");
    const brandTitle = document.getElementById("sidebar-brand-title");
    const brandSub = document.getElementById("sidebar-brand-sub");
    const groupLbl = document.getElementById("sidebar-group-label");

    if (role === "boss") {
      if (supSel) supSel.classList.add("hidden");
      empSel.classList.add("hidden");
      vaultBtn.classList.remove("hidden");
      if (capBtn) capBtn.classList.remove("hidden");
      quickWrap.classList.remove("hidden");
      exportWrap.classList.remove("hidden");
      lpWrap.classList.remove("hidden");
      roleBadge.classList.add("hidden");
      brandTitle.textContent = "锚点全量台账";
      brandSub.textContent = "BOSS MASTER PORTAL";
      groupLbl.textContent = "一、资产与账号台账";
    } else if (role === "gm_office") {
      if (supSel) supSel.classList.add("hidden");
      empSel.classList.add("hidden");
      vaultBtn.classList.add("hidden");
      if (capBtn) capBtn.classList.add("hidden");
      quickWrap.classList.add("hidden");
      exportWrap.classList.add("hidden");
      lpWrap.classList.add("hidden");
      roleBadge.classList.remove("hidden");
      roleBadge.className = "badge badge-cyan";
      roleBadge.textContent = "🏛 总经办端(沈悦)：统筹六大工作台 Wiki / 视频 / KPI·OKR 缺口初审（已物理隔离资金密码与号卡）";
      brandTitle.textContent = "总经办治理台";
      brandSub.textContent = "GM OFFICE · 沈悦";
      groupLbl.textContent = "总经办 · 六大工作台制度基建";
    } else if (role === "supervisor") {
      if (supSel) {
        supSel.classList.remove("hidden");
        supSel.value = state.viewerStaff || "周安";
      }
      empSel.classList.add("hidden");
      vaultBtn.classList.add("hidden");
      if (capBtn) capBtn.classList.add("hidden");
      quickWrap.classList.add("hidden");
      exportWrap.classList.add("hidden");
      if (state.viewerStaff === "周安") lpWrap.classList.remove("hidden");
      else lpWrap.classList.add("hidden");
      roleBadge.classList.remove("hidden");
      roleBadge.className = "badge badge-purple";
      roleBadge.textContent = state.viewerStaff === "周安"
        ? "🧭 开店主管(周安)：开店审单/编教程 + 本台视频·Wiki补缺"
        : `🧭 业务主管(${state.viewerStaff})：仅提报本工作台待补 Wiki / 培训视频 / KPI（已隔离账号与资金数据）`;
      brandTitle.textContent = `${state.viewerStaff} · 主管工作台`;
      brandSub.textContent = `SUPERVISOR · ${state.viewerStaff}`;
      groupLbl.textContent = state.viewerStaff === "周安" ? "一、开店审核与教程派单" : "本工作台 · 制度·视频·KPI交件台";
    } else {
      if (supSel) supSel.classList.add("hidden");
      empSel.classList.remove("hidden");
      empSel.value = state.viewerStaff;
      vaultBtn.classList.add("hidden");
      if (capBtn) capBtn.classList.add("hidden");
      quickWrap.classList.add("hidden");
      exportWrap.classList.add("hidden");
      lpWrap.classList.add("hidden");
      roleBadge.classList.remove("hidden");
      roleBadge.className = "badge badge-green";
      roleBadge.textContent = `🛠 员工端(${state.viewerStaff})：一步一屏开店 · 免明文专窗与 6 位动态码`;
      brandTitle.textContent = "员工开店实操端";
      brandSub.textContent = `STAFF · ${state.viewerStaff}`;
      groupLbl.textContent = "我的开店任务与专窗领码";
    }
  }

  async function switchPortalRole(role) {
    const { state, reloadData } = B();
    state.viewerRole = role;
    state.authorDraft = null;
    if (role === "boss") {
      state.viewerStaff = "老板";
      state.view = "overview";
    } else if (role === "gm_office") {
      state.viewerStaff = "沈悦";
      state.lpFilter = "ALL";
      state.vaultToken = null;
      state.vaultTimerSec = 0;
      state.revealedSecrets = {};
      state.view = "gov_hub";
    } else if (role === "supervisor") {
      state.viewerStaff = state.supStaffChoice || "周安";
      state.lpFilter = "ALL";
      state.vaultToken = null;
      state.vaultTimerSec = 0;
      state.revealedSecrets = {};
      state.view = state.viewerStaff === "周安" ? "sup_reviews" : "gov_sup_my";
    } else {
      state.viewerStaff = state.empStaffChoice || "赵宇";
      state.lpFilter = "ALL";
      state.vaultToken = null;
      state.vaultTimerSec = 0;
      state.revealedSecrets = {};
      state.view = "emp_tasks";
    }
    updateTopbarPortalUI();
    await reloadData();
  }

  async function openDispatchCapacityDrawer() {
    const { state, openDrawer, closeDrawer, apiCall, reloadData, toast, esc } = B();
    if (state.viewerRole !== "boss") {
      toast("⛔ 仅老板管理端可查看与配置店铺分组月度派单容量策略", "error");
      return;
    }
    try {
      const res = await apiCall("/api/dispatch-capacity-policies", "GET");
      const items = (res && res.data) || [];
      const html = `
        <div id="dcp-err" class="form-error-box hidden"></div>
        <div class="panel-card" style="padding:12px 14px;margin-bottom:12px;background:#f8fafc;border:1px solid var(--border-light);flex-shrink:0;">
          <div style="font-weight:700;font-size:13px;color:var(--ink-primary);">🔒 一次性后台静默配置 · 业务端脱敏联动说明</div>
          <div style="font-size:12px;color:var(--ink-secondary);margin-top:4px;line-height:1.6;">
            本表仅在老板管理端开放读写。保存后实时同步至销售工作台（5341/5342）：一线销售人员<strong>看不到任何金额、阈值或主体名称</strong>，仅接收中性派单状态（<code>正常接单</code> / <code>负荷偏高·优先派空闲号</code> / <code>本月排期已满·暂停派新</code>）。
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px;">
          ${items.map((it, idx) => `
            <div class="panel-card dcp-row-card" data-dcp-id="${esc(it.id)}" data-dcp-code="${esc(it.group_code)}" style="padding:12px 14px;border:1px solid var(--border-light);">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;">
                <div>
                  <span class="badge badge-blue mono">${esc(it.group_code)}</span>
                  <strong style="margin-left:6px;">${esc(it.group_name)}</strong>
                </div>
                <span class="badge ${it.dispatch_tone === "red" ? "badge-red" : it.dispatch_tone === "amb" ? "badge-amber" : "badge-green"}">${esc(it.dispatch_badge)}</span>
              </div>
              <div class="form-grid">
                <div class="form-field span-2">
                  <label>绑定销售店铺名称（逗号分隔）</label>
                  <input class="input-control dcp-shops" value="${esc((it.bound_shops || []).join(", "))}" />
                </div>
                <div class="form-field">
                  <label>均衡提醒阈值（元/月）</label>
                  <input type="number" step="1000" class="input-control mono dcp-soft" value="${Number(it.soft_balance_cap_yuan || 80000)}" />
                </div>
                <div class="form-field">
                  <label>排期暂停上限（元/月）</label>
                  <input type="number" step="1000" class="input-control mono dcp-hard" value="${Number(it.hard_pause_cap_yuan || 100000)}" />
                </div>
                <div class="form-field">
                  <label>当月已占用额度（元）</label>
                  <input type="number" step="100" class="input-control mono dcp-used" value="${Number(it.current_month_used_yuan || 0)}" />
                </div>
                <div class="form-field">
                  <label>策略启用开关</label>
                  <select class="select-control dcp-enabled">
                    <option value="1" ${it.enabled ? "selected" : ""}>启用自动均衡派单</option>
                    <option value="0" ${!it.enabled ? "selected" : ""}>暂停限制（全部放行）</option>
                  </select>
                </div>
              </div>
            </div>
          `).join("")}
        </div>
      `;
      const footer = `
        <button type="button" class="btn btn-outline" id="btn-dcp-cancel">取消</button>
        <button type="button" class="btn btn-primary" id="btn-dcp-save">💾 保存一次性派单容量配置</button>
      `;
      openDrawer("管理端专属配置", "店铺分组月度派单容量与负荷均衡上限", html, footer);
      document.getElementById("btn-dcp-cancel").onclick = closeDrawer;
      document.getElementById("btn-dcp-save").onclick = async () => {
        const errEl = document.getElementById("dcp-err");
        errEl.classList.add("hidden");
        const cards = Array.from(document.querySelectorAll(".dcp-row-card"));
        const payloadItems = cards.map((el) => ({
          id: el.dataset.dcpId,
          group_code: el.dataset.dcpCode,
          bound_shops: el.querySelector(".dcp-shops").value,
          soft_balance_cap_yuan: Number(el.querySelector(".dcp-soft").value || 80000),
          hard_pause_cap_yuan: Number(el.querySelector(".dcp-hard").value || 100000),
          current_month_used_yuan: Number(el.querySelector(".dcp-used").value || 0),
          enabled: el.querySelector(".dcp-enabled").value === "1",
        }));
        try {
          await apiCall("/api/dispatch-capacity-policies/save", "POST", { items: payloadItems });
          toast("✅ 店铺派单容量策略已持久化保存，销售端脱敏状态实时生效", "success");
          closeDrawer();
          await reloadData();
        } catch (err) {
          errEl.textContent = "⛔ " + err.message;
          errEl.classList.remove("hidden");
        }
      };
    } catch (e) {
      toast("⛔ " + e.message, "error");
    }
  }

  window.LedgerPortals = {
    bindPortalEvents,
    openDispatchCapacityDrawer,
    updateTopbarPortalUI,
    switchPortalRole,
    caseSummaryBadge,
    getCaseForTarget,
    renderBossGapTopSection,
    renderBossOnboardingHub,
    renderSupervisorReviewsView,
    renderSupervisorAuthoringView,
    renderSupervisorDispatchView,
    renderEmployeeTasksView,
    renderEmployeeAdsPowerView,
    openWizardModal,
  };
})();
