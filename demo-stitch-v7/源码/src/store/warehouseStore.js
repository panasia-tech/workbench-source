import { reactive, computed } from 'vue'
import { ACCOUNTS, STANDARD_TEMPLATES, HELP_DICT, GLOSSARY, TOURS, createInitialState } from '../data/seed.js'
import { makeRealPhoto, makeLocationPhoto, makeDefectPhoto, makeUnboxFrame } from '../data/mediaSvg.js'
import { triggerScanFeedback } from '../utils/scannerAudio.js'

const STORAGE_KEY = 'panasia_wh_stitch_v7_20261118'

export const LV = {
  red: { icon: '✕', text: '要处理' },
  amb: { icon: '!', text: '注意' },
  grn: { icon: '✓', text: '正常' }
}

export function ageOf(days) {
  const d = Number(days || 0)
  const cyc = Math.min(4, Math.floor(d / 7) + 1)
  if (d >= 28) return { lvl: 'red', short: `${d}天 · 滞销`, long: `满 28 天滞销预警（在库 ${d} 天）`, cyc: 4 }
  if (d >= 15) return { lvl: 'amb', short: `${d}天 · 第${cyc}周期`, long: `第 ${cyc} 周期（${d} 天，该清仓）`, cyc }
  return { lvl: 'grn', short: `${d}天 · 第${cyc}周期`, long: `第 ${cyc} 周期（${d} 天，正常在售期）`, cyc }
}

function loadInitial() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && parsed.version === 'wh-stitch-20261118-v7') return parsed
    }
  } catch (_) {}
  return createInitialState()
}

export const store = reactive({
  route: 'today',
  routeParam: '',
  lastGalleryHash: '#/gallery/all',
  galleryFilter: { q: '', flt: 'all', by: 'status' },
  currentUserId: new URLSearchParams(location.search).get('as') || 'linqg',
  fontBig: localStorage.getItem('wh_font_big') !== '0',
  backendOnline: false,
  backendMode: 'local-sqlite',
  helpKey: '',
  practiceKey: '',
  videoModal: null,
  tour: null,
  finderOpen: false,
  pdaOpen: false,
  laserBarOpen: false,
  toast: null,
  data: loadInitial()
})

export function setFontBig(big) {
  store.fontBig = !!big
  localStorage.setItem('wh_font_big', big ? '1' : '0')
  document.documentElement.classList.toggle('font-big', !!big)
}

export function openHelp(key) {
  store.helpKey = HELP_DICT[key] ? key : 'today'
}

export function openPractice(caseKey) {
  store.practiceKey = caseKey
}

let toastTimer = null
export function notify(msg, type = 'info') {
  store.toast = { msg, type }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { store.toast = null }, 3400)
}

function persist(action = 'sync') {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store.data))
  } catch (_) {}
  fetch('/api/wh/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Actor': store.currentUserId },
    body: JSON.stringify({ action, actor: store.currentUserId, data: store.data })
  }).then(r => {
    if (r.ok) store.backendOnline = true
  }).catch(() => {})
}

export async function bootstrapBackend() {
  setFontBig(store.fontBig)
  try {
    const res = await fetch('/api/wh/state')
    if (res.ok) {
      const payload = await res.json()
      store.backendOnline = true
      if (payload && payload.data && payload.data.version === 'wh-stitch-20261118-v7') {
        store.data = payload.data
        localStorage.setItem(STORAGE_KEY, JSON.stringify(store.data))
      } else {
        persist('init')
      }
    }
  } catch (_) {
    store.backendOnline = false
  }
}

// 1秒倒计时引擎：驱动10分钟实物异常首报 + 60秒协同 + 快递批次10×N分钟拒签死线 + 10分钟站点紧急召回死线
setInterval(() => {
  for (const a of store.data.anomalies) {
    if (a.remainingSec > 0 && !a.tracks.purchaserProof.done) {
      a.remainingSec -= 1
      if (a.remainingSec === 0) {
        a.tracks.purchaserProof.escalated = true
      }
    }
  }
  const cc = store.data.courierCoord
  if (cc) {
    for (const b of cc.batches || []) {
      if (b.status === 'IN_PROGRESS' && b.remainingSec > 0) b.remainingSec -= 1
    }
    for (const r of cc.urgentRecalls || []) {
      if (r.status !== 'RECALLED_SAFE' && r.remainingSec > 0) r.remainingSec -= 1
    }
  }
  const c = store.data.collab
  if (c && c.state !== 'taken' && c.state !== 'escalated') {
    if (c.left > 0) {
      c.left -= 1
    } else if (c.state === 'open') {
      c.state = 'peer'
      c.left = 60
    } else if (c.state === 'peer') {
      c.state = 'escalated'
      c.left = 0
    }
  }
}, 1000)

export const currentUser = computed(() => {
  const acc = ACCOUNTS.find(a => a.id === store.currentUserId) || ACCOUNTS[0]
  const prog = store.data.practiceProgress[acc.id] || { case1: false, case2: false, case3: false }
  const steps = (store.data.practiceSteps && store.data.practiceSteps[acc.id]) || {
    case1: prog.case1 ? 3 : 0,
    case2: prog.case2 ? 3 : 0,
    case3: prog.case3 ? 3 : 0
  }
  const allDone = Boolean(prog.case1 && prog.case2 && prog.case3)
  return { ...acc, practiceDone: allDone, progress: prog, steps }
})

export const isBoss = computed(() => currentUser.value.role === 'BOSS')
export const isSupervisor = computed(() => currentUser.value.role === 'SUPERVISOR' || currentUser.value.role === 'BOSS')

// 售前四道放行关卡计算器（供「历史库存清洗 Gallery」与「库存实物画廊」共用真源）
export function skuPreSalesGates(sku) {
  if (!sku) return { gates: [], lvl: 'grn', redCount: 0, ambCount: 0 }
  const inspOk = sku.inspectComplete !== false && sku.zone !== '待修/送修中'
  const videoOk = sku.fullVideoReady !== false
  const realPhotoOk = (sku.realImgCount || 0) > 0
  const locPhotoOk = (sku.locImgCount || 0) > 0
  const spuOk = Boolean(sku.spuCode)
  const subCodeOk = sku.subCodesBound !== false
  const quarantined = sku.zone === '异常隔离（不可售）' || sku.zone === '待修/送修中'

  const gates = [
    {
      key: 'inspect',
      title: '① 爱回收式结构化全检',
      ok: inspOk && !quarantined,
      lvl: (!inspOk || quarantined) ? 'red' : 'grn',
      text: sku.zone === '待修/送修中'
        ? '外修取回尚未完成受影响功能复检（禁售）'
        : sku.zone === '异常隔离（不可售）'
          ? '处于异常隔离锁存，待主管核验4项防呆锁放行'
          : inspOk
            ? `已完成分步全检（${sku.conditionGrade || '成色已定'}）`
            : '老库存仅记型号，缺屏幕/接口/功能逐项分级结论'
    },
    {
      key: 'video',
      title: '② 完整通电/拆封实测视频',
      ok: videoOk,
      lvl: videoOk ? 'grn' : 'red',
      text: videoOk
        ? `完整实测原片可读（时长 ${sku.fullVideoDuration || '01:45'}）`
        : '缺完整通电实测视频，买家向客服索要亮屏视频时发不出'
    },
    {
      key: 'photo',
      title: '③ 本机实拍与库位图',
      ok: realPhotoOk && locPhotoOk,
      lvl: !realPhotoOk ? 'red' : !locPhotoOk ? 'amb' : 'grn',
      text: !realPhotoOk
        ? '0 张本机验货实拍图（严禁拿网图冒充，销售无法洗图上架）'
        : !locPhotoOk
          ? `本机实拍 ×${sku.realImgCount} 已齐 · 缺库位同框图`
          : `本机实拍 ×${sku.realImgCount} + 库位图 ×${sku.locImgCount} 已就位`
    },
    {
      key: 'spu_code',
      title: '④ 标准SPU · 库位 · 子母码',
      ok: spuOk && subCodeOk,
      lvl: !spuOk ? 'red' : !subCodeOk ? 'amb' : 'grn',
      text: !spuOk
        ? '尚未绑定标准 SPU 商品字典，通卖库存无法自动匹配'
        : !subCodeOk
          ? `已绑 ${sku.spuCode}（${sku.location}）· 附件袋/原盒未打 #BAG/#BOX 副码`
          : `${sku.spuCode} · 库位 ${sku.location}${sku.bagBin ? ' · 副码在 ' + sku.bagBin : ''}`
    }
  ]

  const redCount = gates.filter(g => g.lvl === 'red').length + (sku.ageDays >= 28 ? 1 : 0)
  const ambCount = gates.filter(g => g.lvl === 'amb').length + (sku.ageDays >= 15 && sku.ageDays < 28 ? 1 : 0)
  const lvl = redCount > 0 ? 'red' : ambCount > 0 ? 'amb' : 'grn'
  return { gates, lvl, redCount, ambCount }
}

// 单件库存统一红黄绿诊断引擎（与销售工作台 store.js 同构）
export function skuIssues(sku) {
  const list = []
  if (!sku) return list
  const outb = store.data.outbounds.find(o => o.skuCode === sku.code && o.status !== 'SHIPPED' && o.status !== 'RETURNED_TO_SHELF')
  if (sku.inspectComplete === false) {
    list.push({ lvl: 'red', text: '历史存量未完成爱回收式逐项全检，客服/销售无法披露成色开卖', go: 'flow-panel' })
  }
  if (sku.fullVideoReady === false) {
    list.push({ lvl: 'red', text: '缺完整通电/拆封可读实测视频，买家索要测机视频时客服拿不出', go: 'imgs' })
  }
  if (sku.realImgCount === 0) {
    list.push({ lvl: 'red', text: '缺本件验货实拍图（不拿同款商品图冒充），已自动派仓管现场补拍', go: 'imgs' })
  }
  if (!sku.spuCode) {
    list.push({ lvl: 'red', text: '尚未绑定标准 SPU 型号编码，多店抓单与通卖库存无法挂接', go: 'flow-panel' })
  }
  if (sku.zone === '异常隔离（不可售）') {
    list.push({ lvl: 'red', text: '处于异常隔离区：采购议价减 ¥260 改留货，等仓管主管核验 4 项防呆锁后放行', go: 'flow-panel' })
  }
  if (sku.zone === '待修/送修中') {
    list.push({ lvl: 'red', text: '外修已取回但尚未完成受影响功能复检，未复检严禁恢复可售', go: 'flow-panel' })
  }
  if (outb && (outb.status === 'BLOCKED_NEW_ISSUE' || outb.addressChanged)) {
    list.push({ lvl: 'red', text: '出库前复核发现新增微裂且买家申请改址，待暂停出库退回销售重核', go: 'flow-panel' })
  } else if (outb && outb.status === 'PENDING_SHIP') {
    list.push({ lvl: 'red', text: `已付款锁单（${outb.deadline}），待取附件袋与原盒扫码出库`, go: 'flow-panel' })
  }
  if (sku.ageDays >= 28) {
    list.push({ lvl: 'red', text: `滞销预警：在库 ${sku.ageDays} 天已满 4 个周期（28天红线），需复盘清仓`, go: 'age' })
  } else if (sku.ageDays >= 15) {
    list.push({ lvl: 'amb', text: `库龄 ${sku.ageDays} 天（进入第 3–4 清仓周期）`, go: 'age' })
  }
  if (sku.locImgCount === 0) {
    list.push({ lvl: 'amb', text: `库位 ${sku.location} 缺库位同框图，已自动派给林强国补拍`, go: 'imgs' })
  }
  const pkp = store.data.pickups.find(p => p.skuCode === sku.code && p.steps.some(s => !s.done))
  if (pkp) {
    list.push({ lvl: 'amb', text: `${pkp.appointment} 同城自提预约（取货码 ${pkp.pickupCode}），待接待区自验交接`, go: 'flow-panel' })
  }
  if (sku.hasLithiumBattery) {
    if (sku.sealBranch === 'SEALED_NEW' && (sku.daysSincePowerOn || 0) >= 30) {
      list.push({ lvl: 'amb', text: `全新原封机在库满 ${sku.daysSincePowerOn} 天：严禁拆封充电，请推销售优先调价快出`, go: 'age' })
    } else if (sku.sealBranch !== 'SEALED_NEW' && ((sku.daysSincePowerOn || 0) >= 30 || sku.powerOffVerified === false)) {
      list.push({
        lvl: 'red',
        text: `🔋 锂电池养护红灯：距上次通电已 ${sku.daysSincePowerOn || 0} 天${sku.powerOffVerified === false ? '且未确认彻底关机' : ''}（余电 ${sku.batteryPct ?? '?'}%），须立即补电至55%并彻底关机！`,
        go: 'flow-panel'
      })
    } else if (sku.sealBranch !== 'SEALED_NEW' && (sku.daysSincePowerOn || 0) >= 25) {
      list.push({ lvl: 'amb', text: `🔋 锂电临期提醒：距上次通电 ${sku.daysSincePowerOn} 天（剩 ${30 - sku.daysSincePowerOn} 天满30天红线）`, go: 'age' })
    }
  }
  return list
}

export function skuLevel(sku) {
  const iss = skuIssues(sku)
  if (iss.some(i => i.lvl === 'red')) return 'red'
  if (iss.some(i => i.lvl === 'amb')) return 'amb'
  return 'grn'
}

export function go(route, param = '') {
  if (route === 'inventory') route = 'gallery'
  if (route === 'gallery' && !param) param = 'all'
  store.route = route
  store.routeParam = param
  store.finderOpen = false
  location.hash = param ? `#/${route}/${encodeURIComponent(param)}` : `#/${route}`
}

export function openItemDetail(code) {
  store.lastGalleryHash = location.hash || '#/gallery/all'
  go('item', code)
}

export function switchAccount(id) {
  if (!ACCOUNTS.some(a => a.id === id)) return
  store.currentUserId = id
  try {
    const url = new URL(location.href)
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      url.searchParams.set('as', id)
      history.replaceState(null, '', url.toString())
    }
  } catch (_) {}
  const u = ACCOUNTS.find(a => a.id === id)
  if (id === 'boss') go('boss')
  else if (id === 'admin' && (store.route === 'today' || store.route === 'boss')) go('supervisor')
  else if (id !== 'boss' && id !== 'admin' && (store.route === 'boss' || store.route === 'supervisor')) go('today')
  notify(`已切换视角：${u.name} · ${u.roleLabel}`, 'ok')
}

export function assertRealAllowed() {
  if (!currentUser.value.practiceDone) {
    notify('防呆门禁拦截：新同事尚未完成 3 项实操通关演练，真实库存与工单禁止写入！', 'err')
    return false
  }
  return true
}

export function resetDemoData() {
  store.data = createInitialState()
  persist('reset')
  notify('已恢复全套标准演示工单与库存初始状态', 'ok')
}

// ============ 1. 今日任务 7 态流转与主管派工/改派/验收 (TSK #72) ============
export function acceptTask(taskId) {
  if (!assertRealAllowed()) return
  const t = store.data.tasks.find(x => x.id === taskId)
  if (!t) return
  if (t.assignee !== currentUser.value.id && !isSupervisor.value) {
    return notify(`权限拦截：该工单当前归属「${t.assigneeName}」，请先由主管改派交接后再操作`, 'err')
  }
  t.status = '执行中'
  persist('accept_task')
  notify(`已接收工单 ${t.id}，状态流转为「执行中」`, 'ok')
}

export function markTaskBlocked(taskId, reason) {
  if (!assertRealAllowed()) return
  const t = store.data.tasks.find(x => x.id === taskId)
  if (!t) return
  if (!reason || !reason.trim()) return notify('请填写具体卡点与需要的协助内容', 'err')
  t.status = '受阻'
  t.summary = `【受阻升级主管】${reason.trim()}（原说明：${t.summary}）`
  t.urgency = 'red'
  persist('block_task')
  notify('已标记受阻并推送仓管主管周卫东接管', 'ok')
}

export function submitTaskForReview(taskId, evidence) {
  if (!assertRealAllowed()) return
  const t = store.data.tasks.find(x => x.id === taskId)
  if (!t) return
  if (t.assignee !== currentUser.value.id && !isSupervisor.value) {
    return notify(`原经办已失权或非本人任务：仅当前负责人「${t.assigneeName}」可提交验收`, 'err')
  }
  if (!evidence || !evidence.trim()) {
    return notify('防呆拦截：提交验收必须填写可查证的录像/照片/单据回执编号！', 'err')
  }
  t.evidence = evidence.trim()
  t.status = '待验收'
  persist('submit_task')
  notify(`工单 ${t.id} 已附凭证提交，等待仓管主管验收`, 'ok')
}

export function reviewTaskBySupervisor(taskId, pass, feedback = '') {
  if (!isSupervisor.value) {
    return notify('角色门禁拦截：只有「仓管主管」可执行工单验收或退回！', 'err')
  }
  const t = store.data.tasks.find(x => x.id === taskId)
  if (!t) return
  if (!pass && !feedback.trim()) {
    return notify('退回补正必须写明具体缺失项与补救要求', 'err')
  }
  t.status = pass ? '已验收' : '退回补正'
  if (feedback.trim()) t.summary = `【主管${pass ? '验收备注' : '退回原因'}】${feedback.trim()}`
  persist('review_task')
  notify(pass ? `工单 ${t.id} 已验收闭环` : `工单 ${t.id} 已退回经办人补正`, 'ok')
}

export function reassignTaskBySupervisor(taskId, { toId, donePart, todoPart, nextStep }) {
  if (!isSupervisor.value) {
    return notify('角色门禁拦截：只有「仓管主管」可执行任务改派！', 'err')
  }
  if (!donePart?.trim() || !todoPart?.trim() || !nextStep?.trim()) {
    return notify('改派防呆拦截：必须完整填写「已完成内容、未完成内容、下一步动作」三要素！', 'err')
  }
  const targetAcc = ACCOUNTS.find(a => a.id === toId)
  const t = store.data.tasks.find(x => x.id === taskId)
  if (!t || !targetAcc) return
  const prevName = t.assigneeName
  t.handoffHistory.push({
    at: new Date().toTimeString().slice(0, 8),
    from: prevName,
    to: targetAcc.name,
    donePart: donePart.trim(),
    todoPart: todoPart.trim(),
    nextStep: nextStep.trim()
  })
  t.assignee = targetAcc.id
  t.assigneeName = targetAcc.name
  t.status = '待接收'
  persist('reassign_task')
  notify(`已从 ${prevName}（原负责人自动失权）改派给 ${targetAcc.name}`, 'ok')
}

export function createSupervisorTask({ title, skuCode, assigneeId, deadline, scope }) {
  if (!isSupervisor.value) {
    return notify('角色门禁拦截：仅仓管主管可加派工单！', 'err')
  }
  if (!title?.trim() || !deadline?.trim() || !scope?.trim()) {
    return notify('加派校验：任务标题、交付时限、交付范围与标准均不能为空！', 'err')
  }
  const acc = ACCOUNTS.find(a => a.id === assigneeId) || ACCOUNTS[0]
  const id = 'TSK-' + (910 + store.data.tasks.length)
  store.data.tasks.unshift({
    id,
    urgency: 'red',
    category: '主管加派工单',
    title: title.trim(),
    skuCode: skuCode?.trim() || '仓内综合',
    refNo: 'SUP-' + Date.now().toString().slice(-4),
    assignee: acc.id,
    assigneeName: acc.name,
    status: '待接收',
    deadline: deadline.trim(),
    summary: `交付范围与合格标准：${scope.trim()}`,
    route: 'inventory',
    targetId: skuCode?.trim() || '',
    evidence: '',
    handoffHistory: []
  })
  persist('create_task')
  notify(`已加派工单 ${id} 给 ${acc.name}`, 'ok')
}

// ============ 2. 收货开箱与全检闭环 (WH01, WH03, WH04, WH05, G03) ============
export function startUnboxRecording(insp) {
  if (!assertRealAllowed()) return
  insp.cameraChecked = true
  insp.recordingStarted = true
  insp.recordingStartedAt = new Date().toTimeString().slice(0, 8)
  insp.unboxPreview = makeUnboxFrame({
    code: insp.skuCode,
    waybill: insp.waybill,
    recording: true,
    stage: `● REC 已于 ${insp.recordingStartedAt} 拆封前起录 · 镜头对焦与空间正常`
  })
  persist('start_rec')
  notify('高拍仪已开始拆封前连续录制，现在可以拆封并逐项全检', 'ok')
}

export function logRecordingInterrupt(insp, gapNote) {
  if (!assertRealAllowed()) return
  if (!gapNote?.trim()) return notify('请如实填写录像中断缺失时间段与补拍说明', 'err')
  insp.interruptGap = gapNote.trim()
  insp.needsSupervisorReview = true
  persist('rec_interrupt')
  notify('已如实登记录像缺失区间并保留原片，自动标记「需仓管主管复核」', 'ok')
}

export function finishAndVerifyRecording(insp) {
  if (!assertRealAllowed()) return
  if (!insp.recordingStarted) return notify('尚未开启拆封录制！', 'err')
  insp.recordingFinished = true
  insp.playbackVerified = true
  persist('verify_rec')
  notify('已结束录制并完成原片回放可读性校验（防伪报上传成功）', 'ok')
}

