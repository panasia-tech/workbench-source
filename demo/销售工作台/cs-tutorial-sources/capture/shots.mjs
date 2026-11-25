// Capture every real-GUI screenshot for the 7 External CS node remake videos (1440px wide, DPR=2 -> 2880px PNG).
//   CS_BASE=http://127.0.0.1:5391 node shots.mjs [ID-prefix ...]
import fs from 'node:fs';
import { launch, nav, snap, click, type, inject, settle, sleep, DPR } from './cdp.mjs';

const HERE = decodeURIComponent(new URL('.', import.meta.url).pathname);
const ASSETS = HERE + '../project/assets/';
const REG = HERE + '../project/lib/shots.js';
const DBG = HERE + 'raw/';
fs.mkdirSync(ASSETS, { recursive: true });
fs.mkdirSync(DBG, { recursive: true });

const DATE = '2026-11-25';
const CREDIT = `外部客服工作台 V3 本机演示 · 脱敏样例数据 · ${DATE} 实录`;

const S = [];
const add = (id, o) => S.push({ id, ...o });

const resetAll = [['api', 'POST', '/api/cs/reset'], ['clearStorage'], ['reload']];

// ---------------- CS-ONBOARD-01: 新人首日 3 关通关与三栏极简上岗 ----------------
add('OB-01', {
  route: '/cs-workbench', as: 'cs_newbie', pre: resetAll,
  focus: [
    ['新人3关角标', '3关待解锁(0/3)', 'button'],
    ['防呆锁提示条', '/首日新人防呆锁/', 'div,span,p'],
    ['立即去做3关练习解锁', '立即去做 3 关练习解锁', 'button'],
    ['右栏发实拍主钮(已锁)', '发实拍图/视频 + 自动发保修激活卡', 'button'],
    ['去做3关练习', '去做3关练习', 'button'],
    ['三分类页签', '售前 3', 'button', 0, '问题订单 3', 'button'],
    ['怎么用入口', '?', 'button', 0],
  ],
});
add('OB-02', {
  route: '/cs-workbench', as: 'cs_newbie',
  pre: [['click', '立即去做 3 关练习解锁', 'button'], ['click', '先口头答应买家', 'button']],
  focus: [
    ['演练沙盒标(假数据)', '/演练沙盒/', 'span,div'],
    ['第1关题目', '/第 1 关：买家问货/', 'h3'],
    ['错误反馈拦截框', '/踩大坑/', 'div,p'],
    ['正确选项B', '直接点右侧红卡主按钮', 'button'],
  ],
});
add('OB-03', {
  route: '/cs-workbench', as: 'cs_newbie',
  pre: [
    ['click', '立即去做 3 关练习解锁', 'button'],
    ['click', '直接点右侧红卡主按钮', 'button'],
    ['click', '进入下一关', 'button'],
    ['click', '选绿灯在库的 A 机', 'button'],
    ['click', '进入下一关', 'button'],
    ['click', '绝不留微信', 'button'],
  ],
  focus: [
    ['第3关红线题', '/第 3 关：买家猛砍价/', 'h3'],
    ['通关绿框反馈', '/恭喜 3 关全部通关/', 'div,p'],
    ['解锁真实接待台按钮', '3 关全通！解锁真实接待台', 'button'],
  ],
});
add('OB-04', {
  route: '/cs-workbench', as: 'cs_newbie',
  pre: [
    ...resetAll,
    ['click', '立即去做 3 关练习解锁', 'button'],
    ['click', '直接点右侧红卡主按钮', 'button'],
    ['click', '进入下一关', 'button'],
    ['click', '选绿灯在库的 A 机', 'button'],
    ['click', '进入下一关', 'button'],
    ['click', '绝不留微信', 'button'],
    ['click', '3 关全通！解锁真实接待台', 'button'],
  ],
  focus: [
    ['左栏收件箱三分类', '售前 3', 'button', 0, '问题订单 3', 'button'],
    ['林先生会话卡', '林先生8821', 'button'],
    ['中间聊天与快捷短语', '现货实拍说明', 'button', 0, '发送', 'button'],
    ['输入框已解锁', '输入回复内容', 'textarea'],
    ['右栏仓库实拍舱', '仓库实拍（一件一拍）', 'b,strong,h3,div', 0, 1],
  ],
});

