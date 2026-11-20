import { computed, reactive, watch } from 'vue';
import { ROLES, buildInitialState } from './data/seed.js';
import { makeWarrantyCardSvg } from './data/autoCardsSvg.js';
import { makeRealPhoto } from './data/mediaSvg.js';

const STORAGE_KEY = 'panasia_cs_folded_v3';
const TARGET_VERSION = 'cs-folded-master-20261118-v3';

function nowHm() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function nowHms() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds(),
  ).padStart(2, '0')}`;
}

export const store = reactive({
  actorId: 'outsource_lu',
  dutyOnline: true,
  data: buildInitialState(),
  auditLogs: [
    {
      seq: 1,
      createdAt: '14:16:05',
      actor: '系统引擎',
      action: 'auto_warranty_card',
      summary: '订单 JD-261116-5519 发完实拍后自动跟发《保修激活确认卡（含富阳法院管辖条款）》',
    },
    {
      seq: 2,
      createdAt: '14:19:12',
      actor: '系统引擎',
      action: 'auto_ship_pause',
      summary: '订单 XY-261116-8801 买家发问触发毫秒级熔断，自动暂停推仓并移入【问题订单】',
    },
    {
      seq: 3,
      createdAt: '14:24:01',
      actor: '系统引擎',
      action: 'auto_refund_guide',
      summary: '订单 TB-261116-6612 买家申请退款，0秒自动发送《手机UI三步选“不想要了/协商一致”引导图》',
    },
  ],
  toast: '',
  ui: {
    activeTab: 'pre_sale', // pre_sale | after_sale | issue
    selectedConvId: 'C1',
    search: '',
    filterOpen: false,
    platformFilter: 'all',
    urgentOnly: false,
    // 顶部抽屉与折叠弹窗开关
    kpiDrawerOpen: false,
    autoShipDrawerOpen: false,
    autoRuleModalOpen: false,
    manualDrawerOpen: false,
    moreMenuOpen: false,
    // 零培训与媒体预览状态（与 HelpDrawer / OnboardingOverlays / VideoPlayerModal 联动）
    helpKey: null,
    tourStep: -1,
    practiceOpenKey: null,
    videoModalSku: null,
    photoPreviewUrl: null,
    photoPreviewTitle: '',
    darkMode: false,
    largeFont: false,
    route: 'chat',
  },
});

// 兼容 HelpDrawer.vue 内部点击「打开完整手册总表」设置 route = 'manual'
watch(
  () => store.ui.route,
  (r) => {
    if (r === 'manual') {
      store.ui.manualDrawerOpen = true;
      store.ui.route = 'chat';
    }
  },
);

watch(
  () => store.ui.darkMode,
  (dark) => {
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    }
  },
  { immediate: true },
);

watch(
  () => store.ui.largeFont,
  (lg) => {
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.font = lg ? 'large' : 'normal';
    }
  },
  { immediate: true },
);

let toastTimer = null;
export function showToast(msg) {
  store.toast = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    store.toast = '';
  }, 3400);
}

export const currentRole = computed(
  () => ROLES.find((r) => r.id === store.actorId) || ROLES[0],
);

export const isOutsourceRole = computed(
  () => store.actorId === 'outsource_lu' || store.actorId === 'newbie',
);

export const isInternalOrSupervisor = computed(
  () => store.actorId === 'internal_chen' || store.actorId === 'supervisor',
);

export const practiceStatus = computed(() => {
  const map = store.data.practices?.[store.actorId] || {
    link_media: true,
    pick_autoship: true,
    redline_guard: true,
  };
  const keys = ['link_media', 'pick_autoship', 'redline_guard'];
  const passedCount = keys.filter((k) => Boolean(map[k])).length;
  const nextKey = keys.find((k) => !map[k]) || 'link_media';
  return {
    map,
    passedCount,
    total: 3,
    allPassed: passedCount === 3,
    nextKey,
  };
});

export const newbieLocked = computed(
  () => store.actorId === 'newbie' && !practiceStatus.value.allPassed,
);

// RBAC 脱敏商品读取：外包角色隐藏采购成本 costPrice 与上游卖家 supplierNick；内部销售/主管可见
export function getVisibleSku(skuCode) {
  if (!skuCode) return null;
  const raw = store.data.skus.find((s) => s.skuCode === skuCode);
  if (!raw) return null;
  const copy = {
    ...raw,
    videoReady: Boolean(raw.gates?.videoOk && raw.video),
    allGatesOk: Boolean(
      raw.gates?.inspectOk &&
        raw.gates?.videoOk &&
        raw.gates?.photoOk &&
        raw.gates?.subCodeOk,
    ),
  };
  if (isOutsourceRole.value) {
    delete copy.costPrice;
    delete copy.supplierNick;
  }
  return copy;
}

export const getSku = getVisibleSku;

export function getSameSpuSkus(spuCode) {
  if (!spuCode) return [];
  return store.data.skus
    .filter((s) => s.spuCode === spuCode)
    .map((s) => getVisibleSku(s.skuCode));
}

export const tabCounts = computed(() => {
  const list = store.data.conversations;
  return {
    pre_sale: list.filter((c) => c.category === 'pre_sale').length,
    after_sale: list.filter((c) => c.category === 'after_sale').length,
    issue: list.filter((c) => c.category === 'issue').length,
  };
});

export const activeAgentKpi = computed(() => {
  const agents = store.data.kpi?.agents || [];
  return (
    agents.find((a) => a.id === store.actorId) ||
    agents.find((a) => a.id === 'outsource_lu') ||
    agents[0]
  );
});

export const autoShipLanes = computed(() => {
  const paid = store.data.conversations.filter((c) => Boolean(c.orderNo));
  return {
    waitPick: paid.filter(
      (c) => c.stepState === 'WAIT_PICK_SEND' || c.stepState === 'ISSUE_NO_VIDEO',
    ),
    counting: paid.filter((c) => c.stepState === 'WAIT_WARRANTY_AGREE'),
    paused: paid.filter(
      (c) =>
        c.stepState === 'ISSUE_BUYER_QUESTION' ||
        c.stepState === 'TRANSFERRED_INTERNAL',
    ),
    pushed: paid.filter(
      (c) =>
        c.stepState === 'SHIPPED_AUTO' ||
        c.stepState === 'INTERCEPTED_409' ||
        Boolean(c.wmsWaveNo),
    ),
  };
});

function pushLocalAudit(action, summary) {
  const nextSeq = (store.auditLogs[0]?.seq || 0) + 1;
  store.auditLogs.unshift({
    seq: nextSeq,
    createdAt: nowHms(),
    actor: currentRole.value.name,
    action,
    summary,
  });
  if (store.auditLogs.length > 60) {
    store.auditLogs.length = 60;
  }
}

async function syncBackend(action, summary) {
  pushLocalAudit(action, summary);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store.data));
  } catch (_) {}

  if (typeof window !== 'undefined' && window.location.protocol.startsWith('http')) {
    try {
      await fetch('/api/cs/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CS-Actor': store.actorId,
        },
        body: JSON.stringify({
          action,
          summary,
          actor: currentRole.value.name,
          state: store.data,
        }),
      });
    } catch (_) {}
  }
}

export async function initStore() {
  if (typeof window !== 'undefined' && window.location.protocol.startsWith('http')) {
    try {
      const res = await fetch('/api/cs/state', {
        headers: { 'X-CS-Actor': store.actorId },
      });
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json.logs) && json.logs.length) {
          store.auditLogs = json.logs;
        }
        if (json.data?.version === TARGET_VERSION) {
          store.data = json.data;
          startLiveTicker();
          return;
        }
      }
    } catch (_) {}
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.version === TARGET_VERSION) {
        store.data = parsed;
      }
    }
  } catch (_) {}
  startLiveTicker();
}

let tickerId = null;
function startLiveTicker() {
  if (tickerId) return;
  tickerId = setInterval(() => {
    for (const c of store.data.conversations) {
      if (typeof c.slaRemainSec === 'number' && c.slaRemainSec > 0) {
        c.slaRemainSec -= 1;
      }
      if (
        c.stepState === 'WAIT_WARRANTY_AGREE' &&
        typeof c.autoShipRemainSec === 'number' &&
        c.autoShipRemainSec > 0
      ) {
        c.autoShipRemainSec -= 1;
      }
    }
  }, 1000);
}

export function formatSec(sec) {
  if (sec === null || sec === undefined) return '';
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export async function switchActor(newActorId) {
  store.actorId = newActorId;
  store.ui.moreMenuOpen = false;
  if (typeof window !== 'undefined' && window.location.protocol.startsWith('http')) {
    try {
      const res = await fetch('/api/cs/state', {
        headers: { 'X-CS-Actor': newActorId },
      });
      if (res.ok) {
        const json = await res.json();
        if (json.data?.version === TARGET_VERSION) {
          store.data = json.data;
        }
        if (Array.isArray(json.logs) && json.logs.length) {
          store.auditLogs = json.logs;
        }
      }
    } catch (_) {}
  }
  const role = ROLES.find((r) => r.id === newActorId);
  showToast(`已切换视角：${role?.name} · ${role?.roleLabel}`);
}

export function toggleDutyStatus() {
  if (store.dutyOnline) {
    const urgentCnt = store.data.conversations.filter(
      (c) => (typeof c.slaRemainSec === 'number' && c.slaRemainSec > 0) || c.autoRepliedOnly,
    ).length;
    store.dutyOnline = false;
    if (urgentCnt > 0) {
      showToast(`☕ 已切小休（注意：当前仍有 ${urgentCnt} 条待人工首响会话，请尽快交接）`);
    } else {
      showToast('☕ 已切换至小休离席状态');
    }
  } else {
    store.dutyOnline = true;
    showToast('🟢 已恢复在岗接待状态');
  }
}

export async function completePracticeStep(key) {
  if (!store.data.practices[store.actorId]) {
    store.data.practices[store.actorId] = {
      link_media: false,
      pick_autoship: false,
      redline_guard: false,
    };
  }
  store.data.practices[store.actorId][key] = true;
  await syncBackend('practice_pass', `通关新人防呆演练关卡：${key}`);
}

export async function resetPracticeForCurrentActor() {
  store.data.practices[store.actorId] = {
    link_media: false,
    pick_autoship: false,
    redline_guard: false,
  };
  store.ui.practiceOpenKey = 'link_media';
  await syncBackend('practice_reset', `重置角色 ${currentRole.value.name} 的3关练习进度`);
  showToast('已重置当前角色的 3 关新手练习，可重新体验防呆解锁');
}

export async function resetDemo() {
  store.data = buildInitialState();
  store.actorId = 'outsource_lu';
  store.dutyOnline = true;
  store.ui.activeTab = 'pre_sale';
  store.ui.selectedConvId = 'C1';
  store.ui.search = '';
  store.ui.platformFilter = 'all';
  store.ui.urgentOnly = false;
  store.ui.moreMenuOpen = false;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (_) {}
  if (typeof window !== 'undefined' && window.location.protocol.startsWith('http')) {
    try {
      await fetch('/api/cs/reset', {
        method: 'POST',
        headers: { 'X-CS-Actor': store.actorId },
      });
    } catch (_) {}
  }
  await syncBackend('reset', '重置全部演示数据回 V3 初始基线');
  showToast('✓ 已恢复初始完整演示数据');
}

// 实时外发守卫校验（防微信号/手机号导流、防索要密码、防单字“1”刷尾响、防站外风险链接）
export function checkOutboundGuard(text = '') {
  const t = text.trim();
  if (!t) return { ok: true, reason: '', penalty: '' };

  if (/^[1。，.,?？~～!！]$/.test(t)) {
    return {
      ok: false,
      reason: '检测到无意义单字符（如“1”或单标点），系统禁止以此刷尾响闭环率',
      penalty: '反作弊引擎不计入有效人工回复，请使用正常礼貌短语解答买家',
    };
  }
  if (/\b1[3-9]\d{9}\b/.test(t)) {
    return {
      ok: false,
      reason: '检测到 11 位手机号码，严禁向外发送个人联系方式',
      penalty: '触发平台站外引流红线会导致封店扣分，请删掉手机号后发送',
    };
  }
  if (
    /(微信|vx|v信|wx|薇信|加我|私下转|支付宝转)/i.test(t) &&
    !/(不能|不要|平台规定|不加|无法)/.test(t)
  ) {
    return {
      ok: false,
      reason: '命中站外引流敏感词（微信/私下转账）',
      penalty: '请改用下方【防站外引流标准婉拒】快捷话术在平台内发实拍视频',
    };
  }
  if (/(Apple\s*ID密码|锁屏密码|开机密码|验证码发我)/i.test(t)) {
    return {
      ok: false,
      reason: '严禁在聊天窗向买家索要账号密码或短信验证码',
      penalty: '涉及验机解绑请一键转内部技术售后专员处理',
    };
  }
  const urls = t.match(/https?:\/\/[^\s]+/gi) || [];
  for (const u of urls) {
    if (!/(goofish\.com|taobao\.com|tmall\.com|yangkeduo\.com|jd\.com|jinritemai\.com)/i.test(u)) {
      return {
        ok: false,
        reason: `严禁向外发送非本平台白名单外部链接（${u.slice(0, 32)}...）`,
        penalty: '外部网盘或第三方链接会被平台判定高危导流直接屏蔽',
      };
    }
  }
  return { ok: true, reason: '', penalty: '' };
}

// 买家消息内链接自动体检识别（用于 C8 未绑货号链接与外部网盘链接警示）
export function inspectLinksInText(text = '', conv = null) {
  const urls = (text || '').match(/https?:\/\/[^\s]+/gi) || [];
  return urls.map((u) => {
    const isStoreUrl = /(goofish\.com|taobao\.com|tmall\.com|yangkeduo\.com|jd\.com|jinritemai\.com)/i.test(
      u,
    );
    if (!isStoreUrl) {
      return {
        url: u,
        tone: 'red',
        label: '🛑 外部风险链接（网盘/站外地址，外包端已安全阻断请勿点击）',
      };
    }
    if (conv && !conv.linkResolved) {
      return {
        url: u,
        tone: 'amb',
        label: '⚠️ 本店商品链接未挂接 WMS 货号（严禁盲答有货，请点右侧呼叫内部销售绑货）',
      };
    }
    return {
      url: u,
      tone: 'grn',
      label: '✓ 本店白名单商品链接（已自动关联右侧 WMS 在库实拍）',
    };
  });
}

// 1. 人工发送聊天消息
export async function sendChatMessage(convId, text) {
  const conv = store.data.conversations.find((c) => c.id === convId);
  if (!conv || !text.trim()) return false;

  if (newbieLocked.value) {
    store.ui.practiceOpenKey = practiceStatus.value.nextKey;
    showToast('🎓 请先完成 3 关新人防呆练习解锁发送权限');
    return false;
  }

  if (conv.owner?.type === 'internal' && isOutsourceRole.value) {
    showToast(`🔒 当前会话已由【${conv.owner.name}】排他接管，等待交还后再回复`);
    return false;
  }

  const guard = checkOutboundGuard(text);
  if (!guard.ok) {
    showToast('🛡️ 外发守卫已拦截：' + guard.reason);
    pushLocalAudit('guard_block', `拦截违规外发词：${guard.reason}`);
    return false;
  }

  conv.messages.push({
    id: 'm-' + Date.now(),
    dir: 'out',
    who: `${currentRole.value.name}`,
    time: nowHm(),
    text: text.trim(),
  });
  conv.time = nowHm();
  conv.slaRemainSec = null;

  if (conv.autoRepliedOnly) {
    conv.autoRepliedOnly = false;
    conv.statusBadge = '✓ 已补人工真回';
  }

  const ag = store.data.kpi.agents.find((a) => a.id === 'outsource_lu');
  if (ag) {
    ag.manualReplied += 1;
    ag.totalSessions += 1;
  }

  await syncBackend('reply', `人工回复买家 ${conv.buyerNick}`);
  return true;
}

export const sendManualText = sendChatMessage;

// 2. 按场景发送图片卡片（自动或手动）
export async function sendRuleCardImage(convId, ruleId, isAuto = false) {
  const conv = store.data.conversations.find((c) => c.id === convId);
  const rule = store.data.autoRules.find((r) => r.id === ruleId);
  if (!conv || !rule) return;

  const sku = getVisibleSku(conv.skuCode);
  const imgUrl =
    rule.cardType === 'warranty' && sku
      ? makeWarrantyCardSvg({ productName: sku.title, skuCode: sku.skuCode, sn: sku.sn })
      : rule.imageUrl;

  conv.messages.push({
    id: 'card-' + Date.now() + Math.random().toString(36).slice(2, 6),
    dir: 'out',
    who: isAuto ? '系统自动发图' : currentRole.value.name,
    autoTag: isAuto ? `⚡ 自动触发 · ${rule.sceneName}` : `🖼 手动发送 · ${rule.sceneName}`,
    time: nowHm(),
    text: rule.accompanyText,
    cardImage: imgUrl,
    cardTitle: rule.sceneName,
  });

  if (rule.cardType === 'warranty') {
    conv.warrantySent = true;
    if (conv.orderNo && !conv.warrantyActivated) {
      conv.stepState = 'WAIT_WARRANTY_AGREE';
      conv.autoShipRemainSec = (store.data.kpi.config.autoShipWindowMin || 30) * 60;
      conv.statusBadge = '等回“同意”激活保修';
    }
  }
  await syncBackend('send_card', `发送场景图片卡：${rule.sceneName}`);
}

// 3. WMS 挑货锁单 + 一键发送本机实拍照片与视频 + 自动跟发《保修激活确认卡（富阳法院管辖）》
export async function pickSkuAndSendRealShot(convId, chosenSkuCode) {
  const conv = store.data.conversations.find((c) => c.id === convId);
  const rawSku = store.data.skus.find((s) => s.skuCode === chosenSkuCode);
  if (!conv || !rawSku) return;

  if (newbieLocked.value) {
    store.ui.practiceOpenKey = practiceStatus.value.nextKey;
    showToast('🎓 请先完成 3 关新人防呆练习解锁挑货锁库权限');
    return;
  }

  if (!rawSku.gates?.videoOk || !rawSku.video) {
    showToast('🔒 该机器缺少仓管高拍仪通电视频，售前四关未全绿，系统禁止发给买家！');
    return;
  }

  // 若切换了同款另一台（如 C6 从 95新 换挑 99新），释放旧锁并锁定新单品
  if (conv.skuCode && conv.skuCode !== rawSku.skuCode) {
    const prev = store.data.skus.find((s) => s.skuCode === conv.skuCode);
    if (prev) prev.status = 'IN_STOCK';
  }
  conv.skuCode = rawSku.skuCode;
  if (conv.orderNo) {
    rawSku.status = 'RESERVED';
  }

  conv.realShotSent = true;
  conv.slaRemainSec = null;
  conv.autoRepliedOnly = false;
  conv.time = nowHm();

  conv.messages.push({
    id: 'real-' + Date.now(),
    dir: 'out',
    who: currentRole.value.name,
    autoTag: '📸 WMS 一件一拍核验包',
    time: nowHm(),
    text: `亲您好！已为您核验仓库真机【${rawSku.title} · ${rawSku.grade} · 货号 ${rawSku.skuCode} · 序列号 ${rawSku.sn}】。全检摘要：${rawSku.ahsSummary}。以下为仓管高拍仪录制的本机实拍图与 ${rawSku.video.duration} 通电视频：`,
    mediaSkuCode: rawSku.skuCode,
  });

  const warrantyRule = store.data.autoRules.find((r) => r.id === 'rule_warranty');
  if (conv.orderNo && warrantyRule?.enabled) {
    await sendRuleCardImage(conv.id, 'rule_warranty', true);
    conv.issueReason = '';
    if (conv.category === 'issue') {
      conv.category = 'pre_sale';
      store.ui.activeTab = 'pre_sale';
    }
    showToast('✅ 已发本机实拍视频照片，并自动跟发《保修激活确认卡》！');
  } else if (conv.orderNo) {
    conv.stepState = 'WAIT_WARRANTY_AGREE';
    conv.autoShipRemainSec = (store.data.kpi.config.autoShipWindowMin || 30) * 60;
    conv.statusBadge = '静默观察倒计时中';
    showToast('已发本机实拍照片和视频，进入静默自动发货观察窗！');
  } else {
    conv.statusBadge = '✓ 已发实拍促单';
    showToast('已向咨询买家发出本机实拍照片与通电视频！');
  }

  await syncBackend(
    'pick_and_realshot',
    `向 ${conv.buyerNick} 锁库发送单品 ${rawSku.skuCode} 一件一拍实拍包`,
  );
}

export const sendRealShotAndTriggerWarranty = pickSkuAndSendRealShot;

// 4. 模拟买家发消息（回“同意” -> 自动激活保修+富阳法院管辖生效+自动推仓；发疑问 -> 毫秒级熔断转问题订单）
export async function simulateBuyerMessage(convId, buyerText) {
  const conv = store.data.conversations.find((c) => c.id === convId);
  if (!conv || !buyerText.trim()) return;

  conv.messages.push({
    id: 'bin-' + Date.now(),
    dir: 'in',
    who: conv.buyerNick,
    time: nowHm(),
    text: buyerText.trim(),
  });
  conv.time = nowHm();

  if (conv.warrantySent && !conv.warrantyActivated && buyerText.includes('同意')) {
    conv.warrantyActivated = true;
    conv.stepState = 'SHIPPED_AUTO';
    conv.autoShipRemainSec = 0;
    conv.wmsWaveNo = 'WAVE-261118-09（顺丰保价打单待揽）';
    conv.category = 'pre_sale';
    conv.issueReason = '';
    conv.slaRemainSec = null;
    conv.statusBadge = '✅ 保修已激活·已推仓';

    const ag = store.data.kpi.agents.find((a) => a.id === 'outsource_lu');
    if (ag) ag.warrantyActiveCount += 1;

    conv.messages.push({
      id: 'act-' + (Date.now() + 1),
      dir: 'out',
      who: '系统自动激活引擎',
      autoTag: '✅ 识别到“同意” · 保修与管辖条款已生效',
      time: nowHm(),
      text: `🎉 感谢您的确认！本机（货号 ${conv.skuCode}）店铺质保服务已自动激活（含杭州市富阳区人民法院管辖条款已留痕生效），订单已自动推入仓库波次 ${conv.wmsWaveNo} 激光扫四码打包发出！`,
    });
    showToast('🎉 买家回复“同意”！保修已自动激活并自动推入仓库顺丰波次！');
  } else if (
    conv.orderNo &&
    conv.stepState !== 'SHIPPED_AUTO' &&
    conv.stepState !== 'INTERCEPTED_409' &&
    !String(conv.stepState).startsWith('REFUND')
  ) {
    conv.category = 'issue';
    conv.stepState = 'ISSUE_BUYER_QUESTION';
    conv.slaRemainSec = 150;
    conv.issueReason = `买家发来疑问：“${buyerText.trim()}” → 自动发货已毫秒级熔断暂停，等待人工介入！`;
    conv.statusBadge = '⚡ 疑问熔断·已停发';
    store.ui.activeTab = 'issue';
    store.ui.selectedConvId = conv.id;

    conv.messages.push({
      id: 'sys-pause-' + (Date.now() + 2),
      dir: 'sys',
      time: nowHm(),
      text: '⚡ 监测到买家在发货前提出疑问，系统已毫秒级暂停自动发货并移入【问题订单】！',
    });
    showToast('⚡ 买家提疑问！自动发货已瞬间熔断暂停并转入【问题订单】！');
  } else {
    conv.slaRemainSec = 165;
  }

  await syncBackend('buyer_msg', `买家 ${conv.buyerNick} 消息：${buyerText.trim()}`);
}

// 5. 静默观察窗倒计时归零自动推仓 / 人工解答完毕恢复推仓
export async function pushOrderToWmsWave(convId, mode = 'silent_timeout') {
  const conv = store.data.conversations.find((c) => c.id === convId);
  if (!conv) return;
  if (!conv.realShotSent) {
    showToast('🔒 尚未向买家发出本机实拍视频与照片，系统严禁直接推仓发货！');
    return;
  }
  conv.stepState = 'SHIPPED_AUTO';
  conv.autoShipRemainSec = 0;
  conv.slaRemainSec = null;
  conv.issueReason = '';
  conv.wmsWaveNo =
    mode === 'silent_timeout'
      ? 'WAVE-261118-10（静默期满无异议自动推仓）'
      : 'WAVE-261118-11（人工排障后恢复推仓）';
  conv.category = 'pre_sale';
  conv.statusBadge =
    mode === 'silent_timeout' ? '✅ 静默期满·自动推仓' : '✓ 疑问已解·恢复推仓';

  conv.messages.push({
    id: 'wave-' + Date.now(),
    dir: 'sys',
    time: nowHm(),
    text:
      mode === 'silent_timeout'
        ? `📦 静默观察期满买家无异议，系统已自动将订单推入仓管波次 ${conv.wmsWaveNo}。`
        : `📦 人工已解答买家疑问，订单恢复推入仓管波次 ${conv.wmsWaveNo}。`,
  });
  showToast(`📦 已推入仓库波次：${conv.wmsWaveNo}`);
  await syncBackend('push_wms_wave', `订单 ${conv.orderNo} 推入仓库波次 (${mode})`);
}

// 6. 409 红屏急停拦截（已进仓管拣货波次的订单，买家突然退单/改地址）
export async function triggerEmergencyWmsIntercept(convId) {
  const conv = store.data.conversations.find((c) => c.id === convId);
  if (!conv) return;
  conv.stepState = 'INTERCEPTED_409';
  conv.wmsWaveNo = '🛑 409红屏拦截生效（打包台激光枪蜂鸣锁死面单）';
  conv.statusBadge = '🛑 409红屏已拦停';
  conv.slaRemainSec = null;

  conv.messages.push({
    id: 'int409-' + Date.now(),
    dir: 'sys',
    time: nowHm(),
    text: '🛑 已向 WMS 下发【409 红屏急停拦截指令】！仓管打包台扫该货号将触发三连蜂鸣并物理锁死电子面单，强制退回原货架。',
  });
  showToast('🛑 409 红屏急停指令已送达仓管打包台，面单已物理锁死！');
  await syncBackend('wms_409_intercept', `对订单 ${conv.orderNo} 发起 409 红屏打包台急停拦截`);
}

// 7. 买家发起退款申请 -> 0 秒自动发送《3步手机UI选“不想要了/协商一致”引导图》
export async function triggerBuyerApplyRefund(convId) {
  const conv = store.data.conversations.find((c) => c.id === convId);
  if (!conv) return;

  conv.category = 'after_sale';
  store.ui.activeTab = 'after_sale';
  store.ui.selectedConvId = conv.id;

  conv.messages.push({
    id: 'rf-sys-' + Date.now(),
    dir: 'sys',
    time: nowHm(),
    text: '系统检测到买家刚点击【申请退款】→ 0 秒触发售后自动发图引擎！',
  });

  const refundRule = store.data.autoRules.find((r) => r.id === 'rule_refund_guide');
  if (refundRule?.enabled) {
    await sendRuleCardImage(conv.id, 'rule_refund_guide', true);
    conv.stepState = 'REFUND_GUIDE_SENT';
    conv.statusBadge = '已自动发退款UI图';
    showToast('⚡ 已 0 秒自动向买家发出《手机UI三步选“不想要了/协商一致”引导图》！');
  } else {
    conv.stepState = 'REFUND_MANUAL';
    conv.statusBadge = '待人工处理退款';
    showToast('买家发起了退款申请（自动发图开关当前已关闭）');
  }

  await syncBackend(
    'auto_refund_guide',
    `买家 ${conv.buyerNick} 申请退款，第一时间自动发送手机UI退款原因引导图`,
  );
}

// 8. 模拟买家照着手机 UI 图改成「不想要了 / 协商一致」 -> 自动秒通过退款并释放库存
export async function simulateBuyerModifiedRefundReason(convId) {
  const conv = store.data.conversations.find((c) => c.id === convId);
  if (!conv) return;

  conv.refundReasonOk = true;
  conv.stepState = 'REFUND_DONE';
  conv.statusBadge = '✓ 协商一致·秒退完成';
  conv.slaRemainSec = null;

  if (conv.skuCode) {
    const rawSku = store.data.skus.find((s) => s.skuCode === conv.skuCode);
    if (rawSku) rawSku.status = 'IN_STOCK';
  }

  conv.messages.push({
    id: 'rf-ok-' + Date.now(),
    dir: 'in',
    who: conv.buyerNick,
    time: nowHm(),
    text: '我已经照着你发的手机步骤图，点【修改申请】把原因改成【不想要了 / 协商一致】提交啦！',
  });

  conv.messages.push({
    id: 'rf-pass-' + (Date.now() + 1),
    dir: 'out',
    who: '系统自动秒退引擎',
    autoTag: '✓ 原因合规 · 0秒极速退款',
    time: nowHm(),
    text: '亲，系统检测到您已选择【不想要了/协商一致】，已为您 0 秒自动审批全额退款，款项原路秒退回账户，原锁定库存已释放，欢迎下次光临！',
  });

  showToast('✓ 检测到退款原因已改为“不想要了/协商一致”，已 0 秒自动全额秒退！');
  await syncBackend('refund_auto_pass', `订单 ${conv.orderNo || conv.id} 改对原因自动秒退`);
}

// 9. 发起跨部门 60 秒协同升级工单（催仓管补视频 / 呼叫销售绑链接 / 超权限砍价转内部 / 售后专员）
export async function createCollabEscalation(convId, kind, noteText = '') {
  const conv = store.data.conversations.find((c) => c.id === convId);
  if (!conv) return;

  const labelMap = {
    rush_video: '📸 催仓管 60s 补拍高拍仪通电视频',
    bind_link: '🔗 呼叫内部销售 60s 绑定商品链接与 WMS 货号',
    bargain_sales: '💰 超权限砍价 / 大客户议价呼叫内部销售',
    aftersale_tech: '🛠️ 疑难技术售后呼叫内部专员',
  };
  const title = labelMap[kind] || '跨部门 60s 协同工单';

  conv.collabTicket = {
    id: 'TK-' + Date.now().toString().slice(-4),
    kind,
    title,
    note: noteText || '请内部同事 60 秒内协助处理',
    status: 'PENDING',
    createdAt: nowHm(),
  };
  conv.statusBadge = '⏳ 60s协同呼救中';

  conv.messages.push({
    id: 'tk-' + Date.now(),
    dir: 'sys',
    time: nowHm(),
    text: `🤝 已发起跨台协同【${title}】（60秒倒计时直达仓管/销售工作台首页红灯队列）。`,
  });

  showToast(`🤝 已发起：${title}`);
  await syncBackend('collab_escalate', `会话 ${conv.id} 发起协同：${title}`);
}

// 10. 内部工作台响应 / 接管抢锁 / 幕后回复锦囊 / 必填备注交还 / 退回无效甩锅
export async function handleInternalCollabAction(convId, actionType, payload = {}) {
  const conv = store.data.conversations.find((c) => c.id === convId);
  if (!conv) return;

  if (actionType === 'sim_warehouse_upload_video') {
    const targetCode = payload.skuCode || conv.skuCode || '990001880106';
    const rawSku = store.data.skus.find((s) => s.skuCode === targetCode);
    if (rawSku) {
      rawSku.gates.videoOk = true;
      rawSku.ahsSummary = `爱回收客观全检通过（${rawSku.grade.replace('(阻塞)', '')}）· 刚由仓管高拍仪补传 1080p60 通电实测视频，四关全绿可锁单！`;
      rawSku.grade = rawSku.grade.replace('(阻塞)', '');
      rawSku.video = {
        title: `【仓管刚补传】${rawSku.title.slice(0, 18)} 亮屏与序列号核验视频`,
        duration: '00:15',
        resolution: '1080p 60fps',
        channelMode: '官方客服原生 MP4 通道发送',
        chapters: [
          { t: '00:00', label: `机身条码 ${rawSku.skuCode} 与原厂序列号 ${rawSku.sn} 核对` },
          { t: '00:08', label: '通电满载测试与纯色无坏点实拍' },
        ],
      };
      rawSku.photos.push({
        id: 'wh-new-' + Date.now(),
        type: 'real',
        label: '刚补拍通电实测照',
        url: makeRealPhoto({
          kind: rawSku.kind || 'asus',
          skuCode: rawSku.skuCode,
          shortCode: rawSku.shortCode,
          angle: '刚补拍·四关全绿通过',
          grade: rawSku.grade,
          sn: rawSku.sn,
          variant: 2,
        }),
      });
    }
    if (conv.collabTicket) conv.collabTicket.status = 'DONE';
    conv.stepState = conv.orderNo ? 'WAIT_PICK_SEND' : 'INQUIRY';
    conv.issueReason = '';
    conv.statusBadge = '🎬 视频已补齐·可发买家';
    conv.messages.push({
      id: 'wh-done-' + Date.now(),
      dir: 'sys',
      time: nowHm(),
      text: `🎬 仓管高拍仪工位已完成补录上传（货号 ${targetCode} 售前四关已全绿），现在可一键发给买家！`,
    });
    showToast('🎬 仓管已补传 1080p60 通电实拍视频，四关全绿已解锁！');
  } else if (actionType === 'sim_sales_bind_link') {
    conv.linkResolved = true;
    conv.spuCode = 'SPU-LG-27GP850';
    conv.skuCode = '990001440512';
    conv.stepState = 'INQUIRY';
    conv.issueReason = '';
    if (conv.collabTicket) conv.collabTicket.status = 'DONE';
    conv.statusBadge = '✓ 链接已绑·可发实拍';
    conv.messages.push({
      id: 'bind-done-' + Date.now(),
      dir: 'sys',
      time: nowHm(),
      text: '🔗 内部销售陈小满已完成链接挂接 → 关联 WMS 在库单品【LG 27GP850-B · 货号 990001440512 · 95新】，现可安全发送实拍！',
    });
    showToast('🔗 内部销售已完成商品链接绑定，右侧在库实拍已就绪！');
  } else if (actionType === 'internal_claim') {
    conv.owner = { type: 'internal', id: 'internal_chen', name: '陈小满（内部销售）' };
    conv.statusBadge = '🔒 陈小满排他接管中';
    conv.messages.push({
      id: 'claim-' + Date.now(),
      dir: 'sys',
      time: nowHm(),
      text: '🔒 内部销售【陈小满】已开启排他接管锁，外包客服输入框已自动只读防撞车。',
    });
    showToast('🔒 已由陈小满排他接管（切回外包视角可验证防撞车输入锁）');
  } else if (actionType === 'internal_coach_note') {
    const note = (payload.note || '').trim();
    if (!note) {
      showToast('请输入给外包客服的幕后回复锦囊');
      return;
    }
    conv.internalNotes.push({
      id: 'inote-' + Date.now(),
      who: '陈小满（幕后锦囊）',
      time: nowHm(),
      text: note,
    });
    if (conv.collabTicket) conv.collabTicket.status = 'COACHED';
    showToast('💡 已向该会话外包客服发送幕后黄色锦囊（买家不可见）');
  } else if (actionType === 'internal_release') {
    const handoffNote = (payload.handoffNote || '').trim();
    const commitment = (payload.commitment || '').trim();
    if (!handoffNote) {
      showToast('⚠️ 交还外包前必须填写「交还说明」，防止外包接手抓瞎！');
      return;
    }
    conv.owner = { type: 'outsource', id: 'outsource_lu', name: '林小鹿' };
    if (commitment) {
      conv.commitments.push(commitment);
    }
    conv.internalNotes.push({
      id: 'rel-' + Date.now(),
      who: '陈小满（交还备注）',
      time: nowHm(),
      text: handoffNote,
    });
    if (conv.collabTicket) conv.collabTicket.status = 'DONE';
    conv.statusBadge = '✓ 内部已交还跟进';
    conv.messages.push({
      id: 'rel-sys-' + Date.now(),
      dir: 'sys',
      time: nowHm(),
      text: `🔓 陈小满已解除接管锁交还外包跟进（交还说明：${handoffNote}${
        commitment ? `；置顶承诺：${commitment}` : ''
      }）。`,
    });
    showToast('🔓 已附带承诺与备注安全交还外包客服');
  } else if (actionType === 'reject_invalid_escalation') {
    if (conv.collabTicket) conv.collabTicket.status = 'REJECTED';
    conv.statusBadge = '⚠️ 无效转接已退回';
    const ag = store.data.kpi.agents.find((a) => a.id === 'outsource_lu');
    if (ag) ag.invalidEscalations += 1;
    conv.internalNotes.push({
      id: 'rej-' + Date.now(),
      who: '陈小满（退回提醒）',
      time: nowHm(),
      text: '该问题右侧实拍卡已有明确成色与一口价说明，属于外包常规解答范围，已记无效甩锅退回 1 次。',
    });
    showToast('⚠️ 已退回无效甩锅并记入反作弊考核台账');
  }

  await syncBackend('internal_collab', `协同处理 ${conv.id}: ${actionType}`);
}

// 兼容快捷问题单入口
export async function resolveIssueOrder(convId, action) {
  if (action === 'continue_ship') {
    await pushOrderToWmsWave(convId, 'manual_resume');
  } else if (action === 'rush_warehouse_video') {
    await handleInternalCollabAction(convId, 'sim_warehouse_upload_video');
  } else if (action === 'bind_sales_link') {
    await handleInternalCollabAction(convId, 'sim_sales_bind_link');
  } else if (action === 'transfer_internal') {
    await createCollabEscalation(convId, 'bargain_sales', '买家疑难诉求申请内部专员介入');
  }
}

// 11. 新增自定义「场景自动发图」规则
export async function addCustomAutoRule({ sceneName, triggerDesc, accompanyText, imageUrl }) {
  store.data.autoRules.push({
    id: 'rule_' + Date.now(),
    enabled: true,
    sceneName,
    triggerDesc,
    replyKeyword: '',
    accompanyText,
    imageUrl,
    cardType: 'custom',
  });
  await syncBackend('add_auto_rule', `新增场景自动发图规则：${sceneName}`);
  showToast(`✓ 已新增自动发图规则：${sceneName}`);
}

// 12. 导出月度外包结算 14 项全维考核 CSV
export function exportKpiCsv() {
  const headers = [
    '坐席姓名',
    '班组',
    '当前状态',
    '在岗时长(h)',
    '小休(min)',
    '今日接待UV',
    '总会话数',
    '人工真回会话',
    '仅50s机器人兜底(剔除)',
    '首响中位数(s)',
    '平均响应(s)',
    '3分钟人工回复率(%)',
    '30秒首响率(%)',
    '尾响闭环率(%)',
    '一件一拍执行率(%)',
    '保修激活单数',
    '询单转化率(%)',
    '无效甩锅退回(次)',
    '满意度(%)',
    '乱承诺售后倒扣(次)',
    '预估日绩效(元)',
  ];
  const rows = store.data.kpi.agents.map((a) => [
    a.name,
    a.group,
    a.onlineStatus,
    a.onlineHours,
    a.breakMinutes,
    a.todayUv,
    a.totalSessions,
    a.manualReplied,
    a.autoFallbackOnly,
    a.firstReplyMedianSec,
    a.avgReplySec,
    a.threeMinRate,
    a.thirtySecRate,
    a.tailCloseRate,
    a.realShotExecRate,
    a.warrantyActiveCount,
    a.inquiryConvRate,
    a.invalidEscalations,
    a.satisfactionRate,
    a.promiseRefundPenalty,
    a.estimatedDailyBonus,
  ]);

  const csvContent =
    '\uFEFF' +
    [headers, ...rows]
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `泛亚外包客服14项全维考核结算单_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  pushLocalAudit('export_csv', '导出外包团队 14 项全维考核 CSV 结算单');
  showToast('📥 已导出《外包客服14项全维考核结算单.csv》');
}