export function captureInspectionPhoto(insp, slot) {
  if (!assertRealAllowed()) return
  if (!insp.recordingStarted) return notify('防呆拦截：必须先开启拆封前录像，再拍摄实物与瑕疵照片！', 'err')
  if (slot === 'real') {
    insp.realPhotos.push(makeRealPhoto({
      kind: insp.kind,
      code: insp.skuCode,
      model: insp.model,
      badge: `本件实拍 #${insp.realPhotos.length + 1}`
    }))
    notify('已拍摄并归入本件实拍图槽位', 'ok')
  } else if (slot === 'defect') {
    insp.defectPhotos.push(makeDefectPhoto({
      title: '现场新增微距瑕疵证据',
      ts: '00:02:18',
      code: insp.skuCode,
      detail: '已同步关联采购议价与销售披露凭证池'
    }))
    notify('已拍摄瑕疵微距照并绑定录像时间戳', 'ok')
  } else if (slot === 'location') {
    insp.locationPhotos.push(makeLocationPhoto({
      loc: insp.locationCode || '待定库位',
      code: insp.skuCode,
      bag: insp.bagCode
    }))
    notify('已拍摄库位与编号附件袋同框照', 'ok')
  }
  persist('capture_photo')
}

export function submitFullInspection(insp) {
  if (!assertRealAllowed()) return false
  if (!insp.recordingStarted || !insp.playbackVerified) {
    notify('硬防呆拦截（WH04）：拆封录像尚未完成「结束录制并回放确认可读」，禁止提交验货！', 'err')
    return false
  }
  const tpl = STANDARD_TEMPLATES.find(s => s.id === insp.standardId)
  const items = tpl ? tpl.items : []
  const unsetItems = items.filter(it => !insp.results[it.code] || insp.results[it.code].status === 'UNSET')
  if (unsetItems.length > 0) {
    notify(`坏货全检防呆拦截（WH03）：还有 ${unsetItems.length} 项未检测（含 ${unsetItems[0].code} ${unsetItems[0].name}）！严禁留空默认通过或因局部损坏省掉其余测试。`, 'err')
    return false
  }
  let hasFail = false
  let hasUnable = false
  for (const it of items) {
    const r = insp.results[it.code]
    if (r.status === 'FAIL') hasFail = true
    if (r.status === 'UNABLE') {
      hasUnable = true
      if (!r.unableReason?.trim() || !r.unableOwner?.trim()) {
        notify(`防呆拦截（WH03-07）：检测项 ${it.code} 选「当前无法测试」时，必须填写无法测试原因与补测责任人！`, 'err')
        return false
      }
    }
  }
  if (hasFail && insp.defectPhotos.length === 0) {
    notify('防呆拦截（WH05）：存在「异常」检测项时，必须至少拍摄 1 张瑕疵特写照片供采购议价/退货！', 'err')
    return false
  }
  if (insp.realPhotos.length === 0) {
    notify('防呆拦截：至少需上传 1 张本件实拍图！', 'err')
    return false
  }
  if (insp.kind === 'monitor' && !insp.bagCode?.trim()) {
    notify('显示器防呆拦截：必须填写专用编号附件袋号（如 BAG-A06-01）以绑定电源适配器与线材！', 'err')
    return false
  }
  if ((hasFail || hasUnable || insp.needsSupervisorReview) && insp.targetZone === '已复核可售') {
    notify('放行矩阵拦截（G03）：存在实测异常、未完成补测或录像中断待复核，严禁直接放入「已复核可售」库区！请选异常隔离/待议价/待补测。', 'err')
    return false
  }

  insp.submitted = true
  // 写入或更新 WMS 在库台账
  const existing = store.data.skus.find(s => s.code === insp.skuCode)
  const historyLine = `${new Date().toISOString().slice(5, 10)} 完成全量验货(${insp.standardVer})入库 ${insp.locationCode} · 状态：${insp.targetZone}`
  if (existing) {
    existing.zone = insp.targetZone
    existing.location = insp.locationCode
    existing.realImgCount = insp.realPhotos.length
    existing.locImgCount = insp.locationPhotos.length
    existing.defectImgCount = insp.defectPhotos.length
    existing.realThumb = insp.realPhotos[0] || ''
    existing.locThumb = insp.locationPhotos[0] || ''
    existing.history.unshift(historyLine)
  } else {
    store.data.skus.unshift({
      code: insp.skuCode,
      sn: 'SN-' + insp.skuCode.slice(-6),
      brand: insp.brand,
      model: insp.model,
      kind: insp.kind,
      zone: insp.targetZone,
      location: insp.locationCode || 'A-01',
      ageDays: 0,
      cost: insp.declaredPrice,
      purchaseOrder: insp.orderNo,
      inspectId: insp.id,
      bagCode: insp.bagCode || '标准随件',
      boxCode: insp.hasOriginalBox ? (insp.boxCode || 'BOX-' + insp.skuCode.slice(-4)) : '',
      boxStatus: insp.hasOriginalBox ? '在库已登记' : '无原盒',
      realImgCount: insp.realPhotos.length,
      locImgCount: insp.locationPhotos.length,
      defectImgCount: insp.defectPhotos.length,
      realThumb: insp.realPhotos[0] || '',
      locThumb: insp.locationPhotos[0] || '',
      defectNote: hasFail ? '实测存在差异，已同步异常与凭证池' : hasUnable ? '存在待补测项目，锁定不可售' : '全检通过',
      history: [historyLine]
    })
  }

  // 若检出实物异常，自动立项10分钟异常响应单
  if (hasFail && !store.data.anomalies.some(a => a.skuCode === insp.skuCode)) {
    store.data.anomalies.unshift({
      id: 'ANO-' + (2610 + store.data.anomalies.length),
      type: 'GOODS_DIFF',
      skuCode: insp.skuCode,
      orderNo: insp.orderNo,
      title: `${insp.brand} ${insp.model} · 实测异常与卖家描述不符`,
      purchaser: insp.purchaser,
      carrier: insp.waybill,
      targetStation: '原发件揽收网点',
      firstFoundAt: new Date().toISOString().slice(0, 10) + ' ' + new Date().toTimeString().slice(0, 8),
      remainingSec: 600,
      retryCount: 0,
      fullInspectDone: true,
      fullInspectProgress: '全部适用项已完成全检留证',
      isolationLocked: true,
      tracks: {
        courier: { sentAt: '刚刚', deliveredAt: '刚刚', acceptedAt: '', station: '原发件网点', receipt: '待快递员登记拒签', done: false },
        notifyPurchaser: { sentAt: '刚刚', deliveredAt: '刚刚', acceptedAt: '', diffSummary: '已附全检报告、瑕疵微距与开箱录像时间戳', done: true },
        purchaserProof: { submittedAt: '', voucher: '', verifiedReadable: false, escalated: false, assignee: insp.purchaser, done: false }
      },
      goodsSteps: [
        { key: 'full_inspect', label: '1. 全检完成待交回', done: true, note: '已完成全检' },
        { key: 'reject_accept', label: '2. 承运方拒签受理', done: false, note: '联系快递中' },
        { key: 'return_waybill', label: '3. 退回运单在途', done: false, note: '待揽收' },
        { key: 'station_arrive', label: '4. 到达原发件网点', done: false, note: '待在途更新' },
        { key: 'station_sign', label: '5. 网点签收回执', done: false, note: '未签收不算完结' }
      ],
      moneySteps: [
        { key: 'apply', label: '1. 采购首轮退款申请', done: false, note: '10分钟倒计时中' },
        { key: 'accept', label: '2. 卖家/平台受理', done: false, note: '' },
        { key: 'arrive', label: '3. 实际到账核销', done: false, note: `原采购款 ¥${insp.declaredPrice}` },
        { key: 'diff_audit', label: '4. 运费与差额对账', done: false, note: '' },
        { key: 'close', label: '5. 货钱双清结案', done: false, note: '' }
      ],
      keepGoodsSwitch: null
    })
  }

  persist('submit_inspection')
  notify(hasFail ? `全检已归档并分流入「${insp.targetZone}」，已自动启动10分钟异常三路响应！` : `全检归档完成，单件 #${insp.skuCode} 已分位入库（${insp.targetZone}）`, 'ok')
  return true
}

// ============ 3. 10分钟异常响应与货钱双轨闭环 (WH07, WH08, G03) ============
export function retryAnomalyNotify(ano) {
  if (!assertRealAllowed()) return
  if (ano.type === 'DEVICE_ONLY') {
    return notify('制度红线拦截：纯工位录像/设备异常不涉及卖家违约，严禁向采购发起退货退款！', 'err')
  }
  ano.retryCount += 1
  persist('retry_notify')
  notify(`已发送第 ${ano.retryCount} 次催办回执（严格保留首次发现时间 ${ano.firstFoundAt}，倒计时绝不重置！）`, 'ok')
}

export function uploadPurchaserFirstProof(ano, voucherText) {
  if (!assertRealAllowed()) return
  if (!voucherText?.trim()) return notify('请录入采购首轮申请退款或联系卖家的真实凭证编号/摘要', 'err')
  ano.tracks.purchaserProof.submittedAt = new Date().toTimeString().slice(0, 8)
  ano.tracks.purchaserProof.voucher = voucherText.trim()
  ano.tracks.purchaserProof.verifiedReadable = true
  ano.tracks.purchaserProof.done = true
  if (ano.moneySteps[0]) {
    ano.moneySteps[0].done = true
    ano.moneySteps[0].note = `已提交首轮凭证：${voucherText.trim()}`
  }
  persist('purchaser_proof')
  notify('首轮处理凭证已核验可读并归档，10分钟首轮响应达成！', 'ok')
}

export function markAnomalyFullInspectDone(ano) {
  if (!assertRealAllowed()) return
  ano.fullInspectDone = true
  ano.fullInspectProgress = '全部适用项已补齐实测留底，允许移交承运方退回'
  if (ano.goodsSteps[0]) {
    ano.goodsSteps[0].done = true
    ano.goodsSteps[0].note = '全检已完成，放行实物交回快递'
  }
  persist('ano_full_inspect')
  notify('已确认本件全检完成，现已解锁实物交回承运方节点', 'ok')
}

export function toggleAnomalyTrackStep(ano, rail, stepKey) {
  if (!assertRealAllowed()) return
  const list = rail === 'goods' ? ano.goodsSteps : ano.moneySteps
  const idx = list.findIndex(s => s.key === stepKey)
  if (idx < 0) return
  if (rail === 'goods' && stepKey !== 'full_inspect' && !ano.fullInspectDone) {
    return notify('防呆硬拦截（WH08-02）：全量验货完成前，禁止把异常实物提前交回快递退走！', 'err')
  }
  if (idx > 0 && !list[idx - 1].done) {
    return notify(`顺序防呆拦截：请先完成上一节点「${list[idx - 1].label}」并留存回执！`, 'err')
  }
  if (rail === 'money' && stepKey === 'close') {
    const goodsAllDone = ano.goodsSteps.every(s => s.done)
    const moneyPrevDone = ano.moneySteps.slice(0, -1).every(s => s.done)
    if (!goodsAllDone || !moneyPrevDone) {
      return notify('结案硬拦截（WH08-15）：必须「原发件网点已签收」且「退款实到账+运费差额核清」双轨全部完成后才允许结案！', 'err')
    }
  }
  list[idx].done = true
  persist('ano_step')
  notify(`已更新节点：${list[idx].label}`, 'ok')
}

export function approveKeepGoodsBySupervisor(ano) {
  if (!isSupervisor.value) {
    return notify('角色门禁拦截（WH08-14）：「议价改留货解除异常隔离」必须由仓管主管复核放行！请右上角切换周卫东体验。', 'err')
  }
  const sw = ano.keepGoodsSwitch
  if (!sw) return
  if (!sw.refundWithdrawn || !sw.goodsInWarehouse || !sw.costUpdated || !sw.disclosureSynced) {
    return notify('反悔防呆锁拦截：4项前置核验（撤回原退款、实物在仓、成本回写、披露同步销售）缺一不可！', 'err')
  }
  sw.supervisorApproved = true
  sw.approvedBy = `${currentUser.value.name} (${new Date().toTimeString().slice(0, 5)})`
  ano.isolationLocked = false
  const sku = store.data.skus.find(s => s.code === ano.skuCode)
  if (sku) {
    sku.zone = '已复核可售'
    sku.location = 'A-09'
    sku.defectNote = `议价留货已由主管放行（最新核定成本 ¥${sw.newCost}，原进价留痕，披露：${sw.disclosureText}）`
    sku.history.unshift(`${new Date().toISOString().slice(5, 10)} 主管周卫东核验4项防呆锁后解除隔离，转入 A-09 已复核可售`)
  }
  const t = store.data.tasks.find(x => x.targetId === ano.id)
  if (t) t.status = '已验收'
  persist('approve_keep_goods')
  notify(`已解除单件 #${ano.skuCode} 异常隔离并同步最新披露与成本至销售台！`, 'ok')
}

// ============ 4. 出库复核、自提与退回复验 (WH10, G09, G10) ============
export function verifyOutboundBarcode(ob, inputCode) {
  if (!assertRealAllowed()) return
  const clean = (inputCode || '').trim()
  ob.scannedCode = clean
  if (!clean) return notify('请输入或扫描实物机身货号/序列号', 'err')
  if (clean !== ob.skuCode && clean !== ob.sn) {
    ob.scanVerified = false
    persist('scan_fail')
    return notify(`严禁串件出库（F06/WH10）：当前扫描「${clean}」与订单锁定单件「${ob.skuCode}」不符，已硬锁出库按钮！`, 'err')
  }
  ob.scanVerified = true
  persist('scan_ok')
  notify(`单件条码核验一致（#${ob.skuCode}）`, 'ok')
}

export function pauseOutboundForIssue(ob, reason) {
  if (!assertRealAllowed()) return
  if (!reason?.trim()) return notify('请写明出库前新发现的问题或买家变更事项', 'err')
  ob.status = 'PAUSED_TO_SALES'
  ob.pausedReason = reason.trim()
  const sku = store.data.skus.find(s => s.code === ob.skuCode)
  if (sku) {
    sku.zone = '待补证/待补测'
    sku.history.unshift(`${new Date().toISOString().slice(5, 10)} 出库前复核拦截暂停：${reason.trim()}（已撤销旧出库资格退回销售）`)
  }
  persist('pause_outbound')
  notify('已暂停出库并撤销旧放行资格（G03-03），协同待办已推回销售经办！', 'ok')
}

export function confirmShipOutbound(ob) {
  if (!assertRealAllowed()) return
  if (ob.status === 'PAUSED_TO_SALES' || ob.addressChanged) {
    return notify('防呆拦截（G09/WH10）：该单存在新增瑕疵或买家改址待销售重核，严禁按旧资格强行发货！', 'err')
  }
  if (!ob.kitHostChecked || !ob.kitBagChecked || !ob.kitBoxChecked) {
    return notify('齐套防呆拦截：必须逐项勾选核实「主机本体 + 专用编号附件袋 + 约定包装盒」三件齐套！', 'err')
  }
  if (!ob.scanVerified) {
    return notify('防呆拦截：尚未完成实物扫码防串件校验！', 'err')
  }
  if (!ob.conditionRechecked || !ob.packVideoRecorded || !ob.packVideoReadable) {
    return notify('防呆拦截：必须完成当前品相比对、录制封箱视频并回放确认可读！', 'err')
  }
  if (!ob.waybillNo?.trim()) {
    return notify('请填写或扫描物流交接运单号！', 'err')
  }
  ob.status = 'SHIPPED'
  const sku = store.data.skus.find(s => s.code === ob.skuCode)
  const prevLoc = sku ? sku.location : ob.locationCode
  if (sku) {
    sku.zone = '已出库在途'
    sku.location = '已出库'
    sku.history.unshift(`${new Date().toISOString().slice(5, 10)} 齐套双复核扫码出库 · 运单 ${ob.waybillNo}`)
  }
  // 合单附带子单件同步出库扣减
  if (Array.isArray(ob.extraItems)) {
    for (const ex of ob.extraItems) {
      const exSku = store.data.skus.find(s => s.code === ex.skuCode)
      if (exSku) {
        exSku.zone = '已出库在途'
        exSku.location = '已出库'
        exSku.history.unshift(`${new Date().toISOString().slice(5, 10)} 随合单 ${ob.orderNo} 共包裹出库 · 运单 ${ob.waybillNo}`)
      }
      appendStockMovement({
        type: '波次复核出库',
        skuCode: ex.skuCode,
        model: ex.model || '同客合单子件',
        fromLoc: ex.locationCode || 'E区',
        toLoc: '快递揽收出库',
        qtyDelta: '-1 出库',
        refNo: `${ob.orderNo} / ${ob.waybillNo}`
      })
    }
  }
  // 扣减对应包材耗材
  if (ob.packMaterialCode && Array.isArray(store.data.packingMaterials)) {
    const pm = store.data.packingMaterials.find(p => p.code === ob.packMaterialCode)
    if (pm && pm.stock > 0) pm.stock -= 1
  }
  // 同步回写订单池状态与各子订单运单号
  if (Array.isArray(store.data.salesOrderPool)) {
    const subs = new Set([ob.orderNo, ...(ob.subOrderNos || [])])
    for (const ord of store.data.salesOrderPool) {
      if (subs.has(ord.externalOrderNo) || (ord.subOrderNos || []).some(n => subs.has(n))) {
        ord.waybillNo = ob.waybillNo
        if (ord.aggState !== 'MERGED_CHILD') {
          ord.aggState = 'SHIPPED_SYNC'
          ord.syncStatus = 'SYNCED_OK'
          ord.syncError = ''
        }
      }
    }
  }
  appendStockMovement({
    type: '波次复核出库',
    skuCode: ob.skuCode,
    model: ob.model,
    fromLoc: prevLoc,
    toLoc: '快递揽收出库',
    qtyDelta: '-1 出库',
    refNo: `${ob.orderNo} / ${ob.waybillNo}`
  })
  persist('ship_ok')
  notify(`订单 ${ob.orderNo} 已完成齐套与影像核验出库，包材已自动扣减，运单 ${ob.waybillNo} 已同步回写平台店铺！`, 'ok')
}

export function advancePickupStep(pkp, stepIdx) {
  if (!assertRealAllowed()) return
  if (stepIdx > 0 && !pkp.steps[stepIdx - 1].done) {
    return notify('请按自提接待五步顺序依次执行！', 'err')
  }
  pkp.steps[stepIdx].done = true
  pkp.currentStep = Math.min(pkp.steps.length, stepIdx + 2)
  persist('pickup_step')
  notify(`已完成自提节点：${pkp.steps[stepIdx].title}`, 'ok')
}

export function submitCustomerReturnRecheck(ret, { summary, targetZone, needUpstreamClaim }) {
  if (!assertRealAllowed()) return
  if (!summary?.trim() || summary.trim().length < 6) {
    return notify('防呆拦截（WH10-07）：退回商品必须录入本次独立复验实测结论，严禁留空或照抄原入库结论！', 'err')
  }
  ret.recheckDone = true
  ret.recheckSummary = summary.trim()
  ret.restockZone = targetZone
  ret.status = 'RECHECKED'
  ret.customerAftersaleState = `本次独立复验已归档（${summary.trim()}），已推销售售后办理客户退换结案`
  ret.upstreamClaimState = needUpstreamClaim
    ? '发现原采购隐藏暗病证据，已单独推送原采购员发起上游追偿单（与客户售后分开结案 G10）'
    : '核实原发货前完好，属售出期间损耗，不触发向原采购卖家退款（G10 独立结案）'
  const sku = store.data.skus.find(s => s.code === ret.skuCode)
  if (sku) {
    sku.zone = targetZone
    sku.history.unshift(`${new Date().toISOString().slice(5, 10)} 客户退回三代影像独立复验完成，转入「${targetZone}」`)
  } else {
    store.data.skus.unshift({
      code: ret.skuCode,
      sn: ret.sn,
      brand: '小米',
      model: ret.model,
      kind: 'audio',
      zone: targetZone,
      location: 'D-03-退回复验位',
      ageDays: 1,
      cost: 195,
      purchaseOrder: 'PO-20261028-09',
      inspectId: ret.id,
      bagCode: 'BAG-D03-01',
      boxCode: '',
      boxStatus: '退回无盒',
      realImgCount: 2,
      locImgCount: 1,
      defectImgCount: 1,
      realThumb: ret.generationPhotos.inboundOrig,
      locThumb: makeLocationPhoto({ loc: 'D-03', code: ret.skuCode, bag: 'BAG-D03-01' }),
      defectNote: `退回复验结论：${summary.trim()}`,
      history: [`11-14 客户退回三代影像复验入库（${targetZone}）`]
    })
  }
  persist('return_recheck')
  notify(`退回单 ${ret.returnNo} 三代影像独立复验已闭环，库存已按授权转入「${targetZone}」`, 'ok')
}