// ---------------- CS-REALSHOT-01: 挑绿灯真机与一件一拍 ----------------
add('RS-01', {
  route: '/cs-workbench', as: 'outsource_lu', pre: [...resetAll, ['click', '林先生8821', 'button']],
  focus: [
    ['林先生待挑货会话', '林先生8821', 'button'],
    ['买家消息原话', '/把本机实拍照片和通电试风视频发我/', 'p,div'],
    ['右栏当前进度卡', '当前进度', 'b,strong,h3,div', 0, '发实拍图/视频 + 自动发保修激活卡', 'button'],
    ['发实拍图/视频主按钮', '发实拍图/视频 + 自动发保修激活卡', 'button'],
    ['绿灯可选95新', '95新 ¥1390', 'button'],
    ['缺视频已锁95新', '95新(阻塞)', 'button'],
    ['本机2张实拍图', '主机+5风嘴实拍', 'div,span,figcaption,button', 0, '1mm轻微收纳印微距', 'div,span,figcaption,button'],
    ['播放通电视频按钮', '播放仓管通电实拍视频', 'button'],
  ],
});
add('RS-02', {
  route: '/cs-workbench', as: 'outsource_lu',
  pre: [['click', '林先生8821', 'button'], ['click', '全检四关', 'button.fold-head'], ['see', '全检四关'], ['scrollRightBottom']],
  focus: [
    ['两张实拍缩略图', '主机+5风嘴实拍', 'div,span,figcaption,button', 0, '1mm轻微收纳印微距', 'div,span,figcaption,button'],
    ['播放仓管通电实拍视频', '播放仓管通电实拍视频', 'button'],
    ['全检四关与脱敏盾展开区', '全检四关 · 配件子母码 · 脱敏盾', 'button.fold-head', 0, 1],
  ],
});
add('RS-03', {
  route: '/cs-workbench', as: 'outsource_lu',
  pre: [...resetAll, ['click', '林先生8821', 'button'], ['click', '发实拍图/视频 + 自动发保修激活卡', 'button']],
  focus: [
    ['聊天窗发出的实拍与视频卡', '播放本机通电实拍视频', '.col-center button', 0, 1],
    ['跟发的保修激活确认卡', '/杭州市富阳区人民法院/', '.col-center .bubble-box', 0],
    ['右栏切到第2步等同意', '等回“同意”激活保修', '.col-right .step-pill', 0, '静默自动推仓倒计时', '.col-right div, .col-right span'],
  ],
});

// ---------------- CS-WARRANTY-02: 保修激活卡、富阳法院条款与提问暂停 ----------------
add('WA-01', {
  route: '/cs-workbench', as: 'outsource_lu',
  pre: [...resetAll, ['click', '自动发图', 'button']],
  focus: [
    ['规则1：自动发保修激活与管辖确认卡', '自动发保修激活与管辖确认卡', 'h3', 0, 1],
    ['关键词同意说明', '/自动识别买家回复关键词：「同意」/', 'div,p,span'],
    ['保修卡样图含富阳法院条款', '手动发到当前会话测试', 'button', 0],
    ['规则2：退款0秒UI引导图', '0秒自动发手机UI三步引导图', 'h3', 0, 1],
  ],
});
add('WA-02', {
  route: '/cs-workbench', as: 'outsource_lu',
  pre: [...resetAll, ['click', '陈工（等回“同意”）', 'button'], ['click', '演示测试模拟', 'button.fold-head']],
  focus: [
    ['陈工会话卡片', '陈工（等回“同意”）', '.col-left button'],
    ['聊天里的保修激活卡', '/杭州市富阳区人民法院/', '.col-center .bubble-box', 0],
    ['自动倒计时与步数2', '同意/静默', '.col-right .ds-node', 0, '静默自动推仓倒计时', '.col-right div, .col-right span'],
    ['模拟买家回同意按钮', '模拟买家回复“同意”', '.col-right button'],
    ['模拟买家提疑问按钮', '模拟买家发来疑问', '.col-right button'],
  ],
});
add('WA-03', {
  route: '/cs-workbench', as: 'outsource_lu',
  pre: [...resetAll, ['click', '陈工（等回“同意”）', 'button'], ['click', '演示测试模拟', 'button.fold-head'], ['click', '模拟买家回复“同意”', 'button']],
  focus: [
    ['聊天已收同意并激活保修卡', '/店铺质保服务已自动激活/', '.col-center .bubble-box'],
    ['右栏推仓成功状态', '/已推入仓库顺丰波次/', '.col-right div, .col-right p', 0],
  ],
});
add('WA-04', {
  route: '/cs-workbench', as: 'outsource_lu',
  pre: [...resetAll, ['click', '问题订单', 'button'], ['click', '阿杰_数码控', 'button']],
  focus: [
    ['疑问熔断已停发标签', '阿杰_数码控', '.col-left button'],
    ['买家提问原话', '/底座右边有道小划痕/', '.col-center .bubble-box'],
    ['毫秒暂停条', '/买家在发货前提出疑问/', '.col-center .sys-note'],
    ['绿色恢复推仓按钮', '疑问已解答 · 恢复推入仓库发货', '.col-right button'],
    ['换99新同款槽位', '99新(准新) ¥1060', '.col-right button'],
  ],
});

