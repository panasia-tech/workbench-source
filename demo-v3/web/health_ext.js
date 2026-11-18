/* 锚点中控 v8 · 独立「AdsPower · 设备健康度 · 负载温度 · 定位与公司网管控」专页
 * 涵盖：10台 64GB Mac Pro (50账号/台=500槽位) + CPU负载/芯片温度 + 20窗防直连巡检 + 15部业务手机「定位(在司/居家) × 公司受控网」实时合规
 */
(function () {
  "use strict";

  function B() {
    return window.LedgerBridge;
  }

  let hostFilter = "ALL"; // "ALL" | "ALERT" | "SALES" | "ISO" | "STANDBY"

  function gradeBadge(grade) {
    if (grade === "critical") return `<span class="badge badge-red">🔴 高危告警</span>`;
    if (grade === "warning") return `<span class="badge badge-amber">🟡 待巡检</span>`;
    return `<span class="badge badge-green">🟢 健康在线</span>`;
  }

  function locNetBadge(level, label) {
    const cls = level === "red" ? "badge-red" : level === "blue" ? "badge-blue" : level === "amber" ? "badge-amber" : "badge-green";
    return `<span class="badge ${cls}">${B().esc(label || "🟢 在司 · 已连公司网")}</span>`;
  }

  // 渲染 50 格可视化微缩槽位阵列（直观呈现「1台 Mac Pro 50 个账号位，占了几个、空几个」）
  function render50SlotDots(occupied, maxQuota, grade) {
    const total = Math.min(60, Math.max(10, Number(maxQuota || 50)));
    const used = Math.min(total, Math.max(0, Number(occupied || 0)));
    let dots = "";
    for (let i = 0; i < total; i++) {
      const cls = i < used ? (grade === "critical" ? "used-crit" : "used") : "";
      dots += `<span class="slot-dot ${cls}"></span>`;
    }
    return `<div class="slot-dot-matrix" title="单机 ${total} 账号标准配额阵列：已挂载 ${occupied} 个，剩余可挂 ${Math.max(0, total - occupied)} 个">${dots}</div>`;
  }

  // ==================== 1. 独立一级页面：07 Ads·健康·定位网 ====================
  function renderAdsDeviceHealthView() {
    const { state, esc, qTip, fenToShortYuan, matchLP, matchSearch, renderFoldCard } = B();
    const ch = (state.boot && state.boot.cluster_health) || {};
    const sum = ch.summary || {};
    const allHosts = (ch.mac_hosts || []).filter((m) => {
      if (state.lpFilter !== "ALL" && m.legal_person_ids && m.legal_person_ids.length > 0 && !matchLP(null, m.legal_person_ids)) {
        return false;
      }
      if (hostFilter === "ALERT" && m.effective_health_grade === "healthy" && m.loc_net_compliance_level === "green") return false;
      if (hostFilter === "SALES" && !m.cluster_zone.includes("销售") && !m.cluster_zone.includes("扩盘主力") && !m.cluster_zone.includes("电商")) return false;
      if (hostFilter === "ISO" && !m.cluster_zone.includes("采购") && !m.cluster_zone.includes("社媒")) return false;
      if (hostFilter === "STANDBY" && !m.cluster_zone.includes("预备") && !m.cluster_zone.includes("热备")) return false;
      return matchSearch(m);
    });

    const wins = (ch.ads_windows || []).filter((w) => matchSearch(w));
    const mobs = (ch.mobile_devices || []).filter((p) => (!p.legal_person_id || matchLP(p.legal_person_id)) && matchSearch(p));
    const issues = ch.health_issues || [];
    const redCnt = issues.filter((x) => x.level === "red").length;
    const yelCnt = issues.filter((x) => x.level === "yellow").length;
    const locNetViolCnt = sum.loc_net_violation_count || 0;

    return `
      <div class="page-header">
        <div>
          <h2>🖥 AdsPower 集群 · 设备负载温度 · 定位与公司网管控台 ${qTip("macpro_50_health")} ${qTip("loc_corp_net_policy")}</h2>
          <span class="cell-sub">统一纳管 10 台 64GB Mac Pro（50号/台共500槽位）与 15 部业务手机：实时监控 CPU/内存负载、芯片/电池温度、物理定位（在司 vs 居家）及是否连接公司受控网络</span>
        </div>
        <div class="op-btns">
          <button type="button" class="btn btn-outline btn-sm" data-jump-view="devices">🏷 固定资产总账与核减 (${sum.total_asset_devices || 25}台)</button>
          <button type="button" class="btn btn-outline btn-sm" data-jump-view="overview">🗺 全景思维导图</button>
          <button type="button" class="btn btn-primary btn-sm" data-open-create="adspower_profiles">+ 新增 AdsPower 窗口</button>
        </div>
      </div>

      <!-- 首屏红→黄→绿「定位×公司网违规 + 算力高温 + 窗口与真机健康」行动箱 -->
      <section class="issue-box">
        <div class="issue-box-head">
          <div class="issue-box-title">
            <span>🩺 受控设备「定位×公司网」合规、负载温度与 AdsPower 巡检行动箱</span>
            ${qTip("loc_corp_net_policy")}
            ${redCnt ? `<span class="badge badge-red">🔴 违规/高危 ${redCnt}</span>` : ""}
            ${yelCnt ? `<span class="badge badge-amber">🟡 待维护 ${yelCnt}</span>` : ""}
            ${!redCnt && !yelCnt ? `<span class="badge badge-green">🟢 全司25台设备定位、公司网与硬件100%合规健康</span>` : ""}
          </div>
          <span class="cell-sub">《公司设备使用协议》全员已签：上班在司必连公司网，离司必持居家审批并连公司 VPN</span>
        </div>
        <div class="issue-list">
          ${issues.length === 0 ? `<div class="issue-row green"><div class="issue-main"><div class="issue-headline">🎉 当前 10 台 64GB Mac Pro、全部 AdsPower 窗口及 15 部业务手机均在位连入公司受控网络且负载温度正常！</div></div></div>` : issues.map((it) => {
            let actAttr = "";
            if (it.action_type === "optimize_mac") actAttr = `data-mac-heal="${esc(it.target_id)}" data-heal-act="clean_cache_reclaim_ram"`;
            else if (it.action_type === "heal_local_api") actAttr = `data-mac-heal="${esc(it.target_id)}" data-heal-act="wake_local_api"`;
            else if (it.action_type === "open_proxy") actAttr = `data-detail-proxy="${esc(it.proxy_id)}"`;
            else if (it.action_type === "sync_cookie") actAttr = `data-win-sync-cookie="${esc(it.target_id)}"`;
            else if (it.action_type === "open_device") actAttr = `data-detail-device="${esc(it.target_id)}"`;
            else if (it.action_type === "flash_adb") actAttr = `data-mob-heal="${esc(it.target_id)}" data-mob-act="confirm_adb_flash"`;
            else if (it.action_type === "enforce_corp_wifi") actAttr = `data-comp-act="enforce_corp_wifi" data-comp-dev="${esc(it.target_id)}"`;
            else if (it.action_type === "approve_wfh_vpn") actAttr = `data-comp-act="approve_wfh_vpn" data-comp-dev="${esc(it.target_id)}"`;

            const secBtn = it.secondary_action_type === "enforce_return_office"
              ? `<button type="button" class="btn btn-outline btn-xs" data-comp-act="enforce_return_office" data-comp-dev="${esc(it.target_id)}">${esc(it.secondary_action_label)}</button>`
              : "";

            return `
              <div class="issue-row ${esc(it.level)}">
                <div class="issue-main">
                  <div class="issue-headline">
                    <span class="badge ${it.level === "red" ? "badge-red" : "badge-amber"}">${esc(it.category)}</span>
                    <span>${esc(it.title)}</span>
                  </div>
                  <div class="issue-detail">${esc(it.detail)}</div>
                </div>
                <div class="op-btns">
                  ${secBtn}
                  <button type="button" class="btn ${it.level === "red" ? "btn-danger" : "btn-amber"} btn-xs" ${actAttr}>${esc(it.action_label)}</button>
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </section>

      <!-- 顶部 5 格核心集群容量、资产、温度与定位网络指标条 -->
      <div class="stat-strip" style="grid-template-columns: repeat(5, minmax(0, 1fr));">
        <div class="stat-pill-card" data-jump-view="devices">
          <div class="stat-pill-top"><span>Mac集群 & 固定资产</span>${qTip("asset_retire_guard")}</div>
          <div class="stat-pill-val">
            <strong class="num" style="font-size:18px;white-space:nowrap;">${sum.mac_host_count || 10}×64GB</strong>
            <span class="badge badge-blue">总值${fenToShortYuan(sum.total_asset_cost_fen || 0)}</span>
          </div>
        </div>
        <div class="stat-pill-card">
          <div class="stat-pill-top"><span>50号/台 总槽位池</span>${qTip("macpro_50_health")}</div>
          <div class="stat-pill-val">
            <strong class="num" style="font-size:18px;white-space:nowrap;">${sum.total_mounted_accounts || 0}/${sum.total_account_quota || 500}</strong>
            <span class="badge badge-green">余${sum.total_remaining_slots || 0}位</span>
          </div>
        </div>
        <div class="stat-pill-card">
          <div class="stat-pill-top"><span>实时内存 & 芯片温控</span></div>
          <div class="stat-pill-val">
            <strong class="num" style="font-size:18px;white-space:nowrap;">${sum.total_ram_used_gb || 0}G</strong>
            <span class="badge ${sum.critical_host_count ? "badge-red" : "badge-green"}">${sum.critical_host_count ? `${sum.critical_host_count}台高温/高压` : `开窗${sum.open_windows_now || 0}个`}</span>
          </div>
        </div>
        <div class="stat-pill-card">
          <div class="stat-pill-top"><span>📍定位 × 公司受控网</span>${qTip("loc_corp_net_policy")}</div>
          <div class="stat-pill-val">
            <strong class="num" style="font-size:17px;white-space:nowrap;">${sum.in_office_compliant_count || 0}司·${sum.wfh_compliant_count || 0}家</strong>
            <span class="badge ${locNetViolCnt ? "badge-red" : "badge-green"}">${locNetViolCnt ? `🚨${locNetViolCnt}台违规` : "全员连公司网"}</span>
          </div>
        </div>
        <div class="stat-pill-card">
          <div class="stat-pill-top"><span>真机电池鼓包 & ADB</span>${qTip("device_isolation")}</div>
          <div class="stat-pill-val">
            <strong class="num" style="font-size:18px;white-space:nowrap;">${sum.mobile_adb_locked_count || 0}/${sum.mobile_count || 0}锁</strong>
            <span class="badge ${sum.mobile_alert_count ? "badge-red" : "badge-green"}">${sum.mobile_alert_count ? `${sum.mobile_alert_count}台预警` : "温控全绿"}</span>
          </div>
        </div>
      </div>

      <!-- 机柜筛选条 -->
      <div class="filter-bar">
        <div class="pill-group">
          <button type="button" class="pill ${hostFilter === "ALL" ? "active" : ""}" data-mac-filter="ALL">全部 10 台 Mac Pro (${(ch.mac_hosts || []).length})</button>
          <button type="button" class="pill ${hostFilter === "ALERT" ? "active" : ""}" data-mac-filter="ALERT">🚨 仅看负载/高温/待巡检机</button>
          <button type="button" class="pill ${hostFilter === "SALES" ? "active" : ""}" data-mac-filter="SALES">🟢 销售主力机群</button>
          <button type="button" class="pill ${hostFilter === "ISO" ? "active" : ""}" data-mac-filter="ISO">🟠 采购/社媒物理隔离机</button>
          <button type="button" class="pill ${hostFilter === "STANDBY" ? "active" : ""}" data-mac-filter="STANDBY">📦 待派扩盘/热备机柜</button>
        </div>
        <span class="cell-sub">💡 点击任意 Mac Pro 机柜卡可查看其资产编码、负载温度、机房定位及机内 50 槽位明细</span>
      </div>

      <!-- 核心主视觉：10 台 64GB Mac Pro (50账号/台) 机柜健康度 + 负载温度 + 公司内网矩阵 -->
      <div class="mac-rack-grid">
        ${allHosts.map((m) => `
          <div class="mac-host-card grade-${esc(m.effective_health_grade)}" data-detail-machost="${esc(m.device_id)}">
            <div class="mac-card-head">
              <div>
                <div class="op-btns">
                  <strong class="mono" style="font-size:14px;">🖥 ${esc(m.host_code)}</strong>
                  <span class="badge badge-gray mono">${esc(m.asset_no || m.rack_slot)}</span>
                </div>
                <div class="cell-sub">${esc(m.cluster_zone)} · ${esc(m.rack_slot)} · 责任人:${esc(m.custodian_staff)}</div>
              </div>
              ${gradeBadge(m.effective_health_grade)}
            </div>

            <!-- 指标 1：50 账号配额槽位水位 + 50 格点阵 -->
            <div class="mac-metric-block">
              <div class="mac-metric-row">
                <span>账号槽位 (上限${m.max_account_quota}号)</span>
                <strong class="mono">${m.occupied_slots}/${m.max_account_quota} <span style="color:var(--ink-muted);font-weight:500;">(${m.account_count}号·${m.window_count}窗)</span></strong>
              </div>
              ${render50SlotDots(m.occupied_slots, m.max_account_quota, m.effective_health_grade)}
            </div>

            <!-- 指标 2：64GB 统一内存 + CPU负载 + 芯片温度 + 公司内网定位 -->
            <div class="mac-metric-block">
              <div class="mac-metric-row">
                <span>64G内存 (开窗${m.open_windows_now}/${m.safe_concurrent_windows})</span>
                <strong class="mono" style="color:${m.ram_usage_pct >= 85 ? "var(--red-ink)" : m.ram_usage_pct >= 75 ? "var(--amber-ink)" : "var(--green)"};">
                  ${m.ram_used_gb}G/${m.ram_total_gb}G (${m.ram_usage_pct}%)
                </strong>
              </div>
              <div class="progress-bar" style="width:100%;height:7px;">
                <div class="progress-fill ${m.ram_usage_pct >= 85 ? "danger" : m.ram_usage_pct >= 75 ? "warn" : ""}" style="width:${Math.min(100, m.ram_usage_pct)}%"></div>
              </div>
              <div class="cell-sub mono" style="display:flex;justify-content:space-between;margin-top:4px;">
                <span>CPU:<b style="color:${m.cpu_load_pct >= 80 ? "var(--red-ink)" : "inherit"}">${m.cpu_load_pct}%</b> · 🌡<b style="color:${m.soc_temp_c >= 75 ? "var(--red-ink)" : "inherit"}">${m.soc_temp_c}℃</b> · Swap:${m.swap_used_gb}G</span>
                <span>API:${m.local_api_status === "online" ? "🟢50325" : "🟡待唤醒"}</span>
              </div>
            </div>

            <div class="mac-card-foot">
              <span class="cell-sub mono" title="${esc(m.geo_location_label)} · ${esc(m.connected_ssid_or_nic)}">📍在司机房 · 🟢有线内网 ${esc(m.lan_ip.split('.').slice(-2).join('.'))}${m.crawler_lease_tag ? " · 🕷爬虫" : ""}</span>
              <div class="op-btns">
                ${m.effective_health_grade === "critical"
                  ? `<button type="button" class="btn btn-danger btn-xs" data-mac-heal="${esc(m.device_id)}" data-heal-act="clean_cache_reclaim_ram">🧹 降温降载</button>`
                  : m.local_api_status !== "online"
                  ? `<button type="button" class="btn btn-amber btn-xs" data-mac-heal="${esc(m.device_id)}" data-heal-act="wake_local_api">🔌 唤醒API</button>`
                  : `<button type="button" class="btn btn-outline btn-xs" data-detail-machost="${esc(m.device_id)}">穿透 ›</button>`}
              </div>
            </div>
          </div>
        `).join("")}
      </div>

      <!-- 明细表 1（有违规时自动高亮）：15 部业务手机「实时定位(在司/居家) × 公司受控网 × 负载温度 × ADB指纹」巡检表 -->
      ${renderFoldCard({
        id: "health:mobile_devices",
        title: `📱 15 部业务手机：物理定位(在司/居家) × 公司受控网 × 负载温度与电池巡检表 (${mobs.length} 台)`,
        tipKey: "loc_corp_net_policy",
        variant: locNetViolCnt || sum.mobile_alert_count ? "danger" : "",
        pillsHtml: `
          <span class="badge ${locNetViolCnt ? "badge-red" : "badge-green"}">${locNetViolCnt ? `🚨 定位/公司网违规 ${locNetViolCnt} 台` : "✓ 全员在岗连公司网"}</span>
          <span class="badge badge-blue">ADB指纹已锁 ${sum.mobile_adb_locked_count || 0}/${mobs.length}</span>
          ${sum.mobile_alert_count ? `<span class="badge badge-amber">${sum.mobile_alert_count} 台高温/待灌录</span>` : ""}
        `,
        bodyHtml: `
          <div class="table-wrap">
            <table class="ledger-table">
              <thead>
                <tr>
                  <th>资产码 / 设备型号</th>
                  <th>责任人 & 排班模式</th>
                  <th>📍实时定位 (判断在司 vs 居家)</th>
                  <th>🌐当前连接网络 & 合规判定 ${qTip("loc_corp_net_policy")}</th>
                  <th>负载 & 温度 & 电池</th>
                  <th>ADB 指纹锁</th>
                  <th>管控与运维操作</th>
                </tr>
              </thead>
              <tbody>
                ${mobs.map((ph) => {
                  const rowCls = (ph.loc_net_compliance_level === "red" || ph.health_grade === "critical")
                    ? "row-danger"
                    : (ph.loc_net_compliance_level === "amber" || ph.health_grade === "warning")
                    ? "row-warn"
                    : "";
                  const schedTxt = ph.work_schedule_mode === "wfh_approved"
                    ? `<span class="badge badge-blue">🏠 已批居家 (${esc(ph.wfh_approval_ref)})</span>`
                    : `<span class="badge badge-gray">🏢 正常在司坐班</span>`;
                  return `
                    <tr class="${rowCls}">
                      <td>
                        <strong class="mono">${esc(ph.asset_no)}</strong> · <span class="mono">${esc(ph.device_code)}</span>
                        <span class="cell-sub">${esc(ph.brand_model)} · 卡1:${esc(ph.slot_1_phone || "空")}</span>
                      </td>
                      <td>
                        <strong>${esc(ph.custodian_staff)}</strong> · ${schedTxt}
                        <span class="cell-sub mono">已签协议: ${esc(ph.control_agreement_no)}</span>
                      </td>
                      <td>
                        <strong>📍 ${esc(ph.geo_location_label)}</strong>
                        <span class="cell-sub mono">${esc(ph.geo_coords)} ${ph.distance_from_office_km > 0.2 ? `· <b style="color:var(--red-ink)">距司 ${ph.distance_from_office_km}km</b>` : "· 在公司围栏内"}</span>
                      </td>
                      <td>
                        ${locNetBadge(ph.loc_net_compliance_level, ph.loc_net_compliance_label)}
                        <span class="cell-sub mono">${esc(ph.connected_ssid_or_nic)}</span>
                      </td>
                      <td class="mono">
                        CPU ${ph.cpu_load_pct}% · <strong style="color:${ph.battery_temp_c >= 40 ? "var(--red-ink)" : "var(--green)"};">🌡${ph.battery_temp_c}℃</strong>
                        <span class="cell-sub mono">🔋健康 ${ph.battery_health_pct}% · 余${ph.storage_free_gb}G</span>
                      </td>
                      <td>
                        ${ph.adb_fingerprint_status === "verified_locked"
                          ? `<span class="badge badge-green">✓ ADB已锁</span>`
                          : `<span class="badge badge-amber">⏳ 待灌录</span>`}
                      </td>
                      <td>
                        <div class="op-btns">
                          ${ph.loc_net_compliance_code === "violation_office_no_corp_net"
                            ? `<button type="button" class="btn btn-danger btn-xs" data-comp-act="enforce_corp_wifi" data-comp-dev="${esc(ph.device_id)}">📡 强制连公司网</button>`
                            : ""}
                          ${ph.loc_net_compliance_code === "violation_unapproved_offsite"
                            ? `<button type="button" class="btn btn-danger btn-xs" data-comp-act="approve_wfh_vpn" data-comp-dev="${esc(ph.device_id)}">🏠 补批居家+VPN</button>
                               <button type="button" class="btn btn-outline btn-xs" data-comp-act="enforce_return_office" data-comp-dev="${esc(ph.device_id)}">📍 召回在司</button>`
                            : ""}
                          ${ph.adb_fingerprint_status !== "verified_locked"
                            ? `<button type="button" class="btn btn-amber btn-xs" data-mob-heal="${esc(ph.device_id)}" data-mob-act="confirm_adb_flash">✓ 已灌录</button>`
                            : ""}
                          ${ph.battery_health_pct < 78
                            ? `<button type="button" class="btn btn-danger btn-xs" data-mob-heal="${esc(ph.device_id)}" data-mob-act="mark_battery_serviced">🔧 换电池</button>`
                            : ""}
                          <button type="button" class="btn btn-outline btn-xs" data-detail-device="${esc(ph.device_id)}">资产/管控</button>
                        </div>
                      </td>
                    </tr>
                  `;
                }).join("")}
              </tbody>
            </table>
          </div>
        `,
      })}

      <!-- 明细表 2：AdsPower 全窗口防关联与环境健康巡检表 -->
      ${renderFoldCard({
        id: "health:ads_windows",
        title: `🪟 AdsPower 全窗口防关联与环境健康巡检表 (${wins.length} 窗)`,
        tipKey: "adspower_bind",
        variant: sum.window_alert_count ? "warn" : "",
        pillsHtml: `
          <span class="badge badge-green">健康 ${sum.window_healthy_count || 0}</span>
          ${sum.window_alert_count ? `<span class="badge badge-red">熔断/待备份 ${sum.window_alert_count}</span>` : ""}
        `,
        bodyHtml: `
          <div class="table-wrap">
            <table class="ledger-table">
              <thead>
                <tr>
                  <th>窗口号 / 名称</th>
                  <th>所在 Mac Pro</th>
                  <th>出口家宽一致性 & 延迟</th>
                  <th>WebRTC / 内核指纹</th>
                  <th>Cookie 云备份时效</th>
                  <th>运行态 & 内存</th>
                  <th>承载业务账号</th>
                  <th>健康操作</th>
                </tr>
              </thead>
              <tbody>
                ${wins.map((w) => `
                  <tr class="${w.win_health_grade === "critical" ? "row-danger" : w.win_health_grade === "warning" ? "row-warn" : ""}">
                    <td>
                      <strong class="mono">${esc(w.profile_code)} (#${esc(w.ads_serial_no)})</strong>
                      <span class="cell-sub">${esc(w.window_name)}</span>
                    </td>
                    <td><span class="link-chip mono" data-detail-machost="${esc(w.host_device_id)}">🖥 ${esc(w.host_device_code || w.host_device_id)}</span></td>
                    <td class="mono">
                      ${w.exit_ip_check === "blocked_expired"
                        ? `<span class="badge badge-red">🚨 代理断网已熔断</span>`
                        : `<span class="badge badge-green">✓ 匹配 ${esc(w.exit_ip)} (${w.proxy_ping_ms}ms)</span>`}
                    </td>
                    <td><span class="badge badge-blue">WebRTC安全</span> <span class="cell-sub">${esc(w.kernel_tag)}</span></td>
                    <td class="mono">
                      <span style="color:${w.cookie_sync_hours_ago > 72 ? "var(--amber-ink)" : "var(--green)"};font-weight:700;">
                        ${w.cookie_sync_hours_ago === 0 ? "刚刚已同步" : `${w.cookie_sync_hours_ago} 小时前`}
                      </span>
                    </td>
                    <td class="mono">${w.open_state === "open" ? `🟢 打开 (${w.memory_mb}MB)` : w.open_state === "locked" ? "🔒 熔断锁止" : "⚪ 休眠 (0MB)"}</td>
                    <td>${(w.bound_accounts || []).map((a) => `<span class="link-chip" data-detail-plat="${esc(a.id)}">${esc(a.display_name)}</span>`).join(" ") || "-"}</td>
                    <td>
                      <div class="op-btns">
                        <button type="button" class="btn btn-outline btn-xs" data-win-sync-cookie="${esc(w.id)}">☁️ 备份Cookie</button>
                        <button type="button" class="btn btn-primary btn-xs" data-open-adspower-win="${esc(w.id)}">🚀 启动</button>
                      </div>
                    </td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        `,
      })}
    `;
  }

  // ==================== 2. 右侧穿透详情抽屉：单台 64GB Mac Pro 算力温度 + 固定资产 + 50 槽位全景抽屉 ====================
  function openMacHostHealthDrawer(deviceId) {
    const { state, openDrawer, apiCall, reloadData, toast, esc, fenToYuan } = B();
    const ch = (state.boot && state.boot.cluster_health) || {};
    const m = (ch.mac_hosts || []).find((x) => x.device_id === deviceId);
    if (!m) return;

    const html = `
      <div class="kv-grid">
        <div class="kv-item"><label>宿主机编号 / 固定资产码</label><div class="mono"><strong>${esc(m.host_code)}</strong> · <span class="badge badge-blue">${esc(m.asset_no)}</span></div></div>
        <div class="kv-item"><label>综合健康 & 公司网合规</label><div>${gradeBadge(m.effective_health_grade)} ${locNetBadge(m.loc_net_compliance_level, m.loc_net_compliance_label)}</div></div>
        <div class="kv-item"><label>采购原值 & 受控协议</label><div class="mono">${fenToYuan(m.purchase_cost_fen)} (${esc(m.purchase_date)}) · ${esc(m.control_agreement_no)}</div></div>
        <div class="kv-item"><label>物理定位 & 接入网络</label><div>📍 ${esc(m.geo_location_label)} · <span class="mono">${esc(m.connected_ssid_or_nic)}</span></div></div>
        <div class="kv-item"><label>CPU 负载 & 芯片温度 / 风扇</label><div class="mono">CPU <strong>${m.cpu_load_pct}%</strong> · 🌡 <strong style="color:${m.soc_temp_c >= 75 ? "var(--red-ink)" : "var(--green)"};">${m.soc_temp_c}℃</strong> (${m.fan_rpm} RPM) ${m.crawler_lease_tag ? `· <span class="badge badge-purple">${esc(m.crawler_lease_tag)}</span>` : ""}</div></div>
        <div class="kv-item"><label>64GB 内存 & Swap 水位</label><div class="mono" style="color:${m.ram_usage_pct >= 85 ? "var(--red-ink)" : "var(--green)"};">${m.ram_used_gb}GB / ${m.ram_total_gb}GB (${m.ram_usage_pct}%) · Swap ${m.swap_used_gb}GB</div></div>
        <div class="kv-item"><label>账号槽位配额水位</label><div class="mono"><strong>${m.occupied_slots} / ${m.max_account_quota} 槽位</strong>（已挂 ${m.account_count} 号 · 剩 ${m.remaining_slots} 空位）</div></div>
        <div class="kv-item"><label>SSD 存储 & 浏览器缓存体积</label><div class="mono">${m.ssd_used_gb}GB / ${m.ssd_total_gb}GB（Ads缓存 ${m.ads_cache_gb}GB）</div></div>
      </div>

      <div class="panel-card" style="padding:12px 14px;background:#f8fbff;border-color:var(--blue-border);">
        <div style="font-weight:700;margin-bottom:6px;">🩺 健康诊断与一键运维管控：</div>
        <div style="font-size:12.5px;margin-bottom:10px;">${esc(m.health_note)}</div>
        <div class="op-btns" style="flex-wrap:wrap;">
          <button type="button" class="btn btn-primary btn-sm" id="btn-drawer-clean-mac">🧹 一键清冗余缓存降温降载（保留Cookie）</button>
          <button type="button" class="btn btn-outline btn-sm" id="btn-drawer-wake-api">🔌 重连/唤醒 Local API (:50325)</button>
          <button type="button" class="btn btn-outline btn-sm" data-detail-device="${esc(m.device_id)}">🏷 固定资产卡片 / 报废核减 / 开机密码</button>
        </div>
      </div>

      <div class="panel-card" style="padding:12px 14px;">
        <div style="font-weight:700;margin-bottom:6px;">📦 50 槽位矩阵分布可视化（每格代表 1 个账号配额上限）：</div>
        ${render50SlotDots(m.occupied_slots, m.max_account_quota, m.effective_health_grade)}
        <details style="margin-top:10px;border-top:1px dashed var(--border-light);padding-top:8px;">
          <summary style="cursor:pointer;font-size:12px;color:var(--blue-dark);font-weight:600;">⚙️ 调整单机账号配额上限 / 模拟探针上报内存水位</summary>
          <div class="form-grid" style="margin-top:8px;">
            <div class="form-field">
              <label>单机最大账号槽位上限（默认 50）</label>
              <input id="mh-quota" type="number" class="input-control mono" value="${m.max_account_quota}" />
            </div>
            <div class="form-field">
              <label>当前并发打开窗口数</label>
              <input id="mh-openw" type="number" class="input-control mono" value="${m.open_windows_now}" />
            </div>
            <div class="form-field">
              <label>已用内存 (GB / 64GB)</label>
              <input id="mh-ram" type="number" step="0.1" class="input-control mono" value="${m.ram_used_gb}" />
            </div>
            <div class="form-field" style="justify-content:flex-end;">
              <button type="button" class="btn btn-primary btn-sm" id="btn-save-mh-cfg">💾 保存配额与遥测</button>
            </div>
          </div>
        </details>
      </div>

      <div class="panel-card">
        <div class="panel-head">
          <h3>🪟 本台 Mac Pro 承载的 AdsPower 窗口与业务账号 (${m.window_count} 窗 · ${m.account_count} 账号)</h3>
        </div>
        <div class="table-wrap">
          <table class="ledger-table">
            <thead><tr><th>窗口号</th><th>窗口名称</th><th>绑定家宽 & 延迟</th><th>窗口内挂载账号</th><th>状态</th></tr></thead>
            <tbody>
              ${m.windows.length === 0 ? `<tr><td colspan="5">当前为满血空闲扩盘机（50/50 槽位可随时指派新窗口）</td></tr>` : m.windows.map((w) => `
                <tr>
                  <td class="mono"><strong>${esc(w.profile_code)}</strong> (#${esc(w.ads_serial_no)})</td>
                  <td>${esc(w.window_name)}</td>
                  <td class="mono">${esc(w.proxy_code)} (${w.proxy_ping_ms > 0 ? `${w.proxy_ping_ms}ms` : "断网锁止"})</td>
                  <td>${(w.bound_accounts || []).map((a) => `<span class="link-chip" data-detail-plat="${esc(a.id)}">${esc(a.display_name)}</span>`).join(" ") || "空窗待绑号"}</td>
                  <td>${gradeBadge(w.win_health_grade)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;

    openDrawer("64GB Mac Pro 固定资产·温度与槽位穿透", `${m.host_code} (${m.asset_no}) · ${m.occupied_slots}/${m.max_account_quota}槽`, html, "", () => openMacHostHealthDrawer(deviceId));

    document.getElementById("btn-drawer-clean-mac").onclick = async () => {
      try {
        const r = await apiCall("/api/health/mac-action", "POST", { device_id: m.device_id, action: "clean_cache_reclaim_ram" });
        toast(r.message, "success");
        await reloadData();
        openMacHostHealthDrawer(m.device_id);
      } catch (e) {
        toast("⛔ " + e.message, "error");
      }
    };
    document.getElementById("btn-drawer-wake-api").onclick = async () => {
      try {
        const r = await apiCall("/api/health/mac-action", "POST", { device_id: m.device_id, action: "wake_local_api" });
        toast(r.message, "success");
        await reloadData();
        openMacHostHealthDrawer(m.device_id);
      } catch (e) {
        toast("⛔ " + e.message, "error");
      }
    };
    document.getElementById("btn-save-mh-cfg").onclick = async () => {
      try {
        const r = await apiCall("/api/health/mac-action", "POST", {
          device_id: m.device_id,
          action: "update_quota_or_telemetry",
          max_account_quota: Number(document.getElementById("mh-quota").value || 50),
          open_windows_now: Number(document.getElementById("mh-openw").value || 0),
          ram_used_gb: Number(document.getElementById("mh-ram").value || 12),
        });
        toast(r.message, "success");
        await reloadData();
        openMacHostHealthDrawer(m.device_id);
      } catch (e) {
        toast("⛔ " + e.message, "error");
      }
    };
  }

  function bindHealthEvents() {
    document.body.addEventListener("click", async (e) => {
      const { apiCall, toast, reloadData, renderCurrentView } = B();

      const compBtn = e.target.closest("[data-comp-act]");
      if (compBtn) {
        e.stopPropagation();
        try {
          const r = await apiCall("/api/assets/compliance-action", "POST", {
            device_id: compBtn.dataset.compDev,
            action: compBtn.dataset.compAct,
          });
          toast(r.message, "success");
          await reloadData();
        } catch (err) {
          toast("⛔ " + err.message, "error");
        }
        return;
      }

      const macHeal = e.target.closest("[data-mac-heal]");
      if (macHeal) {
        e.stopPropagation();
        try {
          const r = await apiCall("/api/health/mac-action", "POST", {
            device_id: macHeal.dataset.macHeal,
            action: macHeal.dataset.healAct,
          });
          toast(r.message, "success");
          await reloadData();
        } catch (err) {
          toast("⛔ " + err.message, "error");
        }
        return;
      }

      const winSync = e.target.closest("[data-win-sync-cookie]");
      if (winSync) {
        e.stopPropagation();
        try {
          const r = await apiCall("/api/health/window-action", "POST", { profile_id: winSync.dataset.winSyncCookie });
          toast(r.message, "success");
          await reloadData();
        } catch (err) {
          toast("⛔ " + err.message, "error");
        }
        return;
      }

      const mobHeal = e.target.closest("[data-mob-heal]");
      if (mobHeal) {
        e.stopPropagation();
        try {
          const r = await apiCall("/api/health/mobile-action", "POST", {
            device_id: mobHeal.dataset.mobHeal,
            action: mobHeal.dataset.mobAct,
          });
          toast(r.message, "success");
          await reloadData();
        } catch (err) {
          toast("⛔ " + err.message, "error");
        }
        return;
      }

      const mf = e.target.closest("[data-mac-filter]");
      if (mf) {
        e.stopPropagation();
        hostFilter = mf.dataset.macFilter;
        renderCurrentView();
        return;
      }

      const detailMac = e.target.closest("[data-detail-machost]");
      if (detailMac) {
        e.stopPropagation();
        openMacHostHealthDrawer(detailMac.dataset.detailMachost);
        return;
      }
    });
  }

  window.LedgerHealth = {
    bindHealthEvents,
    renderAdsDeviceHealthView,
    openMacHostHealthDrawer,
  };
})();