// ============ 5. 在库移位、送修修回复检、原盒独立出售、老系统转入库 ============
export function moveSkuLocation(sku, newLoc, reason) {
  if (!assertRealAllowed()) return
  if (!newLoc?.trim()) return notify('请输入新库位编码', 'err')
  const targetCode = newLoc.trim()
  const targetBin = (store.data.locations || []).find(l => l.code === targetCode)
  if (targetBin && !targetBin.enabled) {
    return notify(`库位防呆拦截：目标库位 ${targetCode} 当前处于「停用维护」状态，禁止移入！`, 'err')
  }
  if (targetBin && targetBin.binType === 'SALEABLE' && (sku.zone.includes('隔离') || sku.zone.includes('待修') || sku.zone.includes('待议价'))) {
    return notify(`库区属性防呆拦截：单件 #${sku.code} 当前处于「${sku.zone}」，严禁移入 A/B 可售货架！请选 D 区隔离锁柜。`, 'err')
  }
  const oldLoc = sku.location
  sku.location = targetCode
  sku.locThumb = makeLocationPhoto({ loc: sku.location, code: sku.code, bag: sku.bagCode })
  sku.locImgCount = Math.max(1, sku.locImgCount)
  sku.history.unshift(`${new Date().toISOString().slice(5, 10)} 库位移位：${oldLoc} → ${sku.location}（原因：${reason?.trim() || '仓内分位整理'} · 经办 ${currentUser.value.name}）`)
  appendStockMovement({
    type: '仓内移库调拨',
    skuCode: sku.code,
    model: `${sku.brand} ${sku.model}`,
    fromLoc: oldLoc,
    toLoc: sku.location,
    qtyDelta: '移位 1',
    refNo: reason?.trim() || '日常理货移库'
  })
  persist('move_loc')
  notify(`已完成移位留痕并记入总账流水：${oldLoc} → ${sku.location}`, 'ok')
}

export function completeSkuRepairRetest(sku, retestNote) {
  if (!assertRealAllowed()) return
  if (!retestNote?.trim()) return notify('防呆拦截（G04-03）：修回商品必须填写受影响功能复检实测结果，禁止无依据直接改完好！', 'err')
  sku.zone = '已复核可售'
  sku.location = 'A-11'
  sku.defectNote = `外修已复检通过（维修费 ¥${sku.repairCost || 0} 已入全成本台账，现况披露：${retestNote.trim()}）`
  sku.history.unshift(`${new Date().toISOString().slice(5, 10)} 修回专项复检通过（${retestNote.trim()}），重核披露后转入 A-11 可售`)
  persist('repair_retest')
  notify(`单件 #${sku.code} 修回复检闭环，已保留维修前记录并重核可售资格！`, 'ok')
}

export function sellAuxiliaryBox(aux) {
  if (!assertRealAllowed()) return
  if (aux.qty <= 0) return notify('该独立原盒库存已为 0', 'err')
  aux.qty -= 1
  aux.status = '已独立售出（扣原盒库存）'
  const host = store.data.skus.find(s => s.code === aux.hostSku)
  if (host) {
    host.boxCode = ''
    host.boxStatus = '原盒已独立售出 · 主机包装已自动更新为「无原盒」'
    host.history.unshift(`${new Date().toISOString().slice(5, 10)} 关联原盒 ${aux.id} 独立售出(¥${aux.price})，主机库存不变、包装说明同步改为无原盒`)
  }
  persist('sell_box')
  notify(`原盒 ${aux.id} 已独立出库扣减，关联主机 #${aux.hostSku} 包装说明已同步更新！`, 'ok')
}

export function convertLegacyToInbound(leg) {
  if (!assertRealAllowed()) return
  if (leg.converted) return
  leg.converted = true
  const newId = 'INSP-LEG-' + leg.goodsNo.slice(-4)
  store.data.inspections.unshift({
    id: newId,
    orderNo: 'LEGACY-' + leg.goodsNo,
    skuCode: leg.goodsNo,
    brand: 'HKC',
    model: leg.model,
    kind: 'monitor',
    standardId: 'STD-MON',
    standardVer: 'v2.3',
    waybill: '老系统盘存实物转入',
    purchaser: '历史结转（不继承老系统旧图）',
    declaredPrice: leg.cost,
    declaredSpec: `老货号 ${leg.goodsNo} · 老库位 ${leg.oldLoc} · 必须现场新拍实拍图与库位图`,
    recall24h: false,
    cameraChecked: false,
    recordingStarted: false,
    recordingStartedAt: '',
    recordingFinished: false,
    playbackVerified: false,
    interruptGap: '',
    needsSupervisorReview: false,
    bagCode: '',
    hasOriginalBox: false,
    boxCode: '',
    locationCode: 'A-12',
    targetZone: '已复核可售',
    unboxPreview: makeUnboxFrame({ code: leg.goodsNo, waybill: '历史实物复检', recording: false, stage: '老系统转入库 · 待开启复检录像并现场新拍照片' }),
    realPhotos: [],
    defectPhotos: [],
    locationPhotos: [],
    results: { M01: { status: 'UNSET', note: '' }, M02: { status: 'UNSET', note: '' }, M03: { status: 'UNSET', note: '' }, M04: { status: 'UNSET', note: '' }, M05: { status: 'UNSET', note: '' }, M06: { status: 'UNSET', note: '' } },
    submitted: false
  })
  persist('legacy_convert')
  notify(`已将老系统记录 ${leg.goodsNo} 转为新复检任务（严禁沿用老图，请现场新拍）`, 'ok')
  go('inspect', newId)
}

// ============ 6. 补图工单与显示器10秒视频切片 (WH09 + 11-11图片新规) ============
export function completeMediaTask(mt) {
  if (!assertRealAllowed()) return
  mt.done = true
  const sku = store.data.skus.find(s => s.code === mt.skuCode)
  if (sku) {
    if (mt.missingType.includes('实拍')) {
      sku.realImgCount = 3
      sku.realThumb = makeRealPhoto({ kind: sku.kind, code: sku.code, model: sku.model, badge: '刚补本件实拍 ×3' })
    } else {
      sku.locImgCount = 1
      sku.locThumb = makeLocationPhoto({ loc: sku.location, code: sku.code, bag: sku.bagCode })
    }
    sku.history.unshift(`${new Date().toISOString().slice(5, 10)} 仓管 ${currentUser.value.name} 完成自动派发「${mt.missingType}」补拍`)
  }
  persist('media_done')
  notify(`单件 #${mt.skuCode} 「${mt.missingType}」已补齐回写，库存红灯已消除！`, 'ok')
}

export function autoCleanAndAssignSlices() {
  if (!assertRealAllowed()) return
  const sw = store.data.sliceWorkbench
  const cleanFrames = sw.frames.filter(f => f.quality === 'ok')
  sw.frames.forEach(f => { f.selected = f.quality === 'ok'; f.assignedTo = '' })
  const minNeeded = sw.targetAccounts.length * 2
  if (cleanFrames.length < minNeeded) {
    persist('slice_short')
    return notify(`素材不足提醒（WH09-12）：剔除模糊/过曝/残影/近重复后仅剩 ${cleanFrames.length} 张有效帧，不足分配 ${sw.targetAccounts.length} 个账号（需至少 ${minNeeded} 张），请补拍一段10秒轮播视频！`, 'err')
  }
  cleanFrames.forEach((f, idx) => {
    const acc = sw.targetAccounts[idx % sw.targetAccounts.length]
    f.assignedTo = acc
  })
  sw.packagedAt = new Date().toTimeString().slice(0, 8)
  persist('slice_pack')
  notify(`已剔除4张废片，将 ${cleanFrames.length} 张清晰帧不重复分配至 ${sw.targetAccounts.length} 个账号（共用 #${sw.skuCode} 同一库存）！`, 'ok')
}

// ============ 7. RFID 批次盘点与主管调账审批 (G07) ============
export function approveStocktakeDiffBySupervisor(diff) {
  if (!isSupervisor.value) {
    return notify('角色门禁拦截：盘点差异必须由「仓管主管」复核原始证据后批准！', 'err')
  }
  diff.approved = true
  diff.approvedBy = `${currentUser.value.name} ${new Date().toTimeString().slice(0, 5)}`
  persist('approve_diff')
  notify(`差异单 ${diff.id} 已由主管复核批准`, 'ok')
}

export function commitStocktakeWriteback() {
  if (!isSupervisor.value) {
    return notify('硬防呆拦截：仓管业务员无权直接调平账面，须由「仓管主管」执行盘点回写！', 'err')
  }
  const unapproved = store.data.stocktake.discrepancies.filter(d => !d.approved)
  if (unapproved.length > 0) {
    return notify(`拦截：还有 ${unapproved.length} 条盘点差异未完成证据复核批准，禁止调账回写！`, 'err')
  }
  store.data.stocktake.ledgerWrittenBack = true
  const gift = store.data.auxiliaryLedger.find(a => a.id === 'GIFT-HDMI-01')
  if (gift) gift.qty = 17
  persist('stocktake_commit')
  notify(`批次 ${store.data.stocktake.batchNo} 已完成复核调账回写，更正前后日志已永久留痕！`, 'ok')
}

// ============ 8. 标准库增量审核发布 (WH02, G04, G11) ============
export function publishStandardDraft(draft) {
  if (!isSupervisor.value) {
    return notify('角色门禁拦截：外部采集草稿须由仓管主管/标准负责人审核后才能发布为生效标准！', 'err')
  }
  draft.status = 'PUBLISHED'
  draft.publishedBy = `${currentUser.value.name} (${new Date().toTimeString().slice(0, 5)})`
  const std = STANDARD_TEMPLATES.find(s => s.id === draft.targetStdId)
  if (std) {
    std.version = draft.nextVer
    std.updatedAt = '2026-11-14'
  }
  persist('pub_std')
  notify(`标准已升版至 ${draft.nextVer}（在办验货单继续锁定旧版不串版，已生成 ${draft.impactedInStock} 件在库商品复核提醒）`, 'ok')
}

// ============ 9. 新人三项实操通关演练（支持3步沙盒进度） ============
export function advancePracticeStep(caseKey, stepNum) {
  const uid = currentUser.value.id
  if (!store.data.practiceSteps) store.data.practiceSteps = {}
  if (!store.data.practiceSteps[uid]) store.data.practiceSteps[uid] = { case1: 0, case2: 0, case3: 0 }
  store.data.practiceSteps[uid][caseKey] = Math.max(store.data.practiceSteps[uid][caseKey] || 0, stepNum)
  if (stepNum >= 3) {
    completePracticeCase(caseKey)
  } else {
    persist('practice_done')
  }
}

export function completePracticeCase(caseKey) {
  const uid = currentUser.value.id
  if (!store.data.practiceProgress[uid]) {
    store.data.practiceProgress[uid] = { case1: false, case2: false, case3: false }
  }
  if (!store.data.practiceSteps) store.data.practiceSteps = {}
  if (!store.data.practiceSteps[uid]) store.data.practiceSteps[uid] = { case1: 0, case2: 0, case3: 0 }
  store.data.practiceProgress[uid][caseKey] = true
  store.data.practiceSteps[uid][caseKey] = 3
  persist('practice_done')
  const p = store.data.practiceProgress[uid]
  if (p.case1 && p.case2 && p.case3) {
    notify('3 个练习都做完了，真实任务与库存操作已经开放！', 'ok')
  } else {
    notify('这个练习做完了！继续完成剩余练习即可打开真实任务。', 'ok')
  }
}

export function resetPracticeProgress() {
  const uid = currentUser.value.id
  store.data.practiceProgress[uid] = { case1: false, case2: false, case3: false }
  if (!store.data.practiceSteps) store.data.practiceSteps = {}
  store.data.practiceSteps[uid] = { case1: 0, case2: 0, case3: 0 }
  persist('practice_reset')
  notify('学习进度已重置，去「学」里从头来；真实业务没有动', 'ok')
}

// ============ 10. 60秒协同接单、没见过的情况上报、提给开发（与销售工作台 Today 同构） ============
export function takeCollab() {
  if (!assertRealAllowed()) return
  if (!store.data.collab) return
  store.data.collab.state = 'taken'
  store.data.collab.takenBy = currentUser.value.name
  persist('take_collab')
  notify(`已接单，已回传销售接待台（由 ${currentUser.value.name} 前往 A-02 拍摄）`, 'ok')
}

export function resetCollab() {
  store.data.collab = {
    id: 'CLB-2601',
    state: 'open',
    left: 60,
    from: '销售接待台 · 陈小满（闲鱼 · 果果数码严选）',
    peer: '赵建国',
    skuCode: '513211540233-B',
    title: '买家正在问 A-02 飞利浦 27M2N5510P 右边框细痕亮屏明不明显，请补拍 1 张通电侧角特写回传接待台',
    takenBy: ''
  }
  persist('reset_collab')
  notify('已重新发起 60 秒跨台协同倒计时（演示）', 'info')
}

export function submitException(text) {
  if (!text?.trim()) return notify('请用一句话写清遇到了什么情况', 'err')
  if (!store.data.exceptions) store.data.exceptions = []
  store.data.exceptions.unshift({
    id: 'EXC-0' + (store.data.exceptions.length + 1),
    who: currentUser.value.name,
    t: '刚刚 ' + new Date().toTimeString().slice(0, 5),
    text: text.trim(),
    ruled: false,
    ruleNote: ''
  })
  persist('submit_exception')
  notify('已发给仓管主管，主管处理后会记成大家都看得到的规则', 'ok')
}

export function ruleException(exc) {
  if (!isSupervisor.value) return notify('只有仓管主管可以把新情况记成规则草案', 'err')
  exc.ruled = true
  persist('rule_exception')
  notify('已记成仓内规则草案，并同步到说明书备查', 'ok')
}

export function submitDevRequest({ kind, title, page, text }) {
  if (!title?.trim() || !text?.trim()) return notify('请写明标题和你希望怎么改', 'err')
  if (!store.data.devRequests) store.data.devRequests = []
  const id = 'ZT-' + (120 + store.data.devRequests.length)
  store.data.devRequests.unshift({
    id,
    by: currentUser.value.id,
    who: currentUser.value.name,
    t: '刚刚 ' + new Date().toTimeString().slice(0, 5),
    kind: kind || 'feature',
    page: page?.trim() || '',
    title: title.trim(),
    text: text.trim(),
    status: '待评审'
  })
  persist('submit_dev')
  notify(`已登记需求 ${id}（谁提的谁验收，不私发程序员）`, 'ok')
}

export function advanceDevRequest(req, nextStatus) {
  if ((nextStatus === '开发中' || nextStatus === '待提需求的人验收') && !isSupervisor.value) {
    return notify('只有主管可推进需求评审与提测状态', 'err')
  }
  if ((nextStatus === '已验收' || nextStatus === '打回重改') && req.by !== currentUser.value.id && !isSupervisor.value) {
    return notify(`谁提的谁验收：这条由「${req.who}」提出，请本人验收`, 'err')
  }
  req.status = nextStatus
  persist('dev_status')
  notify(`${req.id} 状态已更新为「${nextStatus}」`, 'ok')
}

export function updateTaskStatusGeneral(taskId, toStatus, note = '') {
  if (!assertRealAllowed()) return
  const t = store.data.tasks.find(x => x.id === taskId)
  if (!t) return
  if (toStatus === '已验收' || toStatus === '退回补正') {
    return reviewTaskBySupervisor(taskId, toStatus === '已验收', note)
  }
  if (toStatus === '待验收') {
    return submitTaskForReview(taskId, note)
  }
  if (toStatus === '受阻') {
    return markTaskBlocked(taskId, note)
  }
  if (t.assignee !== currentUser.value.id && !isSupervisor.value) {
    return notify(`权限拦截：该任务当前归属「${t.assigneeName}」`, 'err')
  }
  t.status = toStatus
  if (note?.trim()) {
    t.handoffHistory.push({
      at: new Date().toTimeString().slice(0, 8),
      from: currentUser.value.name,
      to: toStatus,
      donePart: note.trim(),
      todoPart: '',
      nextStep: ''
    })
  }
  persist('task_status')
  notify(`工单 ${t.id} 状态已更新为「${toStatus}」`, 'ok')
}

export function swapMediaTaskOwner(mtId, toId) {
  if (!isSupervisor.value) return notify('只有仓管主管可在请假等例外时手动换人', 'err')
  const acc = ACCOUNTS.find(a => a.id === toId)
  const mt = store.data.mediaTasks.find(m => m.id === mtId)
  if (!acc || !mt) return
  mt.assignee = acc.id
  mt.assigneeName = acc.name
  const related = store.data.tasks.find(t => t.skuCode === mt.skuCode && t.category.includes('图片'))
  if (related) {
    related.assignee = acc.id
    related.assigneeName = acc.name
  }
  persist('swap_media_owner')
  notify(`例外换人完成：已改由 ${acc.name} 补拍 #${mt.skuCode}`, 'ok')
}

export function captureSkuPhotoDirect(sku, kind) {
  if (!assertRealAllowed()) return
  if (!sku) return
  if (kind === 'real') {
    sku.realImgCount = Math.max(1, sku.realImgCount) + (sku.realThumb ? 1 : 0)
    sku.realThumb = makeRealPhoto({ kind: sku.kind, code: sku.code, model: sku.model, badge: `现场新拍实拍 ×${sku.realImgCount}` })
    sku.history.unshift(`${new Date().toISOString().slice(5, 10)} 仓管 ${currentUser.value.name} 在单件档案补拍本件实拍图`)
    const mt = store.data.mediaTasks.find(m => m.skuCode === sku.code && m.missingType.includes('实拍'))
    if (mt) mt.done = true
    notify(`已补拍单件 #${sku.code} 本件实拍图，缺实拍红灯已消除`, 'ok')
  } else if (kind === 'loc') {
    sku.locImgCount = Math.max(1, sku.locImgCount + 1)
    sku.locThumb = makeLocationPhoto({ loc: sku.location, code: sku.code, bag: sku.bagCode })
    sku.history.unshift(`${new Date().toISOString().slice(5, 10)} 仓管 ${currentUser.value.name} 在单件档案补拍库位同框照 (${sku.location})`)
    const mt = store.data.mediaTasks.find(m => m.skuCode === sku.code && m.missingType.includes('库位'))
    if (mt) mt.done = true
    notify(`已补拍单件 #${sku.code} 库位同框照（${sku.location} + ${sku.bagCode}）`, 'ok')
  }
  persist('sku_direct_photo')
}

// ============================================================================
// ============ 11. 标准化 WMS 能力底座：流水记账、多店抓单聚合、库位管理、ASN上架、总账 ============
// ============================================================================

export function appendStockMovement({ type, skuCode, model, fromLoc, toLoc, qtyDelta, refNo }) {
  if (!Array.isArray(store.data.stockMovements)) store.data.stockMovements = []
  const seq = String(store.data.stockMovements.length + 1).padStart(3, '0')
  const nowStr = '11-14 ' + new Date().toTimeString().slice(0, 8)
  store.data.stockMovements.unshift({
    movNo: `MOV-261114-${seq}`,
    time: nowStr,
    type,
    skuCode: skuCode || '-',
    model: model || '-',
    fromLoc: fromLoc || '-',
    toLoc: toLoc || '-',
    qtyDelta: qtyDelta || '1',
    refNo: refNo || '-',
    operator: currentUser.value?.name || '系统'
  })
}

// ---- 11A. 多店铺订单抓取与订单聚合中心 (#/orders) ----
export function pullAllShopOrders() {
  if (!assertRealAllowed()) return
  const nowT = new Date().toTimeString().slice(0, 8)
  let newlyAdded = 0
  let recoveredMissed = 0
  let dedupSkipped = 0

  for (const sh of store.data.saleShops || []) {
    sh.lastSyncAt = nowT
    sh.status = 'ONLINE'
  }

  // 自动将 RPA 巡检检出的漏抓订单补抓入池并锁库
  for (const ord of store.data.salesOrderPool || []) {
    if (ord.aggState === 'CAPTURE_MISSED') {
      captureMissedOrder(ord, true)
      recoveredMissed += 1
    } else {
      dedupSkipped += 1
    }
  }

  // 若尚未抓取最新一笔实时测试新单，模拟从闲管家抓取1笔新付款订单（演示去重与抓单）
  const demoExtNo = 'XY20261114066'
  if (!(store.data.salesOrderPool || []).some(o => o.externalOrderNo === demoExtNo)) {
    store.data.salesOrderPool.unshift({
      id: 'ORD-261114-09',
      externalOrderNo: demoExtNo,
      shopCode: 'SHOP-01',
      shopName: '果果数码严选',
      platform: '闲鱼 · 闲管家API',
      captureSource: `全渠道主动巡检抓入 (${nowT})`,
      aggState: 'UNMATCHED_SKU',
      buyerName: '周予安',
      buyerPhone: '158****4419',
      receiverAddr: '四川省成都市高新区天府软件园G区8栋',
      mergeGroupKey: 'zhouyuan_cd_1584419',
      mergedInto: '',
      subOrderNos: [demoExtNo],
      paidAt: nowT,
      amount: 599,
      salesOwner: '陈小满',
      xgjProductId: 'XGJ-774501',
      spuCode: 'SPU-PHL-27M2N5500',
      itemTitle: '飞利浦 27M2N5500 27寸 2K 180Hz 显示器（新抓入待绑定单件货号）',
      skuCode: '',
      locationCode: '',
      carrier: '顺丰速运 · 标快陆运',
      waybillNo: '',
      waveNo: '',
      holdType: '',
      holdReason: '',
      syncStatus: 'PENDING',
      syncError: ''
    })
    const sh1 = (store.data.saleShops || []).find(s => s.code === 'SHOP-01')
    if (sh1) sh1.todayGrabbed += 1
    newlyAdded += 1
  }

  persist('pull_orders')
  notify(`全渠道巡检完成：新抓付款单 ${newlyAdded} 笔、补抓漏单 ${recoveredMissed} 笔，自动去重跳过已存在外部单号 ${dedupSkipped} 笔！`, 'ok')
}