// ---------------- CS-REFUND-409-03: 退款三步引导与拣货中红屏急停 ----------------
add('RF-01', {
  route: '/cs-workbench', as: 'outsource_lu',
  pre: [...resetAll, ['click', '售后', 'button'], ['click', '王女士（退款申请）', 'button']],
  focus: [
    ['王女士退款会话', '王女士（退款申请）', '.col-left button'],
    ['系统0秒发出的3步手机UI图', '/亲，收到您的退款申请啦/', '.col-center .bubble-box'],
    ['右栏0秒退款UI指引卡', '0 秒退款 UI 指引', '.col-right span, .col-right b, .col-right div', 0, 1],
    ['引导改选不想要了快捷短语', '引导改“不想要了”秒退', '.col-center button'],
  ],
});
add('RF-02', {
  route: '/cs-workbench', as: 'outsource_lu',
  pre: [...resetAll, ['click', '售后', 'button'], ['click', '张同学（改址/退单）', 'button']],
  focus: [
    ['张同学拣货中会话', '张同学（改址/退单）', '.col-left button'],
    ['买家急着改拍先拦一下', '/你们仓库千万先拦一下别发走/', '.col-center .bubble-box'],
    ['拣货波次提醒', '/拣货波次-04/', '.col-right div, .col-right span, .col-right p'],
    ['拣货中急停拦单卡片', '拣货中急停拦单', '.col-right b, .col-right span, .col-right div', 0, 1],
    ['红屏急停拦截主按钮', '立即下发红屏急停拦截仓库面单', '.col-right button'],
  ],
});
add('RF-03', {
  route: '/cs-workbench', as: 'outsource_lu',
  pre: [...resetAll, ['click', '售后', 'button'], ['click', '张同学（改址/退单）', 'button'], ['click', '立即下发红屏急停拦截仓库面单', 'button']],
  focus: [
    ['聊天急停拦截回执', '/打包台扫该货号将三声报警/', '.col-center .sys-note, .col-center div'],
    ['右栏急停截单已生效', '急停截单已生效', '.col-right b, .col-right span, .col-right div', 0, 1],
    ['红屏锁单波次状态', '/打包台已红屏急停锁单/', '.col-right p, .col-right div'],
  ],
});

// ---------------- CS-GUARD-KPI-04: 外发守卫防引流与五防绩效考核 ----------------
add('GD-01', {
  route: '/cs-workbench', as: 'outsource_lu',
  pre: [...resetAll, ['click', 'momo_小仓鼠', 'button']],
  focus: [
    ['顶部5个绩效数与全维考核按钮', '接待', 'header span, header div, header b', 0, '全维考核', 'header button'],
    ['momo_小仓鼠待人工真回', 'momo_小仓鼠', '.col-left button'],
    ['机器人50s兜底提示标', '自动兜底（不算人工已回）', '.col-center span, .col-center div'],
    ['5个合规快捷短语', '现货实拍说明', '.col-center button', 0, '防站外引流标准婉拒', '.col-center button'],
  ],
});
add('GD-02', {
  route: '/cs-workbench', as: 'outsource_lu',
  pre: [...resetAll, ['click', 'momo_小仓鼠', 'button'], ['type', '输入回复内容', '加我微信 13800138000 私下转']],
  focus: [
    ['违规微信输入栏', '输入回复内容', '.col-center textarea'],
    ['发送按钮实时锁灰', '/^发送$/', '.col-center button'],
    ['外发合规红框拦截理由', '/外发守卫实时拦截/', '.col-center div', 0, 1],
    ['防站外引流标准婉拒短语', '防站外引流标准婉拒', '.col-center button'],
  ],
});
add('GD-03', {
  route: '/cs-workbench', as: 'admin',
  pre: [...resetAll, ['click', '全维考核', 'button']],
  focus: [
    ['顶部5张核心考核卡', '今日接待人数', 'span,div', 0, '尾响闭环率 / 满意度', 'span,div'],
    ['全团14项指标对比表(含预警样本)', '全团坐席 14 项硬核指标对比表', 'b,span,button.fold-head', 0, 2],
    ['王阿强预警红字', '王阿强（预警样本）', 'tr', 0],
    ['导出结算表格按钮', '导出结算表格', 'button'],
  ],
});
add('GD-04', {
  route: '/cs-workbench', as: 'outsource_lu',
  pre: [...resetAll, ['click', '全维考核', 'button'], ['see', '反作弊预警雷达']],
  focus: [
    ['今日反作弊实时拦截与预警', '今日反作弊实时拦截与预警', 'h4', 0, 1],
    ['机器人兜底漏回与刷单字拦截提示', '/机器人兜底挂机漏回/', 'b,div,p', 0, 1],
    ['外发守卫刷“1”与微信号拦截日志', '/外发守卫今日自动拦阻/', 'b,div,p', 0, 1],
  ],
});

// ---------------- CS-ESCALATE-05: 问题订单缺视频/未绑货号一键呼救 ----------------
add('ES-01', {
  route: '/cs-workbench', as: 'outsource_lu',
  pre: [...resetAll, ['click', '问题订单', 'button'], ['click', '设备迷老周', 'button']],
  focus: [
    ['问题订单·缺通电视频单', '设备迷老周', '.col-left button'],
    ['一键催仓管60秒补拍按钮', '一键催仓管 60 秒补拍通电视频', '.col-right button'],
    ['右边缺视频阻塞提示', '/仓管尚未上传高拍仪通电实拍视频/', '.col-right div, .col-right p', 0],
  ],
});
add('ES-02', {
  route: '/cs-workbench', as: 'outsource_lu',
  pre: [...resetAll, ['click', '问题订单', 'button'], ['click', '设计小李（链接异常）', 'button']],
  focus: [
    ['链接未绑仓库货号会话', '设计小李（链接异常）', '.col-left button'],
    ['聊天危险外部网盘红牌拦截', '/外部风险链接/', '.col-center div, .col-center span, .col-center p', 0, 1],
    ['一键呼叫内部销售绑定货号', '一键呼叫内部销售 60s 绑定仓库货号', '.col-right button'],
    ['右栏待绑货号禁答提示', '/商品链接尚未绑定仓库货号/', '.col-right div, .col-right p', 0],
  ],
});
add('ES-03', {
  route: '/cs-workbench', as: 'outsource_lu',
  pre: [...resetAll, ['click', '问题订单', 'button'], ['click', '设计小李（链接异常）', 'button'], ['click', '一键呼叫内部销售 60s 绑定仓库货号', 'button'], ['click', '跨部门协同', 'button.fold-head'], ['scrollRightBottom']],
  focus: [
    ['工单已发出协同卡片', 'PENDING', '.col-right .ticket-banner', 0],
    ['四个一键呼救按钮', '催仓管拍视频', '.col-right button', 0, '疑难售后升级', '.col-right button'],
  ],
});