export function captureMissedOrder(ord, silent = false) {
  if (!silent && !assertRealAllowed()) return
  if (!ord || ord.aggState !== 'CAPTURE_MISSED') return
  const sku = store.data.skus.find(s => s.code === ord.skuCode)
  if (sku && sku.zone === '已复核可售') {
    sku.zone = '锁单待发'
    sku.history.unshift(`11-14 RPA补抓订单 ${ord.externalOrderNo} 自动锁库待发`)
    ord.locationCode = sku.location
    ord.aggState = 'READY_WAVE'
    appendStockMovement({
      type: '销售订单锁库',
      skuCode: sku.code,
      model: `${sku.brand} ${sku.model}`,
      fromLoc: `${sku.location}(可售)`,
      toLoc: `${sku.location}(锁单)`,
      qtyDelta: '锁定 1',
      refNo: ord.externalOrderNo
    })
  } else {
    ord.aggState = 'UNMATCHED_SKU'
  }
  const sh = (store.data.saleShops || []).find(s => s.code === ord.shopCode)
  if (sh) {
    sh.status = 'ONLINE'
    sh.lastSyncAt = new Date().toTimeString().slice(0, 8)
  }
  if (!silent) {
    persist('capture_missed')
    notify(`已补抓漏单 ${ord.externalOrderNo} 入池，并锁定实物 #${ord.skuCode}（库位 ${ord.locationCode}）！`, 'ok')
  }
}

export function bindOrderToPhysicalSku(ord, skuCode) {
  if (!assertRealAllowed()) return
  if (!ord || !skuCode) return notify('请选择要绑定的一物一码在库单件', 'err')
  const sku = store.data.skus.find(s => s.code === skuCode)
  if (!sku) return notify(`未找到单件 #${skuCode}`, 'err')
  if (sku.zone !== '已复核可售') {
    return notify(`防呆拦截：单件 #${sku.code} 当前状态为「${sku.zone}」，仅允许绑定「已复核可售」实物！`, 'err')
  }
  ord.skuCode = sku.code
  ord.locationCode = sku.location
  ord.aggState = 'READY_WAVE'
  sku.zone = '锁单待发'
  sku.history.unshift(`11-14 挂接销售订单 ${ord.externalOrderNo} 锁单配货`)
  appendStockMovement({
    type: '销售订单锁库',
    skuCode: sku.code,
    model: `${sku.brand} ${sku.model}`,
    fromLoc: `${sku.location}(可售)`,
    toLoc: `${sku.location}(锁单)`,
    qtyDelta: '锁定 1',
    refNo: ord.externalOrderNo
  })
  persist('bind_order_sku')
  notify(`订单 ${ord.externalOrderNo} 已绑定单件 #${sku.code}（库位 ${sku.location}），可下发波次拣货！`, 'ok')
}

export function mergeSameBuyerOrders(groupKey) {
  if (!assertRealAllowed()) return
  const candidates = (store.data.salesOrderPool || []).filter(o => o.mergeGroupKey === groupKey && o.aggState === 'MERGEABLE')
  if (candidates.length < 2) {
    return notify('同买家同收货地址至少需 2 笔待发订单才可合并包裹', 'err')
  }
  const primary = candidates[0]
  const rest = candidates.slice(1)
  const masterNo = `MGO-20261114-0${(store.data.pickingWaves?.length || 1)}`
  const allExtNos = candidates.flatMap(c => c.subOrderNos || [c.externalOrderNo])
  const totalAmt = candidates.reduce((s, c) => s + Number(c.amount || 0), 0)
  const extraItems = rest.map(r => ({
    orderNo: r.externalOrderNo,
    skuCode: r.skuCode,
    locationCode: r.locationCode,
    model: r.itemTitle
  }))

  for (const c of candidates) {
    c.aggState = 'MERGED_CHILD'
    c.mergedInto = masterNo
  }

  store.data.salesOrderPool.unshift({
    id: 'ORD-' + masterNo,
    externalOrderNo: masterNo,
    isMergedMaster: true,
    mergedChildrenIds: candidates.map(c => c.id),
    subOrderNos: allExtNos,
    shopCode: primary.shopCode,
    shopName: primary.shopName,
    platform: primary.platform + ' · 同客合单母单',
    captureSource: `由 ${allExtNos.join(' + ')} 同买家同地址合并`,
    aggState: 'READY_WAVE',
    buyerName: primary.buyerName,
    buyerPhone: primary.buyerPhone,
    receiverAddr: primary.receiverAddr,
    mergeGroupKey: groupKey,
    mergedInto: '',
    paidAt: primary.paidAt,
    amount: totalAmt,
    salesOwner: primary.salesOwner,
    xgjProductId: primary.xgjProductId,
    spuCode: primary.spuCode,
    itemTitle: `【2单合并包裹】${primary.itemTitle} + ${rest.map(r => r.itemTitle).join(' + ')}`,
    skuCode: primary.skuCode,
    extraItems,
    locationCode: `${primary.locationCode} + ${rest.map(r => r.locationCode).join('+')}`,
    carrier: primary.carrier,
    waybillNo: '',
    waveNo: '',
    holdType: '',
    holdReason: '',
    syncStatus: 'PENDING',
    syncError: ''
  })

  persist('merge_orders')
  notify(`合单成功！已将买家「${primary.buyerName}」的 ${candidates.length} 笔同地址订单合并为母单 ${masterNo}（共省一票顺丰首重运费，出库单号将自动同步回写所有子单）`, 'ok')
}

export function splitMergedOrder(masterOrd) {
  if (!assertRealAllowed()) return
  if (!masterOrd || !masterOrd.isMergedMaster) return
  if (masterOrd.aggState === 'IN_WAVE' || masterOrd.aggState === 'SHIPPED_SYNC') {
    return notify('该合并母单已下发波次或已发货，禁止中途拆单！', 'err')
  }
  const childIds = new Set(masterOrd.mergedChildrenIds || [])
  for (const o of store.data.salesOrderPool || []) {
    if (childIds.has(o.id)) {
      o.aggState = 'MERGEABLE'
      o.mergedInto = ''
    }
  }
  const idx = store.data.salesOrderPool.findIndex(o => o.id === masterOrd.id)
  if (idx >= 0) store.data.salesOrderPool.splice(idx, 1)
  persist('split_merged_order')
  notify(`已将 ${masterOrd.externalOrderNo} 拆回 ${childIds.size} 笔独立订单分别发货`, 'info')
}

export function resolveInterceptOrder(ord, mode) {
  if (!assertRealAllowed()) return
  if (!ord) return
  if (mode === 'CANCEL_REFUND_RELEASE') {
    ord.aggState = 'CANCELLED'
    ord.syncStatus = 'REFUND_CLOSED'
    const sku = store.data.skus.find(s => s.code === ord.skuCode)
    if (sku && sku.zone === '锁单待发') {
      sku.zone = '已复核可售'
      sku.history.unshift(`11-14 订单 ${ord.externalOrderNo} 售前退款取消，自动解锁恢复可售`)
    }
    appendStockMovement({
      type: '取消锁库释放',
      skuCode: ord.skuCode || '-',
      model: ord.itemTitle,
      fromLoc: `${ord.locationCode || 'A区'}(锁单)`,
      toLoc: `${ord.locationCode || 'A区'}(可售)`,
      qtyDelta: '释放 1',
      refNo: ord.externalOrderNo
    })
    persist('cancel_release_order')
    notify(`已确认订单 ${ord.externalOrderNo} 售前退款拦截，关联单件 #${ord.skuCode} 已释放回可售库存！`, 'ok')
  } else if (mode === 'APPROVE_NEW_ADDR') {
    ord.holdType = ''
    ord.holdReason = ''
    ord.aggState = 'READY_WAVE'
    ord.syncStatus = 'PENDING'
    const ob = store.data.outbounds.find(x => x.orderNo === ord.externalOrderNo)
    if (ob) {
      ob.addressChanged = false
      ob.status = 'PENDING_SHIP'
      ob.pausedReason = ''
    }
    persist('approve_order_addr')
    notify(`销售已与买家核实新地址与实况，订单 ${ord.externalOrderNo} 已解除拦截恢复配货！`, 'ok')
  }
}

export function createManualSalesOrder({ externalOrderNo, shopCode, buyerName, buyerPhone, receiverAddr, amount, spuCode, skuCode }) {
  if (!assertRealAllowed()) return false
  const ext = (externalOrderNo || '').trim()
  if (!ext || !buyerName?.trim() || !receiverAddr?.trim()) {
    notify('外部平台单号、买家姓名、详细收货地址均不能为空！', 'err')
    return false
  }
  if ((store.data.salesOrderPool || []).some(o => o.externalOrderNo === ext || (o.subOrderNos || []).includes(ext))) {
    notify(`重复抓单防呆拦截：外部单号「${ext}」已在订单池中存在，严禁重复建单发货！`, 'err')
    return false
  }
  const shop = (store.data.saleShops || []).find(s => s.code === shopCode) || store.data.saleShops[0]
  const spu = (store.data.spuCatalog || []).find(s => s.spuCode === spuCode)
  const sku = skuCode ? store.data.skus.find(s => s.code === skuCode) : null
  if (sku && sku.zone !== '已复核可售') {
    notify(`防呆拦截：所选实物 #${sku.code} 状态为「${sku.zone}」，不可绑定发货`, 'err')
    return false
  }
  if (sku) {
    sku.zone = '锁单待发'
    sku.history.unshift(`11-14 手工录单 ${ext} 锁库配货`)
    appendStockMovement({
      type: '销售订单锁库',
      skuCode: sku.code,
      model: `${sku.brand} ${sku.model}`,
      fromLoc: `${sku.location}(可售)`,
      toLoc: `${sku.location}(锁单)`,
      qtyDelta: '锁定 1',
      refNo: ext
    })
  }
  store.data.salesOrderPool.unshift({
    id: 'ORD-MAN-' + Date.now().toString().slice(-4),
    externalOrderNo: ext,
    shopCode: shop.code,
    shopName: shop.label,
    platform: '手工兜底导单',
    captureSource: `${currentUser.value.name} 手工补录`,
    aggState: sku ? 'READY_WAVE' : 'UNMATCHED_SKU',
    buyerName: buyerName.trim(),
    buyerPhone: (buyerPhone || '136****0000').trim(),
    receiverAddr: receiverAddr.trim(),
    mergeGroupKey: `${buyerName.trim()}_${(buyerPhone || '').slice(-4)}`,
    mergedInto: '',
    subOrderNos: [ext],
    paidAt: new Date().toTimeString().slice(0, 8),
    amount: Number(amount || 0),
    salesOwner: '陈小满',
    xgjProductId: 'MAN-' + ext.slice(-4),
    spuCode: spu ? spu.spuCode : '',
    itemTitle: sku ? `${sku.brand} ${sku.model}` : (spu ? `${spu.brand} ${spu.model} ${spu.spec}` : '手工补录商品'),
    skuCode: sku ? sku.code : '',
    locationCode: sku ? sku.location : '',
    carrier: '顺丰速运 · 标快',
    waybillNo: '',
    waveNo: '',
    holdType: '',
    holdReason: '',
    syncStatus: 'PENDING',
    syncError: ''
  })
  shop.todayGrabbed += 1
  persist('manual_order')
  notify(`手工订单 ${ext} 已录入订单聚合池！`, 'ok')
  return true
}

export function dispatchPickingWave(orderIds) {
  if (!assertRealAllowed()) return null
  const list = (store.data.salesOrderPool || []).filter(o => orderIds.includes(o.id))
  if (!list.length) {
    notify('请至少勾选 1 笔「待组波次拣货」状态的订单', 'err')
    return null
  }
  const invalid = list.find(o => o.aggState !== 'READY_WAVE' || !o.skuCode)
  if (invalid) {
    notify(`防呆拦截：订单 ${invalid.externalOrderNo} 尚未完成单件配货或存在异常拦截，禁止混入拣货波次！`, 'err')
    return null
  }

  if (!Array.isArray(store.data.pickingWaves)) store.data.pickingWaves = []
  const waveIdx = store.data.pickingWaves.length + 1
  const waveNo = `WAVE-20261114-0${waveIdx}`
  const stops = []

  for (const ord of list) {
    const sku = store.data.skus.find(s => s.code === ord.skuCode)
    const primaryLoc = sku ? sku.location : (ord.locationCode || 'A-01').split(' ')[0]
    stops.push({
      seq: 0,
      loc: primaryLoc,
      skuCode: ord.skuCode,
      model: sku ? `${sku.brand} ${sku.model}` : ord.itemTitle,
      orderNo: ord.externalOrderNo,
      picked: false
    })
    for (const ex of ord.extraItems || []) {
      stops.push({
        seq: 0,
        loc: ex.locationCode || 'E-03',
        skuCode: ex.skuCode,
        model: `【合单同拣】${ex.model}`,
        orderNo: ord.externalOrderNo,
        picked: false
      })
    }

    const genWaybill = ord.waybillNo || ('SF143009' + Math.floor(1000 + Math.random() * 8999))
    ord.waveNo = waveNo
    ord.waybillNo = genWaybill
    ord.aggState = 'IN_WAVE'
    ord.syncStatus = 'WAIT_SHIP'

    if (!store.data.outbounds.some(x => x.orderNo === ord.externalOrderNo)) {
      store.data.outbounds.unshift({
        id: 'OUT-' + Date.now().toString().slice(-4) + Math.floor(Math.random() * 9),
        waveNo,
        orderNo: ord.externalOrderNo,
        subOrderNos: ord.subOrderNos || [ord.externalOrderNo],
        shop: `${ord.platform.split(' · ')[0]} · ${ord.shopName}`,
        buyer: `${ord.buyerName}（${ord.buyerPhone}）`,
        receiverAddr: ord.receiverAddr,
        carrier: ord.carrier || '顺丰速运 · 标快陆运',
        routeCode: ord.receiverAddr.includes('深圳') ? '755-NS-01' : ord.receiverAddr.includes('上海') ? '021-PD-06' : '020-TH-03',
        salesOwner: ord.salesOwner || '陈小满',
        deadline: '今日 17:00 波次截单揽收',
        overdue: false,
        skuCode: ord.skuCode,
        extraItems: ord.extraItems || [],
        sn: sku?.sn || ('SN-' + ord.skuCode.slice(-6)),
        model: ord.itemTitle,
        locationCode: ord.locationCode || primaryLoc,
        bagCode: sku?.bagCode ? `${sku.bagCode}（核对电源线材齐套）` : '标准随件附件包',
        boxCode: sku?.boxCode ? `${sku.boxCode}（带原盒加固）` : '无原盒（选用标准气柱防震箱）',
        packMaterialCode: sku?.kind === 'phone' ? 'PM-SF-F2' : 'PM-BOX-27',
        waybillPrinted: false,
        disclosedDefect: sku?.defectNote || '全检无暗病，买家已确认成色实拍',
        customerConfirmed: true,
        customerConfirmedAt: '2026-11-14 ' + ord.paidAt.slice(0, 5),
        addressChanged: false,
        scanChecks: {
          host: { code: ord.skuCode, label: '主机一物一码', loc: primaryLoc, scanned: false },
          bag: { code: `${ord.skuCode}#BAG`, label: '附件袋副码', loc: sku?.bagBin || 'LPN-BOX-01', scanned: !sku?.bagCode },
          box: { code: (ord.extraItems && ord.extraItems[0]?.skuCode) || `${ord.skuCode}#BOX`, label: ord.extraItems?.length ? '同拣合单副件码' : '原盒副码', loc: ord.extraItems?.length ? (ord.extraItems[0].locationCode || 'E-03') : 'E-01', scanned: !sku?.boxCode && !(ord.extraItems && ord.extraItems.length) },
          sn: { code: sku?.sn || ('SN-' + ord.skuCode.slice(-6)), label: '机身原厂 SN', loc: '机身铭牌', scanned: false }
        },
        kitHostChecked: false,
        kitBagChecked: !sku?.bagCode,
        kitBoxChecked: !sku?.boxCode && !(ord.extraItems && ord.extraItems.length),
        scannedCode: '',
        scanVerified: false,
        conditionRechecked: false,
        packVideoRecorded: false,
        packVideoReadable: false,
        waybillNo: genWaybill,
        status: 'PENDING_SHIP',
        pausedReason: '',
        thumb: sku?.realThumb || makeRealPhoto({ kind: sku?.kind || 'monitor', code: ord.skuCode, model: ord.itemTitle.slice(0, 18), badge: waveNo })
      })
    }
  }

  // 自动按库位编码字典序排列最优行走拣货路径 (A区 -> B区 -> E区)
  stops.sort((a, b) => a.loc.localeCompare(b.loc))
  stops.forEach((s, i) => { s.seq = i + 1 })

  store.data.pickingWaves.unshift({
    waveNo,
    createdAt: new Date().toTimeString().slice(0, 8),
    creator: currentUser.value.name,
    carrierGroup: `波次合集（${list.length} 票面单 / ${stops.length} 件拣货）`,
    status: 'PICKING',
    routeStops: stops
  })

  persist('dispatch_wave')
  notify(`已生成拣货波次 ${waveNo}（按库位 ${stops.map(s => s.loc).join(' → ')} 最优路径排序），已同步推入出库台！`, 'ok')
  return waveNo
}

export function retryOrderPlatformCallback(ord) {
  if (!assertRealAllowed()) return
  if (!ord) return
  ord.syncStatus = 'SYNCED_OK'
  ord.syncError = ''
  persist('retry_order_callback')
  notify(`订单 ${ord.externalOrderNo} 运单号 ${ord.waybillNo} 已成功重推闲管家与店铺后台！`, 'ok')
}

// ---- 11B. WMS 四级库位与储位管理 (#/locations) ----
export function occupiedSkusOfBin(locCode) {
  if (!locCode) return []
  return (store.data.skus || []).filter(s => s.location === locCode && s.zone !== '已出库在途')
}

export function createWmsLocation({ code, zone, zoneName, rack, level, binType, capacity, note }) {
  if (!assertRealAllowed()) return false
  const clean = (code || '').trim().toUpperCase()
  if (!clean || !/^[A-F]-\d{2}/.test(clean)) {
    notify('库位编码须遵循四级标准格式（如 A-12、B-05、E-06）！', 'err')
    return false
  }
  if ((store.data.locations || []).some(l => l.code === clean)) {
    notify(`防重拦截：库位编码 ${clean} 已存在，请勿重复创建！`, 'err')
    return false
  }
  store.data.locations.push({
    code: clean,
    warehouse: 'WH01·深圳主仓',
    zone: zone || clean.slice(0, 1) + '区',
    zoneName: zoneName || '标准扩展储位',
    rack: rack || clean.slice(0, 1) + '扩展排',
    level: level || '标准层',
    binType: binType || 'SALEABLE',
    capacity: Math.max(1, Number(capacity || 2)),
    enabled: true,
    note: (note || '新建标准储位').trim()
  })
  store.data.locations.sort((a, b) => a.code.localeCompare(b.code))
  persist('create_location')
  notify(`已新建标准库位 ${clean}（容量 ${capacity || 2}）`, 'ok')
  return true
}

export function batchCreateWmsLocations({ zone, prefix, startNum, count, capacity, binType }) {
  if (!assertRealAllowed()) return 0
  const pfx = (prefix || 'A-').trim().toUpperCase()
  const start = Math.max(1, Number(startNum || 12))
  const n = Math.min(12, Math.max(1, Number(count || 4)))
  const cap = Math.max(1, Number(capacity || 2))
  const zoneMap = {
    'A区': '主力数码/显示器可售区',
    'B区': '大件曲面屏/音箱立体架',
    'C区': '到货签收待检暂存区',
    'D区': '异常隔离与待修红牌锁柜',
    'E区': '原盒配件与包材耗材区',
    'F区': '波次集货打包交接区'
  }
  let created = 0
  for (let i = 0; i < n; i++) {
    const numStr = String(start + i).padStart(2, '0')
    const code = pfx.endsWith('-') ? `${pfx}${numStr}` : `${pfx}-${numStr}`
    if (!(store.data.locations || []).some(l => l.code === code)) {
      store.data.locations.push({
        code,
        warehouse: 'WH01·深圳主仓',
        zone,
        zoneName: zoneMap[zone] || '标准储位区',
        rack: `${zone.slice(0, 1)}扩排`,
        level: `${i + 1}格`,
        binType: binType || (zone === 'D区' ? 'QUARANTINE' : zone === 'C区' ? 'STAGING' : 'SALEABLE'),
        capacity: cap,
        enabled: true,
        note: '批量生成货架格口'
      })
      created += 1
    }
  }
  store.data.locations.sort((a, b) => a.code.localeCompare(b.code))
  persist('batch_create_locations')
  notify(created > 0 ? `已批量生成 ${created} 个标准货架库位！` : '所选编号区间均已存在，未重复创建', created > 0 ? 'ok' : 'info')
  return created
}

export function toggleWmsLocationEnabled(loc) {
  if (!assertRealAllowed()) return
  if (!loc) return
  const inside = occupiedSkusOfBin(loc.code)
  if (loc.enabled && inside.length > 0) {
    return notify(`带货禁停防呆拦截：库位 ${loc.code} 内仍有 ${inside.length} 件在库实物（#${inside[0].code}），请先移库清空后再停用维护！`, 'err')
  }
  loc.enabled = !loc.enabled
  persist('toggle_location')
  notify(loc.enabled ? `库位 ${loc.code} 已恢复启用，允许扫码上架` : `库位 ${loc.code} 已设为停用冻结，禁止新商品上架移入`, 'ok')
}

export function transferSkuBetweenBins({ skuCode, toBinCode, reason }) {
  if (!assertRealAllowed()) return false
  const sku = (store.data.skus || []).find(s => s.code === skuCode)
  if (!sku) {
    notify('请选择要移库的在库单件', 'err')
    return false
  }
  const targetBin = (store.data.locations || []).find(l => l.code === toBinCode)
  if (!targetBin) {
    notify(`目标库位 ${toBinCode} 不存在`, 'err')
    return false
  }
  if (!targetBin.enabled) {
    notify(`防呆拦截：目标库位 ${targetBin.code} 已停用维护，禁止移入！`, 'err')
    return false
  }
  if (sku.location === targetBin.code) {
    notify('源库位与目标库位相同，无需移库', 'err')
    return false
  }
  const occ = occupiedSkusOfBin(targetBin.code).length
  if (occ >= targetBin.capacity) {
    notify(`容量防呆拦截：目标库位 ${targetBin.code} 已满载（${occ}/${targetBin.capacity}），请选其他空闲格口！`, 'err')
    return false
  }
  const isQuarantineSku = sku.zone.includes('隔离') || sku.zone.includes('待修') || sku.zone.includes('待议价')
  if (isQuarantineSku && targetBin.binType === 'SALEABLE') {
    notify(`库区属性冲突硬拦截：单件 #${sku.code} 处于「${sku.zone}」，严禁移入 ${targetBin.code} 可售货架！请选 D 区红牌隔离柜。`, 'err')
    return false
  }
  moveSkuLocation(sku, targetBin.code, reason || '扫码移库整理')
  return true
}

// ---- 11C. 采购在途 ASN 到货签收 · SPU匹配防呆 · 扫码上架台 (#/asn) ----
export function signInboundAsn(asn, { inputSuffix, cartonNote }) {
  if (!assertRealAllowed()) return false
  if (!asn) return false
  if (asn.carrier.includes('顺丰') && asn.phoneSuffix && (inputSuffix || '').trim() !== asn.phoneSuffix) {
    notify(`顺丰签收防呆核验：收件手机后 4 位输入「${inputSuffix || '空'}」与采购单登记尾号「${asn.phoneSuffix}」不一致，谨防错签隔壁商户快件！`, 'err')
    return false
  }
  asn.status = 'SIGNED_IN_INSPECT'
  asn.signedAt = new Date().toTimeString().slice(0, 8)
  if (cartonNote?.trim()) asn.outerCartonStatus = cartonNote.trim()
  const genSku = asn.skuCode || ('513211' + Math.floor(540800 + Math.random() * 900))
  asn.skuCode = genSku

  if (!asn.inspectId) {
    const newInspId = 'INSP-' + genSku.slice(-6)
    asn.inspectId = newInspId
    const stdId = asn.kind === 'phone' ? 'STD-PHONE' : 'STD-MON'
    const stdTpl = STANDARD_TEMPLATES.find(s => s.id === stdId)
    const initRes = {}
    for (const it of stdTpl?.items || []) initRes[it.code] = { status: 'UNSET', note: '' }
    store.data.inspections.unshift({
      id: newInspId,
      orderNo: asn.poNo,
      skuCode: genSku,
      brand: asn.declaredBrand,
      model: asn.declaredModel,
      kind: asn.kind || 'monitor',
      standardId: stdId,
      standardVer: stdTpl?.version || 'v2.3',
      waybill: asn.trackingNo,
      purchaser: asn.purchaser,
      declaredPrice: asn.declaredPrice,
      declaredSpec: asn.declaredSpec,
      recall24h: false,
      cameraChecked: false,
      recordingStarted: false,
      recordingStartedAt: '',
      recordingFinished: false,
      playbackVerified: false,
      interruptGap: '',
      needsSupervisorReview: false,
      bagCode: asn.bagCode || '',
      hasOriginalBox: false,
      boxCode: '',
      locationCode: asn.recommendedBin || 'A-01',
      targetZone: '已复核可售',
      unboxPreview: makeUnboxFrame({ code: genSku, waybill: asn.trackingNo, recording: false, stage: `刚签收暂存 ${asn.stagingBin} · 待拆封前起录全检` }),
      realPhotos: [],
      defectPhotos: [],
      locationPhotos: [],
      results: initRes,
      submitted: false
    })
  }
  asn.inspectSummary = `已签收暂存入 ${asn.stagingBin}（分配待检货号 #${genSku}），待完成高拍仪全检或快速过检`
  appendStockMovement({
    type: '采购签收暂存',
    skuCode: genSku,
    model: `${asn.declaredBrand} ${asn.declaredModel}`,
    fromLoc: `${asn.carrier}在途`,
    toLoc: asn.stagingBin || 'C-02',
    qtyDelta: '+1 待检',
    refNo: `${asn.poNo} / ${asn.trackingNo}`
  })
  persist('sign_asn')
  notify(`运单 ${asn.trackingNo} 核验尾号无误已签收，暂存入 ${asn.stagingBin} 并生成验货单 ${asn.inspectId}！`, 'ok')
  return true
}

export function fastPassAsnInspectionForDemo(asn) {
  if (!assertRealAllowed()) return
  if (!asn || asn.status !== 'SIGNED_IN_INSPECT') return
  if (asn.inspectSummary.includes('碎裂') || asn.conditionGrade.includes('异常')) {
    return notify('防呆拦截：该包裹已检出外屏碎裂异常，严禁走快速全通，须在验货台完成剩余安全项并入 D 区隔离柜！', 'err')
  }
  asn.status = 'INSPECTED_WAIT_PUTAWAY'
  asn.inspectSummary = '✓ 已在验货台完成拆封录像与全项 PASS 实测，待绑定 SPU 打标上架'
  const insp = store.data.inspections.find(i => i.id === asn.inspectId)
  if (insp) insp.submitted = true
  persist('asn_insp_pass')
  notify(`包裹 #${asn.skuCode} 已同步验货全通结论，请继续第 3 步核对 SPU 标准型号并打印一物一码贴纸！`, 'ok')
}

export function registerUnclaimedParcel({ trackingNo, carrier, senderHint, cartonNote }) {
  if (!assertRealAllowed()) return false
  const trk = (trackingNo || '').trim()
  if (!trk) {
    notify('请扫描或输入无主包裹快递面单号', 'err')
    return false
  }
  if ((store.data.inboundAsns || []).some(a => a.trackingNo === trk)) {
    notify(`运单号 ${trk} 已在到货列表中，请直接搜索查看`, 'err')
    return false
  }
  store.data.inboundAsns.unshift({
    id: 'ASN-UNC-' + Date.now().toString().slice(-4),
    poNo: '待认领（卖家漏填单号）',
    trackingNo: trk,
    carrier: carrier || '顺丰速运',
    phoneSuffix: '8836',
    purchaser: '待采购群认领',
    sellerNick: (senderHint || '面单寄件人信息已拍照留存').trim(),
    declaredBrand: '无主快件',
    declaredModel: '待关联采购单后拆封验货',
    declaredSpec: cartonNote?.trim() || '外箱完好，暂存 C-03 无主待认领专格',
    declaredPrice: 0,
    kind: 'monitor',
    outerCartonStatus: cartonNote?.trim() || '外箱完好',
    status: 'UNCLAIMED_HOLD',
    signedAt: new Date().toTimeString().slice(0, 8),
    stagingBin: 'C-03',
    inspectId: '',
    inspectSummary: '已暂存 C-03 无主认领格并通知采购认领（未绑单严禁私拆）',
    spuCode: '',
    skuCode: '',
    conditionGrade: '待认领',
    bagCode: '',
    labelPrinted: false,
    recommendedBin: 'C-03',
    putawayBin: 'C-03'
  })
  appendStockMovement({
    type: '无主快件暂存',
    skuCode: 'UNCLAIMED',
    model: `未知快件 (${trk})`,
    fromLoc: '门口到件',
    toLoc: 'C-03',
    qtyDelta: '+1 暂存',
    refNo: trk
  })
  persist('reg_unclaimed')
  notify(`无主包裹 ${trk} 已贴黄牌登记入 C-03 专格，并推送采购组凭寄件人信息认领！`, 'ok')
  return true
}

export function claimUnclaimedParcel(asn, { poNo, purchaser, declaredBrand, declaredModel, declaredPrice }) {
  if (!assertRealAllowed()) return false
  if (!poNo?.trim() || !declaredBrand?.trim() || !declaredModel?.trim()) {
    notify('认领包裹须完整填写关联采购单号、品牌与申报型号！', 'err')
    return false
  }
  asn.poNo = poNo.trim()
  asn.purchaser = (purchaser || '张敏（采购一组）').trim()
  asn.declaredBrand = declaredBrand.trim()
  asn.declaredModel = declaredModel.trim()
  asn.declaredPrice = Number(declaredPrice || 500)
  asn.status = 'SIGNED_IN_INSPECT'
  asn.skuCode = '513211' + Math.floor(540900 + Math.random() * 99)
  asn.recommendedBin = 'A-03'
  asn.putawayBin = ''
  asn.inspectSummary = `采购已认领关联 ${asn.poNo}，分配单件码 #${asn.skuCode} 待验货`
  persist('claim_parcel')
  notify(`无主包裹 ${asn.trackingNo} 已成功认领绑定采购单 ${asn.poNo}！`, 'ok')
  return true
}

export function bindAsnSpuAndPrintTag(asn, { spuCode, conditionGrade, bagCode }) {
  if (!assertRealAllowed()) return false
  if (!asn) return false
  const spu = (store.data.spuCatalog || []).find(s => s.spuCode === spuCode)
  if (!spu) {
    notify('请先从标准 SPU 商品字典中选择精确匹配的型号！', 'err')
    return false
  }
  // 演示员工甲 SPU/SKU 匹配防呆：品牌冲突硬拦截 + 容量/尾缀冲突硬拦截
  if (asn.declaredBrand && asn.declaredBrand !== '无主快件' && spu.brand.toLowerCase() !== asn.declaredBrand.toLowerCase()) {
    notify(`SPU 匹配防呆硬拦截：到货品牌为「${asn.declaredBrand}」，严禁跨品牌错绑到「${spu.brand} · ${spu.model}」！`, 'err')
    return false
  }
  if (asn.declaredModel.includes('27M2N5500') && spu.spuCode === 'SPU-PHL-27M2N5510P') {
    notify('近似型号防混硬拦截：本单实收为普通底座款「27M2N5500」，严禁错绑成高配升降底座款「27M2N5510P」！请重选 SPU-PHL-27M2N5500。', 'err')
    return false
  }
  if (asn.declaredModel.includes('128G') && spu.spuCode.includes('256')) {
    notify('容量防混硬拦截：本机实收为「128G」版本，严禁错绑到「256G」标准 SPU！请选 SPU-APL-IP15P-128。', 'err')
    return false
  }
  asn.spuCode = spu.spuCode
  if (conditionGrade) asn.conditionGrade = conditionGrade
  if (bagCode !== undefined) asn.bagCode = bagCode
  if (!asn.skuCode) asn.skuCode = '513211' + Math.floor(540800 + Math.random() * 900)
  asn.labelPrinted = true
  persist('asn_spu_print')
  notify(`SPU 标准型号校验通过（${spu.spuCode}），已出纸打印一物一码机身贴纸 #${asn.skuCode}！`, 'ok')
  return true
}

export function completeAsnPutaway(asn, { scannedSku, scannedBin }) {
  if (!assertRealAllowed()) return false
  if (!asn) return false
  if (asn.status !== 'INSPECTED_WAIT_PUTAWAY') {
    notify('步进式防呆拦截：包裹尚未完成验货，禁止跳过验货直接上架入位！', 'err')
    return false
  }
  if (!asn.spuCode || !asn.labelPrinted) {
    notify('防呆拦截：请先完成第 3 步「SPU 标准型号匹配并打印一物一码机身贴纸」！', 'err')
    return false
  }
  const sSku = (scannedSku || '').trim()
  const sBin = (scannedBin || '').trim().toUpperCase()
  if (sSku !== asn.skuCode) {
    notify(`扫码防呆拦截：扫描的商品码「${sSku || '空'}」与本单机身贴纸「${asn.skuCode}」不一致！`, 'err')
    return false
  }
  const bin = (store.data.locations || []).find(l => l.code === sBin)
  if (!bin) {
    notify(`库位校验拦截：系统中不存在库位编码「${sBin || '空'}」，请扫货架横梁上的标准库位条码！`, 'err')
    return false
  }
  if (!bin.enabled) {
    notify(`库位防呆拦截：库位 ${bin.code} 当前已停用维护，请改扫推荐空库位 ${asn.recommendedBin}！`, 'err')
    return false
  }
  const occ = occupiedSkusOfBin(bin.code).length
  if (occ >= bin.capacity) {
    notify(`库位容量拦截：库位 ${bin.code} 当前已满载（${occ}/${bin.capacity}），请改扫空闲库位！`, 'err')
    return false
  }
  if (bin.binType === 'QUARANTINE') {
    notify(`库区防呆提醒：本件全检全部通过，不应放入 ${bin.code} 异常隔离柜，请扫 A/B 可售货架！`, 'err')
    return false
  }

  asn.status = 'PUTAWAY_DONE'
  asn.putawayBin = bin.code
  const spu = (store.data.spuCatalog || []).find(s => s.spuCode === asn.spuCode)
  const existing = store.data.skus.find(s => s.code === asn.skuCode)
  if (existing) {
    existing.spuCode = asn.spuCode
    existing.conditionGrade = asn.conditionGrade
    existing.location = bin.code
    existing.zone = '已复核可售'
    existing.history.unshift(`11-14 完成 SPU(${asn.spuCode}) 绑定并扫码上架入 ${bin.code}`)
  } else {
    store.data.skus.unshift({
      code: asn.skuCode,
      sn: 'SN-' + asn.skuCode.slice(-6),
      spuCode: asn.spuCode,
      conditionGrade: asn.conditionGrade || '98新·准新',
      brand: spu?.brand || asn.declaredBrand,
      model: spu ? `${spu.model} ${spu.spec.split(' · ').slice(0, 2).join(' ')}` : asn.declaredModel,
      kind: asn.kind || 'monitor',
      zone: '已复核可售',
      location: bin.code,
      ageDays: 0,
      cost: asn.declaredPrice,
      purchaseOrder: asn.poNo,
      inspectId: asn.inspectId || 'INSP-ASN',
      bagCode: asn.bagCode || '标准随件',
      boxCode: '',
      boxStatus: '无原盒',
      realImgCount: 3,
      locImgCount: 1,
      defectImgCount: 0,
      realThumb: makeRealPhoto({ kind: asn.kind || 'monitor', code: asn.skuCode, model: spu?.model || asn.declaredModel, badge: '新上架 ×3' }),
      locThumb: makeLocationPhoto({ loc: bin.code, code: asn.skuCode, bag: asn.bagCode || 'BAG' }),
      defectNote: '标准到货全检通过，已绑定 SPU 扫码上架可售',
      history: [`11-14 采购单 ${asn.poNo} 签收全检通过，绑定 ${asn.spuCode} 扫码上架入 ${bin.code}`]
    })
  }

  if (asn.bagCode) {
    const zipBag = (store.data.packingMaterials || []).find(p => p.code === 'PM-BAG-ZIP')
    if (zipBag && zipBag.stock > 0) zipBag.stock -= 1
  }

  appendStockMovement({
    type: '扫码上架入位',
    skuCode: asn.skuCode,
    model: `${asn.declaredBrand} ${asn.declaredModel}`,
    fromLoc: asn.stagingBin || 'C-01',
    toLoc: bin.code,
    qtyDelta: '+1 可售入库',
    refNo: `${asn.poNo} / ${asn.spuCode}`
  })
  persist('asn_putaway_done')
  notify(`上架成功！单件 #${asn.skuCode} 已绑定库位 ${bin.code} 进入可售总账，同步扣减附件袋耗材并记入流水！`, 'ok')
  return true
}

// ---- 11D. 标准 WMS 库存总账：补绑 SPU、改货号级联留痕、耗材补货、热敏面单打印 ----
export function bindSkuToSpu(sku, spuCode) {
  if (!assertRealAllowed()) return false
  const spu = (store.data.spuCatalog || []).find(s => s.spuCode === spuCode)
  if (!sku || !spu) return false
  if (sku.brand.toLowerCase() !== spu.brand.toLowerCase()) {
    notify(`SPU 匹配防呆拦截：单件品牌「${sku.brand}」与所选 SPU 品牌「${spu.brand}」不一致，禁止错绑！`, 'err')
    return false
  }
  sku.spuCode = spu.spuCode
  sku.history.unshift(`11-14 补绑标准 SPU 编码 ${spu.spuCode}（经办：${currentUser.value.name}）`)
  appendStockMovement({
    type: 'SPU标准挂接',
    skuCode: sku.code,
    model: `${sku.brand} ${sku.model}`,
    fromLoc: sku.location,
    toLoc: sku.location,
    qtyDelta: spu.spuCode,
    refNo: 'SPU字典治理'
  })
  persist('bind_sku_spu')
  notify(`单件 #${sku.code} 已关联标准 SPU「${spu.spuCode}」，已计入 SPU 汇总库存账！`, 'ok')
  return true
}

export function recodePhysicalSku(sku, { newCode, reason }) {
  if (!assertRealAllowed()) return false
  const target = (newCode || '').trim()
  if (!target || target.length < 6) {
    notify('新货号长度不能少于 6 位字符', 'err')
    return false
  }
  if (!reason?.trim()) {
    notify('修改货号必须填写纠偏原因以供审计留痕', 'err')
    return false
  }
  if (sku.zone === '已出库在途') {
    notify('已出库商品严禁修改历史货号！', 'err')
    return false
  }
  if ((store.data.skus || []).some(s => s.code === target)) {
    notify(`唯一性防呆拦截：货号「${target}」在库中已存在，严禁两台实物撞码！`, 'err')
    return false
  }
  const oldCode = sku.code
  sku.code = target
  sku.history.unshift(`11-14 货号纠偏重编：原 #${oldCode} → 新 #${target}（原因：${reason.trim()} · 经办 ${currentUser.value.name}）`)

  // 级联更新关联引用（对齐 erp-miniprogram /inventory/skus/recode）
  for (const m of store.data.mediaTasks || []) { if (m.skuCode === oldCode) m.skuCode = target }
  for (const o of store.data.salesOrderPool || []) { if (o.skuCode === oldCode) o.skuCode = target }
  for (const ob of store.data.outbounds || []) { if (ob.skuCode === oldCode) ob.skuCode = target }
  for (const t of store.data.tasks || []) { if (t.skuCode === oldCode) t.skuCode = target }

  appendStockMovement({
    type: '货号重编留痕',
    skuCode: target,
    model: `${sku.brand} ${sku.model}`,
    fromLoc: `原码 #${oldCode}`,
    toLoc: `新码 #${target}`,
    qtyDelta: '级联更新',
    refNo: reason.trim()
  })
  persist('recode_sku')
  notify(`货号重编完成：#${oldCode} → #${target}，已自动级联同步工单与订单引用并写入审计流水！`, 'ok')
  return true
}

export function restockPackingMaterial(pm, addQty) {
  if (!assertRealAllowed()) return
  const n = Number(addQty || 0)
  if (!pm || n <= 0) return notify('补货数量须大于 0', 'err')
  pm.stock += n
  appendStockMovement({
    type: '包材补货入库',
    skuCode: pm.code,
    model: pm.name,
    fromLoc: '耗材供应商',
    toLoc: pm.loc,
    qtyDelta: `+${n} ${pm.unit}`,
    refNo: 'PM-IN-' + Date.now().toString().slice(-4)
  })
  persist('restock_pack')
  notify(`包材「${pm.name}」已补货 +${n}${pm.unit}，当前库存 ${pm.stock}${pm.unit}`, 'ok')
}

export function printOutboundThermalWaybill(ob) {
  if (!assertRealAllowed()) return false
  if (!ob) return false
  if (ob.addressChanged || ob.status === 'PAUSED_TO_SALES') {
    notify('防呆拦截：该单处于买家改址/瑕疵暂停重核态，禁止打印旧地址电子面单！', 'err')
    return false
  }
  if (!ob.waybillNo?.trim()) {
    ob.waybillNo = 'SF143009' + Math.floor(1000 + Math.random() * 8999)
  }
  ob.waybillPrinted = true
  const lblRoll = (store.data.packingMaterials || []).find(p => p.code === 'PM-LBL-100')
  if (lblRoll && lblRoll.stock > 0 && !ob._rollCounted) {
    ob._rollCounted = true
  }
  persist('print_waybill')
  notify(`已生成三段码热敏电子面单（${ob.waybillNo}），请核对预览联并贴箱！`, 'ok')
  return true
}