// ---------------- CS-TAKEOVER-06: 大额砍价转销售、排他锁与交还 ----------------
add('TK-01', {
  route: '/cs-workbench', as: 'outsource_lu',
  pre: [...resetAll, ['click', 'momo_小仓鼠', 'button'], ['click', '跨部门协同', 'button.fold-head'], ['see', '卖家主动关闭买家订单']],
  focus: [
    ['砍价转销售按钮', '砍价转销售', '.col-right button'],
    ['疑难售后升级按钮', '疑难售后升级', '.col-right button'],
    ['永久禁用卖家关闭订单锁', '卖家主动关闭买家订单（永久禁用）', '.col-right button, .col-right div'],
  ],
});
add('TK-02', {
  route: '/cs-workbench', as: 'chenxm',
  pre: [...resetAll, ['click', 'momo_小仓鼠', 'button'], ['click', '跨部门协同', 'button.fold-head'], ['scrollRightBottom']],
  focus: [
    ['内部销售陈小满协同台标题', '内部销售【陈小满】协同台', '.col-right .ic-head', 0],
    ['我来排他接管按钮', '我来排他接管（锁外包输入）', '.col-right button'],
    ['退回无效甩锅按钮', '退回无效甩锅（记反作弊）', '.col-right button'],
    ['幕后回复锦囊输入框与发送钮', '不接管直接写幕后回复锦囊', '.col-right input', 0, '发幕后锦囊', '.col-right button'],
  ],
});
add('TK-03', {
  route: '/cs-workbench', as: 'chenxm',
  pre: [
    ...resetAll,
    ['click', 'momo_小仓鼠', 'button'],
    ['click', '跨部门协同', 'button.fold-head'],
    ['click', '我来排他接管（锁外包输入）', 'button'],
    ['type', '不接管直接写幕后回复锦囊', '最低让20包邮，可附全新1.8m DP线'],
    ['click', '发幕后锦囊', 'button'],
    ['scrollRightBottom'],
  ],
  focus: [
    ['幕后回复锦囊黄条', '/最低让20包邮/', '.col-center .pinned-bar', 0],
    ['必填交还备注框与交还按钮', '交还外包跟进备注', '.col-right input', 0, '填妥备注并交还外包继续跟进', '.col-right button'],
  ],
});
add('TK-04', {
  route: '/cs-workbench', as: 'outsource_lu',
  // Keep chenxm's takeover state in localStorage!
  pre: [['click', 'momo_小仓鼠', 'button']],
  focus: [
    ['聊天黄底内部销售锦囊条', '/陈小满（幕后锦囊）/', '.col-center .pinned-bar', 0],
    ['外包输入框已排他锁定', '/当前输入已锁定/', '.col-center div', 0, '排他接管中，等待交还后再回复', '.col-center textarea'],
  ],
});