// ============ 12. 终极闭环扩展：爱回收式验货提交 + 历史库存四关清零 + WIP工位借还 + 四码出库/红屏拦截归架 + 货架盲盘串位纠偏 ============

export function submitAihuishouInspection(insp, summaryInfo) {
  if (!assertRealAllowed()) return false
  if (!insp.recordingStarted || !insp.playbackVerified) {
    triggerScanFeedback({ code: insp.skuCode, kind: '验货门禁', ok: false, msg: '未完成拆封前录制与3秒回放核验' })
    notify('硬防呆拦截（WH04）：拆封录像尚未完成「结束录制并回放 3 秒确认可读」，禁止提交验货！', 'err')
    return false
  }
  if (summaryInfo.unsetCount > 0) {
    triggerScanFeedback({ code: insp.skuCode, kind: '坏货全检', ok: false, msg: `还有 ${summaryInfo.unsetCount} 步未勾选` })
    notify(`坏货全检拦截：还有 ${summaryInfo.unsetCount} 步未完成实测选择（即使检出碎屏或故障也须把其余适用步测完）！`, 'err')
    return false
  }
  if (!summaryInfo.multiReady) {
    notify('防呆拦截：最后一栏「细分功能情况」请勾选实测异常项，或点击「✓ 已逐一实测以上适用功能均正常」（禁止留空默认正常）！', 'err')
    return false
  }
  if (summaryInfo.invalidUnable) {
    notify(`防呆拦截：「${summaryInfo.invalidUnable}」选了当前无法检测，必须填明原因与补测责任人！`, 'err')
    return false
  }
  if (summaryInfo.defectList.length > 0 && insp.defectPhotos.length === 0) {
    notify(`防呆拦截：共检出 ${summaryInfo.defectList.length} 项明显瑕疵，必须至少拍摄 1 张瑕疵微距特写留证！`, 'err')
    return false
  }
  if (insp.realPhotos.length === 0) {
    notify('防呆拦截：尚未拍摄「本件实拍图」，严禁空图入库！', 'err')
    return false
  }
  if (insp.kind === 'monitor' && summaryInfo.usageMode !== 'SEALED_NEW' && !insp.bagCode?.trim()) {
    notify('显示器防呆拦截：必须填写专用编号附件袋副码（如 BAG-A06-01 或 #BAG）！', 'err')
    return false
  }
  const hasSerious = summaryInfo.hasMismatchOrCrack || summaryInfo.unableCount > 0 || insp.needsSupervisorReview
  if (hasSerious && insp.targetZone === '已复核可售') {
    notify('放行矩阵拦截（G03）：存在货不对版/碎屏/待补测或录像缺口，严禁放入「已复核可售」！请改为异常隔离/待议价/待补测。', 'err')
    return false
  }

  insp.submitted = true
  const summaryText = summaryInfo.defectList.length
    ? `共 ${summaryInfo.defectList.length} 项明显瑕疵：${summaryInfo.defectList.join('；')}`
    : (summaryInfo.usageMode === 'SEALED_NEW' ? '原封未拆防后封4步核验全通（未激活·克重相符）' : '爱回收超集全项实测 0 瑕疵通过')

  const existing = store.data.skus.find(s => s.code === insp.skuCode)
  const bagSub = insp.bagCode ? (insp.bagCode.includes('#') ? insp.bagCode : `${insp.skuCode}#BAG`) : ''
  const boxSub = insp.hasOriginalBox ? `${insp.skuCode}#BOX` : ''
  const histLine = `11-16 完成爱回收式全检(${insp.standardVer})：${summaryText} → 分位 ${insp.locationCode}(${insp.targetZone})`

  if (existing) {
    existing.zone = insp.targetZone
    existing.location = insp.locationCode || existing.location
    existing.conditionGrade = summaryInfo.suggestGrade || existing.conditionGrade
    existing.inspectComplete = true
    existing.fullVideoReady = true
    existing.fullVideoDuration = '02:08'
    existing.realImgCount = Math.max(existing.realImgCount || 0, insp.realPhotos.length)
    existing.locImgCount = Math.max(existing.locImgCount || 0, insp.locationPhotos.length)
    existing.defectImgCount = Math.max(existing.defectImgCount || 0, insp.defectPhotos.length)
    existing.realThumb = insp.realPhotos[0] || existing.realThumb
    existing.locThumb = insp.locationPhotos[0] || existing.locThumb
    if (bagSub) {
      existing.bagCode = insp.bagCode
      existing.bagSubCode = bagSub
      existing.bagBin = 'LPN-BOX-01'
      existing.subCodesBound = true
    }
    existing.defectNote = summaryText
    existing.history.unshift(histLine)
  } else {
    store.data.skus.unshift({
      code: insp.skuCode,
      sn: 'SN-' + insp.skuCode.slice(-6),
      spuCode: (store.data.spuCatalog || []).find(sp => sp.brand.toLowerCase() === insp.brand.toLowerCase())?.spuCode || '',
      conditionGrade: summaryInfo.suggestGrade || '98新·准新',
      brand: insp.brand,
      model: insp.model,
      kind: insp.kind,
      zone: insp.targetZone,
      location: insp.locationCode || 'A-01',
      ageDays: 0,
      cost: insp.declaredPrice,
      purchaseOrder: insp.orderNo,
      inspectId: insp.id,
      bagCode: insp.bagCode || '标准随件',
      boxCode: boxSub,
      boxStatus: insp.hasOriginalBox ? `原盒副码 ${boxSub} 在 E-01` : '无原盒',
      inspectComplete: true,
      fullVideoReady: true,
      fullVideoDuration: '02:08',
      subCodesBound: true,
      bagSubCode: bagSub,
      bagBin: bagSub ? 'LPN-BOX-01' : '',
      boxSubCode: boxSub,
      boxBin: boxSub ? 'E-01' : '',
      realImgCount: insp.realPhotos.length,
      locImgCount: insp.locationPhotos.length,
      defectImgCount: insp.defectPhotos.length,
      realThumb: insp.realPhotos[0] || '',
      locThumb: insp.locationPhotos[0] || '',
      defectNote: summaryText,
      history: [histLine]
    })
  }

  // 同步容器 LPN 袋码
  if (bagSub && store.data.containerLpns?.[0] && !store.data.containerLpns[0].items.includes(bagSub)) {
    store.data.containerLpns[0].items.unshift(bagSub)
  }

  // 同步 ASN 状态
  const asn = (store.data.inboundAsns || []).find(a => a.inspectId === insp.id || a.skuCode === insp.skuCode)
  if (asn && asn.status === 'SIGNED_IN_INSPECT') {
    asn.status = 'INSPECTED_WAIT_PUTAWAY'
    asn.inspectSummary = `✓ ${summaryText}`
  }

  // 若存在货不对版或严重未申报碎屏，自动立项10分钟异常响应
  if (summaryInfo.hasMismatchOrCrack && !store.data.anomalies.some(a => a.skuCode === insp.skuCode)) {
    store.data.anomalies.unshift({
      id: 'ANO-' + (2610 + store.data.anomalies.length),
      type: 'GOODS_DIFF',
      skuCode: insp.skuCode,
      orderNo: insp.orderNo,
      title: `${insp.brand} ${insp.model} · ${summaryText}`,
      purchaser: insp.purchaser,
      carrier: insp.waybill,
      targetStation: '原发件揽收网点',
      firstFoundAt: '2026-11-16 ' + new Date().toTimeString().slice(0, 8),
      remainingSec: 600,
      retryCount: 0,
      fullInspectDone: true,
      fullInspectProgress: '爱回收式全检已完成留证',
      isolationLocked: true,
      tracks: {
        courier: { sentAt: '刚刚', deliveredAt: '刚刚', acceptedAt: '', station: '原发件网点', receipt: '待快递员登记拒签', done: false },
        notifyPurchaser: { sentAt: '刚刚', deliveredAt: '刚刚', acceptedAt: '', diffSummary: summaryText, done: true },
        purchaserProof: { submittedAt: '', voucher: '', verifiedReadable: false, escalated: false, assignee: insp.purchaser, done: false }
      },
      goodsSteps: [
        { key: 'full_inspect', label: '1. 全检完成待交回', done: true, note: summaryText },
        { key: 'reject_accept', label: '2. 承运方拒签受理', done: false, note: '联系快递中' },
        { key: 'return_waybill', label: '3. 退回运单在途', done: false, note: '待揽收' },
        { key: 'station_arrive', label: '4. 到达原发件网点', done: false, note: '待在途更新' },
        { key: 'station_sign', label: '5. 网点签收回执', done: false, note: '未签收不算完结' }
      ],
      moneySteps: [
        { key: 'apply', label: '1. 采购首轮退款申请', done: false, note: '10分钟倒计时中' },
        { key: 'accept', label: '2. 卖家/平台受理', done: false, note: '' },
        { key: 'arrive', label: '3. 实际到账核销', done: false, note: `原采购款 ¥${insp.declaredPrice}` },
        { key: 'diff_audit', label: '4. 运费与差额对账', done: false, note: '' },
        { key: 'close', label: '5. 货钱双清结案', done: false, note: '' }
      ],
      keepGoodsSwitch: null
    })
  }

  appendStockMovement({
    type: '爱回收式全检归档',
    skuCode: insp.skuCode,
    model: `${insp.brand} ${insp.model}`,
    fromLoc: '验货工位',
    toLoc: `${insp.locationCode}(${insp.targetZone})`,
    qtyDelta: summaryInfo.suggestGrade || '已验入档',
    refNo: insp.id
  })
  triggerScanFeedback({ code: insp.skuCode, kind: '验货归档', ok: true, msg: summaryText })
  persist('submit_ahs_inspect')
  notify(`验货报告已归档！输出结论：「${summaryText}」，已同步库存画廊与上下游台账！`, 'ok')
  return true
}

// ---- 历史库存清洗 Gallery 当日清零 4 关动作 ----
export function openOrCreateLegacyInspection(sku) {
  if (!assertRealAllowed()) return
  if (!sku) return
  let targetInsp = store.data.inspections.find(i => i.skuCode === sku.code || i.id === sku.inspectId)
  if (!targetInsp) {
    const newId = 'INSP-WASH-' + sku.code.slice(-4)
    const stdId = sku.kind === 'phone' ? 'STD-PHONE' : sku.kind === 'audio' ? 'STD-AUDIO' : sku.kind === 'camera' ? 'STD-CAM' : 'STD-MON'
    targetInsp = {
      id: newId,
      orderNo: sku.purchaseOrder || ('LEGACY-' + sku.code),
      skuCode: sku.code,
      brand: sku.brand,
      model: sku.model,
      kind: sku.kind || 'monitor',
      standardId: stdId,
      standardVer: 'v3.0-AHS',
      waybill: '历史存量清零补检',
      purchaser: '历史存量结转（当日清零）',
      declaredPrice: sku.cost,
      declaredSpec: `原在库货号 #${sku.code}（库位 ${sku.location}）· 补做爱回收式结构化全检解锁销售上架`,
      recall24h: true,
      cameraChecked: true,
      recordingStarted: true,
      recordingStartedAt: new Date().toTimeString().slice(0, 8),
      recordingFinished: false,
      playbackVerified: false,
      interruptGap: '',
      needsSupervisorReview: false,
      bagCode: sku.bagCode || `${sku.code}#BAG`,
      hasOriginalBox: Boolean(sku.boxCode),
      boxCode: sku.boxCode || '',
      locationCode: sku.location || 'A-08',
      targetZone: '已复核可售',
      unboxPreview: makeUnboxFrame({ code: sku.code, waybill: '历史库存补检实录', recording: true, stage: '历史存量机补做爱回收式分步全检与实测录像' }),
      realPhotos: sku.realThumb ? [sku.realThumb] : [makeRealPhoto({ kind: sku.kind || 'phone', code: sku.code, model: sku.model, badge: '现场补拍实拍' })],
      defectPhotos: [],
      locationPhotos: sku.locThumb ? [sku.locThumb] : [makeLocationPhoto({ loc: sku.location || 'A-08', code: sku.code, bag: `${sku.code}#BAG` })],
      results: {},
      ahsAnswers: { usage_mode: { val: 'USED_OK', note: '开机正常进入系统' } },
      ahsMultiFaults: [],
      ahsMultiConfirmed: false,
      submitted: false
    }
    store.data.inspections.unshift(targetInsp)
    sku.inspectId = newId
    persist('create_legacy_insp')
  }
  go('inspect', targetInsp.id)
}

export function completeLegacyFullVideo(sku, duration = '01:54') {
  if (!assertRealAllowed()) return
  if (!sku) return
  sku.fullVideoReady = true
  sku.fullVideoDuration = duration
  sku.history.unshift(`11-16 现场补录完整通电实测视频（时长 ${duration}，已回放3秒确认画面声音清晰可读）`)
  if (sku.inspectComplete !== false && sku.realImgCount > 0 && sku.spuCode && sku.zone === '待补证/待补测') {
    sku.zone = '已复核可售'
  }
  appendStockMovement({
    type: '补录完整实测视频',
    skuCode: sku.code,
    model: `${sku.brand} ${sku.model}`,
    fromLoc: sku.location,
    toLoc: sku.location,
    qtyDelta: `视频 ${duration}`,
    refNo: '历史阻塞清零'
  })
  triggerScanFeedback({ code: sku.code, kind: '视频核验', ok: true, msg: `完整实测原片 ${duration} 已入库` })
  persist('legacy_video_ok')
  notify(`单件 #${sku.code} 完整通电实测视频（${duration}）已回放确认入库，客服随时可发给买家看机！`, 'ok')
}

export function completeLegacyPhotos(sku) {
  if (!assertRealAllowed()) return
  if (!sku) return
  sku.realImgCount = Math.max(4, sku.realImgCount || 0)
  sku.locImgCount = Math.max(1, sku.locImgCount || 0)
  sku.realThumb = makeRealPhoto({ kind: sku.kind || 'monitor', code: sku.code, model: `${sku.brand} ${sku.model}`, badge: `本件实拍 ×${sku.realImgCount}` })
  sku.locThumb = makeLocationPhoto({ loc: sku.location || 'A-08', code: sku.code, bag: sku.bagCode || `${sku.code}#BAG` })
  for (const mt of store.data.mediaTasks || []) {
    if (mt.skuCode === sku.code) mt.done = true
  }
  if (sku.inspectComplete !== false && sku.fullVideoReady !== false && sku.spuCode && sku.zone === '待补证/待补测') {
    sku.zone = '已复核可售'
  }
  sku.history.unshift(`11-16 现场补齐本机实拍图 ×${sku.realImgCount} 与库位同框图（经办：${currentUser.value.name}）`)
  triggerScanFeedback({ code: sku.code, kind: '补拍完成', ok: true, msg: '实拍图与库位图已归槽' })
  persist('legacy_photo_ok')
  notify(`单件 #${sku.code} 本机实拍图与库位同框图已现场补齐！`, 'ok')
}

export function completeLegacySpuAndSubcodes(sku, { spuCode, binCode, lpnCode }) {
  if (!assertRealAllowed()) return false
  if (!sku) return false
  const targetSpu = spuCode || sku.spuCode
  const spu = (store.data.spuCatalog || []).find(s => s.spuCode === targetSpu)
  if (!spu) {
    notify('请先选择匹配的标准 SPU 型号编码！', 'err')
    return false
  }
  if (spu.brand.toLowerCase() !== sku.brand.toLowerCase()) {
    triggerScanFeedback({ code: targetSpu, kind: 'SPU防混', ok: false, msg: '跨品牌错绑拦截' })
    notify(`SPU 防呆拦截：商品品牌「${sku.brand}」与所选 SPU「${spu.brand}」不一致！`, 'err')
    return false
  }
  const targetBin = (binCode || sku.location || 'A-08').trim().toUpperCase()
  const targetLpn = lpnCode || 'LPN-BOX-01'
  sku.spuCode = spu.spuCode
  sku.location = targetBin
  sku.subCodesBound = true
  sku.bagSubCode = `${sku.code}#BAG`
  sku.bagBin = targetLpn
  sku.bagCode = sku.bagCode || sku.bagSubCode
  if (sku.boxCode) {
    sku.boxSubCode = `${sku.code}#BOX`
    sku.boxBin = 'E-01'
    sku.boxStatus = `原盒副码 ${sku.boxSubCode} 存 E-01`
  }
  const lpnObj = (store.data.containerLpns || []).find(c => c.lpnCode === targetLpn)
  if (lpnObj && !lpnObj.items.includes(sku.bagSubCode)) {
    lpnObj.items.unshift(sku.bagSubCode)
  }
  if (sku.inspectComplete !== false && sku.fullVideoReady !== false && sku.realImgCount > 0 && sku.zone === '待补证/待补测') {
    sku.zone = '已复核可售'
    sku.conditionGrade = sku.conditionGrade.replace('历史结转·', '').replace('待补全检与视频', '95新·全检可售').replace('三缺阻塞', '95新·全检可售')
  }
  sku.history.unshift(`11-16 补绑 ${spu.spuCode}，打印主机码 + 副码 ${sku.bagSubCode}(入 ${targetLpn})，落位 ${targetBin}`)
  appendStockMovement({
    type: '子母码赋码入位',
    skuCode: sku.code,
    model: `${sku.brand} ${sku.model}`,
    fromLoc: '历史待整顿',
    toLoc: `${targetBin} + ${targetLpn}`,
    qtyDelta: spu.spuCode,
    refNo: sku.bagSubCode
  })
  triggerScanFeedback({ code: sku.bagSubCode, kind: '子母码绑定', ok: true, msg: `主件 ${targetBin} / 副码 ${targetLpn}` })
  persist('legacy_spu_subcode')
  notify(`单件 #${sku.code} 已绑定 SPU、打印 #BAG 子母副码入 ${targetLpn} 并确认库位 ${targetBin}！`, 'ok')
  return true
}

// ---- 库内 WIP 工位借出 / 暂离挂名与扫码归架（货动码必动） ----
export function activeWipBorrowOfSku(skuCode) {
  return (store.data.wipBorrows || []).find(b => b.skuCode === skuCode && b.status === 'BORROWED') || null
}

export function checkoutSkuToWip({ skuCode, wipCode, borrower, purpose }) {
  if (!assertRealAllowed()) return false
  const code = (skuCode || '').trim()
  const sku = store.data.skus.find(s => s.code === code)
  if (!sku) {
    triggerScanFeedback({ code, kind: '工位借出', ok: false, msg: '未找到该在库货号' })
    notify(`未找到在库单件「${code}」`, 'err')
    return false
  }
  if (activeWipBorrowOfSku(code)) {
    triggerScanFeedback({ code, kind: '工位借出', ok: false, msg: '该件已在借出状态中' })
    notify(`单件 #${code} 当前已被借出在工位，请先归架再重借！`, 'err')
    return false
  }
  const st = (store.data.wipStations || []).find(w => w.code === wipCode) || { code: wipCode || 'WIP-PHOTO-01', name: '摄影补图工位' }
  if (!Array.isArray(store.data.wipBorrows)) store.data.wipBorrows = []
  store.data.wipBorrows.unshift({
    id: 'WIP-BRW-' + Date.now().toString().slice(-4),
    skuCode: sku.code,
    model: `${sku.brand} ${sku.model}`,
    fromBin: sku.location,
    wipCode: st.code,
    wipName: st.name,
    borrower: (borrower || currentUser.value.name).trim(),
    purpose: (purpose || '补拍细节/接口复测').trim(),
    borrowedAt: new Date().toTimeString().slice(0, 5),
    elapsedMin: 1,
    status: 'BORROWED'
  })
  sku.history.unshift(`11-16 扫码暂借出架：${sku.location} → ${st.code}（借用人：${borrower || currentUser.value.name} · ${purpose || '工位协同'}）`)
  appendStockMovement({
    type: '库内工位暂借',
    skuCode: sku.code,
    model: `${sku.brand} ${sku.model}`,
    fromLoc: sku.location,
    toLoc: st.code,
    qtyDelta: '暂借挂名',
    refNo: `${borrower || currentUser.value.name}`
  })
  triggerScanFeedback({ code: `${sku.code} → ${st.code}`, kind: 'WIP暂借', ok: true, msg: `挂名：${borrower || currentUser.value.name}` })
  persist('wip_checkout')
  notify(`已登记工位暂借：#${sku.code} 挂至「${st.code} · ${borrower || currentUser.value.name}」名下，销售/客服前台实时可见！`, 'ok')
  return true
}