// ======================================================================
const only = process.argv.slice(2);
const todo = only.length ? S.filter((s) => only.some((p) => s.id.startsWith(p))) : S;
const old = fs.existsSync(REG) ? JSON.parse(fs.readFileSync(REG, 'utf8').replace(/^[^{]*/, '').replace(/;\s*$/, '')) : {};
const reg = { ...old };
let browser = null;
let curH = 0;

const api = (cdp, m, p) =>
  cdp.eval(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)} }).then(r => r.status)`);

for (const s of todo) {
  const h = s.h || 900;
  if (!browser || h !== curH) {
    if (browser) await browser.close();
    browser = await launch({ w: 1440, h });
    curH = h;
  }
  const { cdp } = browser;
  await nav(cdp, s.route, s.as || 'outsource_lu');
  for (const a of s.pre || []) {
    if (a[0] === 'api') console.log('  api', a[2], await api(cdp, a[1], a[2]));
    else if (a[0] === 'clearStorage') await cdp.eval('localStorage.clear(); 1');
    else if (a[0] === 'reload') await nav(cdp, s.route, s.as || 'outsource_lu');
    else if (a[0] === 'click') await click(cdp, a[1], a[2], a[3] || 0);
    else if (a[0] === 'type') await type(cdp, a[1], a[2]);
    else if (a[0] === 'scrollRightBottom') {
      await cdp.eval(`(() => { const r = document.querySelector('.col-right'); if (r) r.scrollTop = r.scrollHeight; return 1; })()`);
      await settle(cdp, 300);
    } else if (a[0] === 'see') {
      await inject(cdp);
      await cdp.eval(`window.__find(${JSON.stringify(a[1])})?.scrollIntoView({block:'center'}); 1`);
      await settle(cdp, 400);
    }
  }
  await sleep(300);
  await cdp.eval(`document.querySelectorAll('.toast,[class*="toast"]').forEach(e => { e.style.display = 'none'; }); 1`);
  const file = `${s.id}.png`;
  await snap(cdp, ASSETS + file);
  await inject(cdp);
  const boxes = [];
  const labels = [];
  for (const [lab, q, sel, nth = 0, up = 0, toSel] of s.focus) {
    const r = typeof up === 'string'
      ? await cdp.eval(`(() => { const a = window.__find(${JSON.stringify(q)}, ${sel ? JSON.stringify(sel) : 'undefined'}, ${nth}), b = window.__find(${JSON.stringify(up)}, ${toSel ? JSON.stringify(toSel) : 'undefined'}); if (!a || !b) return null; const A = a.getBoundingClientRect(), B = b.getBoundingClientRect(); const x0 = Math.min(A.left, B.left), y0 = Math.min(A.top, B.top), x1 = Math.max(A.right, B.right), y1 = Math.max(A.bottom, B.bottom); return [x0, y0, x1 - x0, y1 - y0].map(Math.round); })()`)
      : await cdp.eval(`(() => { let e = window.__find(${JSON.stringify(q)}, ${sel ? JSON.stringify(sel) : 'undefined'}, ${nth}); if (!e) return null; for (let i = 0; i < ${up} && e.parentElement; i++) e = e.parentElement; return window.__rect(e); })()`);
    if (!r) {
      console.log(`  !! ${s.id} focus not found: ${lab} (${q})`);
      boxes.push([0, 0, 2, 2]);
      labels.push('（未找到）' + lab);
      continue;
    }
    boxes.push(r.map((v) => Math.round(v * DPR)));
    labels.push(lab);
  }
  await cdp.eval(`(() => { const L = ${JSON.stringify(boxes)}, N = ${JSON.stringify(labels)}; L.forEach((b, i) => { const d = document.createElement('div'); d.className = '__dbg'; d.style.cssText = 'position:fixed;z-index:99999;border:2px solid red;pointer-events:none;left:' + b[0] / ${DPR} + 'px;top:' + b[1] / ${DPR} + 'px;width:' + b[2] / ${DPR} + 'px;height:' + b[3] / ${DPR} + 'px'; d.innerHTML = '<b style="background:red;color:#fff;font:11px sans-serif;position:absolute;left:0;top:-14px;white-space:nowrap">' + i + ' ' + N[i] + '</b>'; document.body.appendChild(d); }); return 1; })()`);
  await snap(cdp, DBG + `dbg_${s.id}.png`);
  await cdp.eval(`document.querySelectorAll('.__dbg').forEach(e => e.remove()); 1`);
  reg[s.id] = {
    file,
    kind: 'web',
    w: 1440 * DPR,
    h: h * DPR,
    focus: boxes,
    flabels: labels,
    masks: [],
    url: `127.0.0.1:5341/?as=${s.as || 'outsource_lu'}#${s.route}`,
    title: '外部客服工作台 V3',
    credit: CREDIT,
    date: DATE,
  };
  console.log(`${s.id}  ${labels.length} boxes`);
}
if (browser) await browser.close();
fs.writeFileSync(
  REG,
  `// GENERATED by capture/shots.mjs from the live external CS workbench. Do not edit by hand.\nexport const SHOTS = ${JSON.stringify(reg, null, 0)};\n`,
);
console.log('registry', Object.keys(reg).length, 'shots');