export function returnSkuFromWip(brw, scannedBin) {
  if (!assertRealAllowed()) return false
  if (!brw || brw.status !== 'BORROWED') return false
  const cleanBin = (scannedBin || brw.fromBin || '').trim().toUpperCase().replace(/^LOC-/, '')
  if (cleanBin !== brw.fromBin) {
    triggerScanFeedback({ code: cleanBin, kind: '归架核验', ok: false, msg: `应扫原储位 ${brw.fromBin}` })
    notify(`归架防串位拦截：该单件原储位为「${brw.fromBin}」，请扫回原库位码 LOC-${brw.fromBin}（如需换位请走移库）！`, 'err')
    return false
  }
  brw.status = 'RETURNED'
  brw.returnedAt = new Date().toTimeString().slice(0, 5)
  const sku = store.data.skus.find(s => s.code === brw.skuCode)
  if (sku) {
    sku.history.unshift(`11-16 工位用毕扫码归架：${brw.wipCode} → ${brw.fromBin}（销账完成）`)
  }
  appendStockMovement({
    type: '工位暂借归架',
    skuCode: brw.skuCode,
    model: brw.model,
    fromLoc: brw.wipCode,
    toLoc: brw.fromBin,
    qtyDelta: '归位销账',
    refNo: brw.id
  })
  triggerScanFeedback({ code: `${brw.skuCode} → ${brw.fromBin}`, kind: '扫码归架', ok: true, msg: '实物已归还原货架' })
  persist('wip_return')
  notify(`单件 #${brw.skuCode} 已扫码归还至原库位 ${brw.fromBin}，工位挂名已销账！`, 'ok')
  return true
}

// ---- 打包台「主码+#BAG+#BOX+原厂SN」四码逐一扫绿 + 拣货后紧急拦截红屏归架 ----
export function ensureOutboundScanChecks(ob) {
  if (!ob) return {}
  if (!ob.scanChecks) {
    ob.scanChecks = {
      host: { code: ob.skuCode, label: '主机一物一码', loc: ob.locationCode || 'A-02', scanned: Boolean(ob.scanVerified) },
      bag: { code: `${ob.skuCode}#BAG`, label: '附件袋副码', loc: 'LPN-BOX-01', scanned: Boolean(ob.kitBagChecked) },
      box: { code: `${ob.skuCode}#BOX`, label: '原盒/合单副码', loc: 'E-01', scanned: Boolean(ob.kitBoxChecked) },
      sn: { code: ob.sn || ('SN-' + ob.skuCode.slice(-6)), label: '机身原厂 SN', loc: '机身铭牌', scanned: Boolean(ob.scanVerified) }
    }
  }
  return ob.scanChecks
}

export function scanOutboundMultiCode(ob, rawCode) {
  if (!assertRealAllowed()) return false
  if (!ob) return false
  const clean = String(rawCode || '').trim()
  if (!clean) return notify('请用激光扫码枪扫描主机码、#BAG副码、#BOX副码或机身SN', 'err')

  // 1. 拣货后买家突然退单/改址：打包台扫码瞬间触发红屏蜂鸣强阻断 + 生成待归架单！
  if (ob.emergencyIntercept || ob.addressChanged || ob.status === 'BLOCKED_NEW_ISSUE') {
    ob.emergencyAlertTriggered = true
    ob.scannedCode = clean
    triggerScanFeedback({
      code: clean,
      kind: '🚨紧急拦截',
      ok: false,
      msg: `订单 ${ob.orderNo} 已被紧急拦截！严禁贴单封箱，请执行退回原库位 ${ob.returnShelfBin || ob.locationCode}！`
    })
    persist('outbound_emergency_block')
    notify(`🚨 紧急拦截警报：订单 ${ob.orderNo} 买家刚发起改址/退款拦截，打包台已锁死！请按下方归架单扫回原库位 ${ob.returnShelfBin || ob.locationCode}！`, 'err')
    return false
  }

  const checks = ensureOutboundScanChecks(ob)
  const hitKey = Object.keys(checks).find(k => checks[k] && checks[k].code.toUpperCase() === clean.toUpperCase())
  if (!hitKey) {
    ob.scannedCode = clean
    ob.scanVerified = false
    triggerScanFeedback({
      code: clean,
      kind: '串件拦截',
      ok: false,
      msg: `非本单锁定编码（应扫 ${ob.skuCode} 及其子母码）`
    })
    persist('outbound_wrong_code')
    notify(`✕ 串件硬拦截：刚扫的「${clean}」不属于订单 ${ob.orderNo} 的主副码或原厂 SN，严禁混装出库！`, 'err')
    return false
  }

  checks[hitKey].scanned = true
  ob.scannedCode = clean
  ob.kitHostChecked = Boolean(checks.host?.scanned)
  ob.kitBagChecked = Boolean(!checks.bag || checks.bag.scanned)
  ob.kitBoxChecked = Boolean(!checks.box || checks.box.scanned)
  ob.scanVerified = Object.values(checks).every(c => !c || c.scanned)

  const leftCount = Object.values(checks).filter(c => c && !c.scanned).length
  triggerScanFeedback({
    code: clean,
    kind: checks[hitKey].label,
    ok: true,
    msg: leftCount === 0 ? '✓ 主副码+原厂SN四码全绿齐套！' : `已核销，还剩 ${leftCount} 个码待扫`
  })
  persist('outbound_multicode_ok')
  notify(
    leftCount === 0
      ? `✓ 订单 ${ob.orderNo}「主机码 + #BAG附件袋 + #BOX原盒 + 原厂SN」全部扫绿齐套，已解锁打单出库！`
      : `✓ 已扫绿「${checks[hitKey].label}」，还差 ${leftCount} 项副码/SN 待扫`,
    'ok'
  )
  return true
}

export function completeInterceptReturnToShelf(ob, { scannedSku, scannedBin }) {
  if (!assertRealAllowed()) return false
  if (!ob) return false
  const targetBin = (ob.returnShelfBin || ob.locationCode || 'A-10').toUpperCase()
  const sSku = String(scannedSku || '').trim()
  const sBin = String(scannedBin || '').trim().toUpperCase().replace(/^LOC-/, '')
  if (sSku !== ob.skuCode) {
    triggerScanFeedback({ code: sSku, kind: '归架核验', ok: false, msg: `商品码不符，应扫 ${ob.skuCode}` })
    notify(`归架扫码错误：请扫描被拦截实物本机货号「${ob.skuCode}」`, 'err')
    return false
  }
  if (sBin !== targetBin) {
    triggerScanFeedback({ code: sBin, kind: '归架核验', ok: false, msg: `库位不符，应扫原位 LOC-${targetBin}` })
    notify(`归架库位错误：请将该商品放回原储位并扫描「LOC-${targetBin}」！`, 'err')
    return false
  }

  ob.returnedToShelf = true
  ob.emergencyIntercept = false
  ob.addressChanged = false
  ob.status = 'RETURNED_TO_SHELF'
  const sku = store.data.skus.find(s => s.code === ob.skuCode)
  if (sku) {
    sku.zone = '已复核可售'
    sku.location = targetBin
    sku.history.unshift(`11-16 打包台拦截件已双扫码退回原储位 ${targetBin}，解除锁库恢复可售`)
  }
  const ord = (store.data.salesOrderPool || []).find(o => o.externalOrderNo === ob.orderNo)
  if (ord) {
    ord.aggState = 'CANCELLED_RELEASED'
    ord.holdType = ''
    ord.holdReason = `打包台扫码拦截后实物已归回 ${targetBin}`
  }
  appendStockMovement({
    type: '拦截件扫码归架',
    skuCode: ob.skuCode,
    model: ob.model,
    fromLoc: '打包复核台',
    toLoc: `${targetBin}(恢复可售)`,
    qtyDelta: '释放归位 1',
    refNo: ob.orderNo
  })
  triggerScanFeedback({ code: `${ob.skuCode} → ${targetBin}`, kind: '拦截归架完成', ok: true, msg: '库存已恢复可售' })
  persist('intercept_return_done')
  notify(`✓ 拦截件 #${ob.skuCode} 已扫码归回原货架 ${targetBin}，订单锁已释放，杜绝桌底积压黑货！`, 'ok')
  return true
}

// ---- 权责分离「货架盲盘 + 10分钟循环微盘 + 串位一键纠偏」 ----
export function createShelfBlindSession({ rack = 'A2排', mode = '单排货架10分钟微盘' }) {
  if (!assertRealAllowed()) return null
  const bins = (store.data.locations || []).filter(l => l.rack === rack && l.enabled).map(l => l.code)
  if (!bins.length) {
    notify(`未找到排架 ${rack} 下的启用格口`, 'err')
    return null
  }
  const scannedByBin = {}
  bins.forEach(b => { scannedByBin[b] = [] })
  const sess = {
    id: `CYC-20261116-${rack.replace('排', '')}-${Date.now().toString().slice(-2)}`,
    title: `${rack}货架 · ${mode}（盲盘权责分离）`,
    mode,
    targetRack: rack,
    targetBins: bins,
    createdAt: new Date().toTimeString().slice(0, 8),
    executor: currentUser.value.name,
    phase: 'BLIND_SCANNING',
    currentBin: bins[0],
    scannedByBin,
    diffItems: []
  }
  if (!Array.isArray(store.data.blindCycleSessions)) store.data.blindCycleSessions = []
  store.data.blindCycleSessions.unshift(sess)
  persist('create_blind_session')
  notify(`已新建微盘点任务 ${sess.id}（共 ${bins.length} 个储位，盲盘模式下账面数已自动隐藏）！`, 'ok')
  return sess
}

export function scanBlindBinOrSku(sess, rawInput) {
  if (!assertRealAllowed()) return false
  if (!sess || sess.phase !== 'BLIND_SCANNING') return false
  const clean = String(rawInput || '').trim()
  if (!clean) return false

  const maybeBin = clean.toUpperCase().replace(/^LOC-/, '')
  if (sess.targetBins.includes(maybeBin)) {
    sess.currentBin = maybeBin
    triggerScanFeedback({ code: `LOC-${maybeBin}`, kind: '切换盲盘储位', ok: true, msg: `当前正在盲盘 ${maybeBin}` })
    persist('blind_switch_bin')
    notify(`已定位至储位 ${maybeBin}，请逐件扫描该格口内实物条码`, 'ok')
    return true
  }
  if ((store.data.locations || []).some(l => l.code === maybeBin)) {
    triggerScanFeedback({ code: `LOC-${maybeBin}`, kind: '非本单范围', ok: false, msg: `${maybeBin} 不在本次 ${sess.targetRack} 微盘范围内` })
    notify(`储位 ${maybeBin} 不属于本次 ${sess.targetRack} 微盘范围（目标格：${sess.targetBins.join('、')}）`, 'err')
    return false
  }

  const curBin = sess.currentBin || sess.targetBins[0]
  if (!sess.scannedByBin[curBin]) sess.scannedByBin[curBin] = []
  // 若该码在同盘其他格扫过，自动移到最新实扫格
  for (const b of sess.targetBins) {
    if (b !== curBin && sess.scannedByBin[b]) {
      sess.scannedByBin[b] = sess.scannedByBin[b].filter(x => x !== clean)
    }
  }
  if (!sess.scannedByBin[curBin].includes(clean)) {
    sess.scannedByBin[curBin].push(clean)
  }
  triggerScanFeedback({ code: clean, kind: `盲盘实扫@${curBin}`, ok: true, msg: `${curBin} 已实扫 ${sess.scannedByBin[curBin].length} 件` })
  persist('blind_scan_item')
  return true
}

export function simulateScanShelfA04WithMisplaced(sess) {
  if (!assertRealAllowed() || !sess) return
  if (sess.targetBins.includes('A-04')) {
    sess.currentBin = 'A-04'
    sess.scannedByBin['A-04'] = ['513211540026', '513211540310']
    triggerScanFeedback({ code: 'A-04 实扫×2', kind: '激光快扫完成', ok: true, msg: '扫入 #513211540026 与 #513211540310' })
    persist('sim_blind_a04')
    notify('已模拟用激光头扫完 A-04 格口内全部 2 台显示器实物，现在可点「提交盲盘实扫结果」揭晓比对！', 'ok')
  } else {
    // 通用排架自动把账面在架实物填入
    for (const b of sess.targetBins) {
      sess.scannedByBin[b] = (store.data.skus || []).filter(s => s.location === b && !activeWipBorrowOfSku(s.code)).map(s => s.code)
    }
    triggerScanFeedback({ code: `${sess.targetRack} 实扫完成`, kind: '激光快扫', ok: true, msg: '已完成排架逐格盲扫' })
    persist('sim_blind_generic')
    notify(`已完成 ${sess.targetRack} 各格口实物盲扫，请点提交查看比对结果！`, 'ok')
  }
}

export function submitBlindSessionAndCompare(sess) {
  if (!assertRealAllowed() || !sess) return
  const diffs = []
  const allScannedPairs = []
  for (const bin of sess.targetBins) {
    for (const code of (sess.scannedByBin[bin] || [])) {
      allScannedPairs.push({ bin, code })
    }
  }
  const scannedSet = new Set(allScannedPairs.map(p => p.code))

  // 1. 检查实扫到的每一件：是账实相符、串位，还是盘盈未知码？
  for (const { bin, code } of allScannedPairs) {
    const sku = store.data.skus.find(s => s.code === code)
    if (!sku) {
      diffs.push({
        id: `BD-${code}`,
        kind: 'SURPLUS',
        skuCode: code,
        model: '账外未登记实物（疑似漏入库）',
        bookBin: '无账面记录',
        actualBin: bin,
        resolved: false,
        note: '需转收货验货台核实来源补建档'
      })
    } else if (sku.location !== bin) {
      diffs.push({
        id: `BD-${code}`,
        kind: 'MISPLACED',
        skuCode: code,
        model: `${sku.brand} ${sku.model}`,
        bookBin: sku.location,
        actualBin: bin,
        resolved: false,
        note: `串位识别：系统账记在 ${sku.location}，现场在 ${bin} 扫出实物（不算丢货，可一键扫码纠偏库位）`
      })
    } else {
      diffs.push({
        id: `BD-${code}`,
        kind: 'MATCH',
        skuCode: code,
        model: `${sku.brand} ${sku.model}`,
        bookBin: bin,
        actualBin: bin,
        resolved: true,
        note: '账位与实物 100% 一致'
      })
    }
  }

  // 2. 检查账面记在本排架、但现场没扫到的单件（区分 WIP 工位暂借豁免 vs 真盘亏）
  const bookInRack = (store.data.skus || []).filter(s => sess.targetBins.includes(s.location) && s.zone !== '已出库在途')
  for (const sku of bookInRack) {
    if (!scannedSet.has(sku.code)) {
      const wip = activeWipBorrowOfSku(sku.code)
      if (wip) {
        diffs.push({
          id: `BD-${sku.code}`,
          kind: 'WIP_EXEMPT',
          skuCode: sku.code,
          model: `${sku.brand} ${sku.model}`,
          bookBin: sku.location,
          actualBin: `${wip.wipCode}（${wip.borrower} 暂借中）`,
          resolved: true,
          note: `工位借出自动对冲：${wip.borrowedAt} 由 ${wip.borrower} 扫码借至 ${wip.wipName}，非盘亏！`
        })
      } else {
        diffs.push({
          id: `BD-${sku.code}`,
          kind: 'SHORTAGE',
          skuCode: sku.code,
          model: `${sku.brand} ${sku.model}`,
          bookBin: sku.location,
          actualBin: '现场未扫出',
          resolved: false,
          note: '疑似漏扫或串至其他排架，需复查监控并交仓管主管审批'
        })
      }
    }
  }

  sess.diffItems = diffs
  sess.phase = 'DIFF_RECONCILE'
  persist('submit_blind_compare')
  const misCnt = diffs.filter(d => d.kind === 'MISPLACED').length
  const shortCnt = diffs.filter(d => d.kind === 'SHORTAGE').length
  notify(`盲盘实扫已提交并揭晓账面快照：发现串位 ${misCnt} 件、疑似短少 ${shortCnt} 件！`, misCnt || shortCnt ? 'info' : 'ok')
}

export function fixMisplacedSkuOneClick(sess, diffItem) {
  if (!assertRealAllowed() || !diffItem) return
  const sku = store.data.skus.find(s => s.code === diffItem.skuCode)
  if (!sku) return
  const oldLoc = sku.location
  sku.location = diffItem.actualBin
  sku.locThumb = makeLocationPhoto({ loc: diffItem.actualBin, code: sku.code, bag: sku.bagCode })
  sku.history.unshift(`11-16 盲盘串位一键纠偏：账面 ${oldLoc} → 实盘在位 ${diffItem.actualBin}（盘点单 ${sess.id}）`)
  diffItem.resolved = true
  diffItem.note = `✓ 已扫码纠偏库位至 ${diffItem.actualBin} 并写入移库流水（账实已对齐）`
  appendStockMovement({
    type: '盲盘串位纠偏',
    skuCode: sku.code,
    model: diffItem.model,
    fromLoc: oldLoc,
    toLoc: diffItem.actualBin,
    qtyDelta: '库位对齐',
    refNo: sess.id
  })
  triggerScanFeedback({ code: `${sku.code}@${diffItem.actualBin}`, kind: '串位已纠偏', ok: true, msg: `${oldLoc} → ${diffItem.actualBin}` })
  persist('fix_misplaced')
  notify(`串位已纠偏！单件 #${sku.code} 账面库位已从 ${oldLoc} 更新为实盘位置 ${diffItem.actualBin}！`, 'ok')
}

export function approveAndCloseBlindSession(sess) {
  if (!sess) return
  const hasShortage = (sess.diffItems || []).some(d => (d.kind === 'SHORTAGE' || d.kind === 'SURPLUS') && !d.resolved)
  if (hasShortage && !isSupervisor.value) {
    notify('权责分离拦截：存在盘亏/盘盈差异时，普通仓管员无权结案，须切换「周卫东（仓管主管）」审批结案！', 'err')
    return
  }
  const unresolvedMisplaced = (sess.diffItems || []).find(d => d.kind === 'MISPLACED' && !d.resolved)
  if (unresolvedMisplaced) {
    notify(`请先点「一键扫码纠偏库位」处理完串位商品 #${unresolvedMisplaced.skuCode}！`, 'err')
    return
  }
  for (const d of sess.diffItems || []) d.resolved = true
  sess.phase = 'CLOSED'
  sess.closedBy = currentUser.value.name + ' ' + new Date().toTimeString().slice(0, 5)
  persist('close_blind_session')
  notify(`微盘点任务 ${sess.id} 已全部对齐归档结案！`, 'ok')
}

// ---- 17. 到货快递驻点协调 · 10×N分钟全检显示拒签 · 17:00去留清零 · 10分钟站点召回 · 企微微信群直连 ----
export function appendWecomFeed({ dir = 'OUT_BOT', tag = '企微推送', sender = '泛亚仓管企微机器人', mention = '', content = '' }) {
  const cc = store.data.courierCoord
  if (!cc) return
  if (!Array.isArray(cc.wecomFeed)) cc.wecomFeed = []
  cc.wecomFeed.unshift({
    id: 'WC-' + Date.now().toString().slice(-4),
    time: new Date().toTimeString().slice(0, 8),
    dir,
    tag,
    sender,
    mention,
    content
  })
}

export function createCourierArrivalBatch({ carrier = '顺丰速运', courierName = '王建军（顺丰驻点）', courierWechat = '@顺丰-王建军(138****5520)', parcelCount = 10 }) {
  if (!assertRealAllowed()) return null
  const cc = store.data.courierCoord
  if (!cc) return null
  const n = Math.max(1, Math.min(30, Number(parcelCount) || 10))
  const slaMin = n * 10
  const nowHm = new Date().toTimeString().slice(0, 5)
  const batchId = `CBAT-261117-0${(cc.batches?.length || 0) + 1}`
  const parcels = Array.from({ length: n }, (_, idx) => ({
    trackingNo: `${carrier.startsWith('京东') ? 'JDVA302' : 'SF14300'}${String(100 + idx)}`,
    model: idx === 0 ? '演示新到货 · 待高拍仪拆封验货第 1 票' : `同批次待验快件 #${idx + 1}`,
    purchaser: idx % 2 === 0 ? '李明' : '王芳',
    inspectDone: false,
    hasIssue: false,
    issueSummary: '待拆封全检',
    trajectoryState: 'UNDECIDED',
    note: `须在 ${slaMin} 分钟内验完并反馈签收或拒签`
  }))
  const newBatch = {
    id: batchId,
    carrier,
    courierName,
    courierWechat,
    arrivedAt: nowHm,
    parcelCount: n,
    slaMinutes: slaMin,
    remainingSec: slaMin * 60,
    status: 'IN_PROGRESS',
    parcels
  }
  cc.batches.unshift(newBatch)
  appendWecomFeed({
    dir: 'OUT_BOT',
    tag: `批次${slaMin}分钟开表`,
    mention: courierWechat,
    content: `【新批次到货开表】${carrier}批次 ${batchId} 共送达 ${n} 票，系统已开启 ${slaMin} 分钟（${n}票×10分钟）全检倒计时！请驻点业务员暂勿提前扫本人签收，有问题件我们将第一时间推群挂「显示拒签」供采购议价！`
  })
  triggerScanFeedback({ code: `${batchId} (${n}票=${slaMin}m)`, kind: '快递批次开表', ok: true, msg: '已同步企微微信互通群' })
  persist('courier_batch_create')
  notify(`已登记到货批次 ${batchId}：共 ${n} 票，硬时效 ${slaMin} 分钟内完成全检与显示拒签！已推企微群。`, 'ok')
  return newBatch
}

export function syncParcelRefusalToWecom(batch, parcel) {
  if (!assertRealAllowed() || !batch || !parcel) return
  parcel.inspectDone = true
  parcel.hasIssue = true
  parcel.trajectoryState = 'REFUSED_SHOWN'
  parcel.note = '✓ 已推企微群督办并回读官方物流轨迹显示「拒签·留站待议价」，采购已可凭拒签向卖家议价'
  appendWecomFeed({
    dir: 'OUT_BOT',
    tag: '挂拒签供议价',
    mention: batch.courierWechat,
    content: `【验货异常·请立即巴枪挂显示拒签】批次 ${batch.id} 运单 ${parcel.trackingNo}（${parcel.model}）检出：${parcel.issueSummary}。请立即在巴枪挂「客户拒签-留站暂缓退回」，确保官方轨迹显示拒签供采购 ${parcel.purchaser} 向卖家议价（17:00前给最终去留）！`
  })
  appendWecomFeed({
    dir: 'IN_COURIER',
    tag: '微信群回调回执',
    sender: `${batch.courierName.split('（')[0]}（微信互通）`,
    content: `收到！${parcel.trackingNo} 已在巴枪挂上【拒签-留站待协商】，物流轨迹已实时显示拒签！`
  })
  if (batch.parcels.every(p => p.inspectDone && (p.trajectoryState === 'SIGNED_OK' || p.trajectoryState === 'REFUSED_SHOWN'))) {
    batch.status = 'COMPLETED'
  }
  triggerScanFeedback({ code: parcel.trackingNo, kind: '轨迹已挂拒签', ok: true, msg: '采购可凭拒签向卖家压价议价' })
  persist('courier_sync_refusal')
  notify(`运单 ${parcel.trackingNo} 已通过企微通知快递员挂出「显示拒签」轨迹，采购 ${parcel.purchaser} 已可向卖家发起议价！`, 'ok')
}

export function completeRemainingBatchParcel(batch, parcel, asRefuse = false) {
  if (!assertRealAllowed() || !batch || !parcel) return
  parcel.inspectDone = true
  parcel.hasIssue = asRefuse
  if (asRefuse) {
    parcel.issueSummary = '实测滚轮偶发回滚，转拒签议价'
    return syncParcelRefusalToWecom(batch, parcel)
  }
  parcel.issueSummary = '全检完好无瑕'
  parcel.trajectoryState = 'SIGNED_OK'
  parcel.note = '✓ 全检通过，已通知巴枪正常签收'
  if (batch.parcels.every(p => p.inspectDone && (p.trajectoryState === 'SIGNED_OK' || p.trajectoryState === 'REFUSED_SHOWN'))) {
    batch.status = 'COMPLETED'
    appendWecomFeed({
      dir: 'OUT_BOT',
      tag: '批次全检达标',
      mention: batch.courierWechat,
      content: `【批次 100% 验完回执】批次 ${batch.id}（共 ${batch.parcelCount} 票）已在规定 ${batch.slaMinutes} 分钟内全部验完！正常签收 ${batch.parcels.filter(p => !p.hasIssue).length} 票，挂显示拒签待议价 ${batch.parcels.filter(p => p.hasIssue).length} 票（17:00前定最终去留）。`
    })
  }
  persist('courier_parcel_ok')
  notify(`运单 ${parcel.trackingNo} 已全检完好确认签收！`, 'ok')
}

export function pushWecomUrgentRecall10Min(recall) {
  if (!assertRealAllowed() || !recall) return
  recall.wecomAlertSent = true
  appendWecomFeed({
    dir: 'OUT_BOT',
    tag: '🚨 10分钟生死召回',
    mention: recall.courierWechat,
    content: `🚨【最高优·10分钟站点紧急召回】运单 ${recall.trackingNo}（${recall.model}）采购 ${recall.purchaser} 刚与卖家议妥留货！请注意：我方货款直接打对方账户后卖家可随意操纵退回，请务必在 10 分钟内从「${recall.currentPhysicalLoc}」物理拦下撤回退件并回复「已拦下」！`
  })
  triggerScanFeedback({ code: recall.trackingNo, kind: '🚨企微强召回', ok: true, warn: true, msg: '已向微信互通群发送10分钟拦截令' })
  persist('courier_push_recall')
  notify(`已向企微微信群强 @${recall.courierWechat} 发送 10 分钟紧急召回指令！`, 'ok')
}

export function simulateCourierWecomInterceptReply(recall) {
  if (!assertRealAllowed() || !recall) return
  const nowT = new Date().toTimeString().slice(0, 8)
  recall.courierAckedAt = nowT
  recall.courierAckText = `已在大浪站点退件笼把 ${recall.trackingNo} 物理抱出拦下！巴枪已撤销退回改挂派送回仓，15分钟内顺路带回你们1楼收货台！`
  recall.status = 'COURIER_INTERCEPTED'
  appendWecomFeed({
    dir: 'IN_COURIER',
    tag: '微信群拦截成功回执',
    sender: '顺丰-王建军（微信互通）',
    content: recall.courierAckText
  })
  triggerScanFeedback({ code: recall.trackingNo, kind: '站点已拦下', ok: true, msg: '快递员已在站点撤回退件，待实物回仓扫码解锁打款' })
  persist('courier_wecom_reply')
  notify(`企微回调成功：顺丰王师傅已在站点物理拦下 ${recall.trackingNo} 并撤回退件！请接货扫码确认回仓后解锁采购打款。`, 'ok')
}

export function confirmRecallBackInWarehouse(recall) {
  if (!assertRealAllowed() || !recall) return
  if (!recall.courierAckedAt) {
    notify('防钱货两空拦截：尚未收到驻点快递员站点撤回退件回执，请先通过企微群确认快递员已拦下！', 'err')
    return
  }
  recall.backInWhConfirmed = true
  recall.paymentReleaseLocked = false
  recall.status = 'RECALLED_SAFE'
  recall.currentPhysicalLoc = '已物理追回仓内 C-01 复检台 · 巴枪已改正式签收'
  appendStockMovement({
    type: '站点10分钟紧急召回回仓',
    skuCode: recall.skuCode,
    model: recall.model,
    fromLoc: '快递站点待退区',
    toLoc: 'C-01(议妥留货)',
    qtyDelta: '召回 1',
    refNo: recall.trackingNo
  })
  appendWecomFeed({
    dir: 'OUT_BOT',
    tag: '✓ 召回入仓解锁结算',
    mention: '',
    content: `【召回闭环确认】运单 ${recall.trackingNo} 实物已扫码回到泛亚仓库并改妥投签收，已通知采购 ${recall.purchaser} 安全放行卖家货款（零钱货两空风险）！`
  })
  triggerScanFeedback({ code: recall.trackingNo, kind: '召回回仓解锁', ok: true, msg: '实物已回仓，打款防损锁已安全解除！' })
  persist('courier_recall_done')
  notify(`✓ 运单 ${recall.trackingNo} 10 分钟紧急召回闭环完成！实物已回仓，采购打款锁已安全解除！`, 'ok')
}

export function setEodParcelDecision(item, decision) {
  if (!assertRealAllowed() || !item) return
  item.decision = decision
  item.decidedAt = new Date().toTimeString().slice(0, 5)
  const actionLabel = decision === 'KEEP_AND_SIGN' ? '议妥改签留仓' : '确认退回寄件人（晚班装车发走）'
  appendWecomFeed({
    dir: 'OUT_BOT',
    tag: '17:00前去留定案',
    mention: item.courierWechat,
    content: `【快件去留定案通知】运单 ${item.trackingNo}（${item.model}）采购 ${item.purchaser} 已定案：【${actionLabel}】，请按此执行巴枪操作！`
  })
  persist('courier_eod_decide')
  notify(`已定案 ${item.trackingNo}：${actionLabel}（已同步企微群）`, 'ok')
}

export function pushEod1700SummaryToWecom() {
  if (!assertRealAllowed()) return
  const cc = store.data.courierCoord
  if (!cc) return
  const pending = (cc.eodItems || []).filter(i => i.decision === 'PENDING')
  if (pending.length > 0) {
    notify(`17:00 清场防呆拦截：还有 ${pending.length} 票快件（${pending.map(p => p.trackingNo).join('、')}）未拍板去留，严禁带未决件过 17:00！`, 'err')
    return
  }
  const keepN = cc.eodItems.filter(i => i.decision === 'KEEP_AND_SIGN').length
  const retN = cc.eodItems.filter(i => i.decision === 'RETURN_TO_SELLER').length
  cc.eodSheetPushedAt = new Date().toTimeString().slice(0, 8)
  appendWecomFeed({
    dir: 'OUT_BOT',
    tag: '✓ 17:00日清总对账单',
    mention: '@所有人',
    content: `【17:00 当日快件最终去留清场总单】今日全仓暂存/拒签议价快件已 100% 定案清零：正式改签留仓 ${keepN} 票、确认退回寄件人发走 ${retN} 票、悬而未决滞留 0 票。请顺丰/京东/圆通驻点师傅核对装车！`
  })
  triggerScanFeedback({ code: `留${keepN}/退${retN}`, kind: '17:00去留清零', ok: true, msg: '已向企微微信群下发日终清场总单' })
  persist('courier_eod_push')
  notify('✓ 已向企微快递互通群下发《17:00 当日快件去留总对账单》，今日快件去留 100% 清零！', 'ok')
}

// ---- 18. 锂电池在库商品 30 天必须通电一次 + 强制彻底关机断电统筹闭环 (#/battery) ----
export function skuBatteryStatus(sku) {
  if (!sku || !sku.hasLithiumBattery) {
    return {
      applicable: false,
      isSealed: false,
      lvl: 'none',
      tag: '纯插电·免补电',
      days: 0,
      remainDays: 999,
      pct: null,
      powerOffOk: true,
      inChargeWip: false,
      reason: '台式显示器/插电设备无内置锂电池，自动豁免30天补电'
    }
  }
  const days = Number(sku.daysSincePowerOn || 0)
  const remainDays = 30 - days
  const wip = activeWipBorrowOfSku(sku.code)
  const inChargeWip = Boolean(wip && wip.wipCode === 'WIP-CHARGE-01')

  if (sku.sealBranch === 'SEALED_NEW') {
    const overdue = days >= 30
    return {
      applicable: true,
      isSealed: true,
      lvl: overdue ? 'amb' : 'grn',
      tag: overdue ? (sku.fastSellAlertSent ? '📦 原封已催销售快出' : `📦 原封满${days}天·禁拆封充电`) : `📦 全新原封保护(${days}天)`,
      days,
      remainDays,
      pct: null,
      powerOffOk: true,
      inChargeWip: false,
      reason: overdue
        ? '全新原封未拆封机严禁撕毁封条充电（防贬值¥800+），须推销售优先调价快出'
        : '全新原封未拆封机保管期内，禁止私拆充电'
    }
  }

  if (days >= 30 || sku.powerOffVerified === false) {
    return {
      applicable: true,
      isSealed: false,
      lvl: 'red',
      tag: days >= 30
        ? `🔴 已满 ${days} 天超期必通电${sku.powerOffVerified === false ? '·未真关机' : ''}`
        : '🔴 未核验彻底关机（防跑电）',
      days,
      remainDays,
      pct: sku.batteryPct ?? 10,
      powerOffOk: Boolean(sku.powerOffVerified),
      inChargeWip,
      reason: days >= 30
        ? `距上次通电已 ${days} 天（余电约 ${sku.batteryPct ?? 10}%），再不补电将过放饿死锁保护板；且出库已挂发前通电复测锁！`
        : '上次拔线后仅息屏/合盖休眠未彻底关机，后台待机极易跑干电量！'
    }
  }

  if (days >= 25) {
    return {
      applicable: true,
      isSealed: false,
      lvl: 'amb',
      tag: `🟡 满 ${days} 天临期（剩 ${remainDays} 天）`,
      days,
      remainDays,
      pct: sku.batteryPct ?? 30,
      powerOffOk: true,
      inChargeWip,
      reason: `距 30 天必通电红线仅剩 ${remainDays} 天，建议顺路移入 WIP-CHARGE-01 防爆车集中补电至 55%`
    }
  }

  return {
    applicable: true,
    isSealed: false,
    lvl: 'grn',
    tag: `🟢 ${days}天 · ${sku.batteryPct ?? 58}%半电已关机`,
    days,
    remainDays,
    pct: sku.batteryPct ?? 58,
    powerOffOk: true,
    inChargeWip,
    reason: `距下次必通电还有 ${remainDays} 天 · 已核验彻底关机断电存放`
  }
}

export function checkoutBatteryToChargeCart(sku) {
  if (!assertRealAllowed() || !sku) return false
  if (!sku.hasLithiumBattery) {
    return notify('该商品无内置锂电池，无需移入防爆补电车', 'err')
  }
  if (sku.sealBranch === 'SEALED_NEW') {
    triggerScanFeedback({ code: sku.code, kind: '原封防拆拦截', ok: false, msg: '全新原封机严禁撕封条拆封充电！' })
    notify(`防损硬拦截：#${sku.code}（${sku.model}）为全新原封未拆封机，撕封条充电将直接贬值 ¥800+！请点「推销售优先快出」`, 'err')
    return false
  }
  return checkoutSkuToWip({
    skuCode: sku.code,
    wipCode: 'WIP-CHARGE-01',
    borrower: currentUser.value.name,
    purpose: '30天锂电周期通电补至55%+彻底关机养护'
  })
}

export function batchCheckoutDueBatteriesToCart() {
  if (!assertRealAllowed()) return
  let cnt = 0
  for (const s of store.data.skus || []) {
    const st = skuBatteryStatus(s)
    if (st.applicable && !st.isSealed && (st.lvl === 'red' || st.lvl === 'amb') && !activeWipBorrowOfSku(s.code)) {
      const ok = checkoutSkuToWip({
        skuCode: s.code,
        wipCode: 'WIP-CHARGE-01',
        borrower: currentUser.value.name,
        purpose: '30天锂电统筹批量推车集中补电'
      })
      if (ok) cnt += 1
    }
  }
  if (!cnt) return notify('当前所有超期/临期已拆封带电商品均已在补电工位或已处理完毕', 'info')
  notify(`已批量扫码将 ${cnt} 台超期/临期锂电商品挂入「WIP-CHARGE-01 防爆集中补电车」！`, 'ok')
}

export function completeBatteryPowerCycleAndShutdown(sku, form) {
  if (!assertRealAllowed() || !sku) return false
  if (sku.sealBranch === 'SEALED_NEW') {
    notify('防损硬拦截：全新原封未拆封商品禁止拆封通电！', 'err')
    return false
  }
  const afterPct = Number(form?.afterPct ?? 0)
  const beforePct = Number(form?.beforePct ?? sku.batteryPct ?? 10)
  const healthPct = Number(form?.healthPct ?? sku.batteryHealthPct ?? 92)

  if (afterPct < 45 || afterPct > 80) {
    triggerScanFeedback({ code: `${afterPct}%`, kind: '存储电量防呆', ok: false, msg: '存储电量须在 45%~80% 半电黄金区间（推荐50%~65%）' })
    notify(`存储黄金水位拦截：当前填报充后电量为 ${afterPct}%！锂电存放低于 45% 易再次亏电，充太满(>80%)长期静置易鼓包，请控制在 45%~80%（推荐 55%~60%）！`, 'err')
    return false
  }
  if (!form?.powerOffChecked) {
    triggerScanFeedback({ code: sku.code, kind: '未彻底关机拦截', ok: false, msg: '必须拔线并长按执行彻底关机，严禁仅息屏或合盖休眠！' })
    notify('关机铁律硬拦截：请拔除充电线后执行系统「彻底关机」（确认短按电源键不亮屏，严禁仅锁屏息屏或合盖待机）并勾选确认！', 'err')
    return false
  }
  if (!form?.noSwellingChecked) {
    notify('安全防呆拦截：请复摸机身背部确认无异常余温、屏幕与后盖无微鼓包并勾选确认！', 'err')
    return false
  }

  const targetBin = (sku.location || 'A-11').toUpperCase()
  const sBin = String(form?.scannedReturnBin || targetBin).trim().toUpperCase().replace(/^LOC-/, '')
  if (sBin !== targetBin) {
    triggerScanFeedback({ code: sBin, kind: '归架防串位', ok: false, msg: `应扫回原储位 LOC-${targetBin}` })
    notify(`归架库位不符：单件 #${sku.code} 原储位为 ${targetBin}，请扫回 LOC-${targetBin}！`, 'err')
    return false
  }

  // 若挂在 WIP-CHARGE-01 补电车上，自动销账归架
  const wip = activeWipBorrowOfSku(sku.code)
  if (wip) {
    wip.status = 'RETURNED'
    wip.returnedAt = new Date().toTimeString().slice(0, 5)
  }

  const nowStr = '2026-11-18 ' + new Date().toTimeString().slice(0, 5)
  sku.daysSincePowerOn = 0
  sku.lastPowerOnAt = nowStr
  sku.batteryPct = afterPct
  sku.batteryHealthPct = healthPct
  sku.powerOffVerified = true
  sku.history.unshift(`11-18 完成30天锂电通电养护：${beforePct}% → ${afterPct}%黄金半电，已拔线彻底关机归回 ${targetBin}`)

  if (!Array.isArray(store.data.batteryCareLogs)) store.data.batteryCareLogs = []
  store.data.batteryCareLogs.unshift({
    id: 'BAT-LOG-' + Date.now().toString().slice(-4),
    time: '11-18 ' + new Date().toTimeString().slice(0, 5),
    skuCode: sku.code,
    model: `${sku.brand} ${sku.model}`,
    bin: targetBin,
    beforePct,
    afterPct,
    healthPct,
    powerOffChecked: true,
    noSwellingChecked: true,
    operator: currentUser.value.name,
    note: form?.note?.trim() || `防爆车补至 ${afterPct}% 半电，拔线长按彻底关机并核验黑屏无待机后归回 ${targetBin}`
  })

  appendStockMovement({
    type: '锂电30天通电并关机归架',
    skuCode: sku.code,
    model: `${sku.brand} ${sku.model}`,
    fromLoc: wip ? wip.wipCode : targetBin,
    toLoc: `${targetBin}(${afterPct}%彻底关机)`,
    qtyDelta: '重置30天周期',
    refNo: `电量${beforePct}%→${afterPct}%`
  })

  // 若全部超期红灯锂电已清零，自动将 TSK-897 推进为待验收
  const remainOverdue = (store.data.skus || []).filter(s => s.hasLithiumBattery && s.sealBranch !== 'SEALED_NEW' && (s.daysSincePowerOn >= 30 || s.powerOffVerified === false)).length
  if (remainOverdue === 0) {
    const t = (store.data.tasks || []).find(x => x.id === 'TSK-897')
    if (t && t.status !== '已验收') t.status = '待验收'
  }

  triggerScanFeedback({ code: `${sku.code} (${afterPct}%已关机)`, kind: '锂电养护完成', ok: true, msg: `已归回 ${targetBin} · 下次必通电 +30天` })
  persist('battery_cycle_done')
  notify(`✓ 单件 #${sku.code} 已补电至 ${afterPct}% 且核验彻底关机归回 ${targetBin}，30 天周期已重置！`, 'ok')
  return true
}

export function reportBatterySwellingOrDeadToRepair(sku, reason = '通电唤醒发现电池鼓包/锁保护板无法充电') {
  if (!assertRealAllowed() || !sku) return
  const wip = activeWipBorrowOfSku(sku.code)
  if (wip) {
    wip.status = 'RETURNED'
    wip.returnedAt = new Date().toTimeString().slice(0, 5)
  }
  const oldLoc = sku.location
  sku.zone = '待修/送修中'
  sku.location = 'D-02'
  sku.repairNote = `11-18 锂电30天巡检异常：${reason}（已断电移入 D-02 防爆红牌柜待修，严禁继续充电或挂售）`
  sku.history.unshift(`11-18 锂电养护检出异常（${reason}），紧急断电隔离至 D-02 待修区`)
  appendStockMovement({
    type: '锂电鼓包/饿死异常隔离',
    skuCode: sku.code,
    model: `${sku.brand} ${sku.model}`,
    fromLoc: oldLoc,
    toLoc: 'D-02(防爆待修)',
    qtyDelta: '异常隔离 1',
    refNo: 'BAT-ALERT'
  })
  triggerScanFeedback({ code: sku.code, kind: '🚨锂电异常隔离', ok: false, msg: '已断电锁入 D-02 待修柜禁售' })
  persist('battery_fault_isolate')
  notify(`🚨 已将 #${sku.code} 紧急断电转入 D-02 待修隔离柜并锁死禁售：${reason}`, 'err')
}

export function pushSealedBatteryFastSellAlert(sku) {
  if (!assertRealAllowed() || !sku) return
  sku.fastSellAlertSent = true
  sku.history.unshift(`11-18 原封锂电满 ${sku.daysSincePowerOn} 天快出预警：已保持原厂封条完好并推送销售主管优先调价快卖`)
  persist('sealed_fast_sell')
  notify(`✓ 已向销售工作台推送「原封机 #${sku.code} 满 ${sku.daysSincePowerOn} 天优先快出」提醒，原厂封条完好保留！`, 'ok')
}

export { ACCOUNTS, STANDARD_TEMPLATES, HELP_DICT, GLOSSARY, TOURS }
