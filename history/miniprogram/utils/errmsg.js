// 把后端/网络层的原始报错翻译成用户看得懂的话。
//
// 原则:
//   1. 技术性报错(异常堆栈、英文、内部步骤名)翻译成中文人话;
//   2. 本来就是中文业务提示的(库存不足、序列号不符、回复内容为空…)原样放行——
//      有页面按文案判断逻辑(如 returns/receive 判断「序列号不符」),不能改写;
//   3. 原文始终 console.warn 留底,排查问题时去开发者工具看。
//
// 入口:
//   friendly(err, fallback)   请求层 reject 的 error 对象 → 一句话提示
//   friendlyText(text)        后端字段原文(task.error / last_error)→ 人话
//   friendlyStep(step)        gc 任务的 failed_step 步骤码 → 中文步骤名

// 步骤码 → 用户看得懂的动作名(gc runner / 各流程的 failed_step)
const STEP_LABEL = {
  open_editor: '打开发布页',
  title: '填写标题',
  desc: '填写描述',
  price: '填写价格',
  shipping: '设置邮费',
  image: '处理商品图',
  images: '上传商品图',
  publish: '点击发布',
  delist: '下架商品',
  reply_chat: '回复消息',
  reply_find: '找会话',
  reply_focus: '点开输入框',
  reply_input: '填写回复',
  reply_send: '发送回复',
  reply_verify: '核对是否发出',
  runner: '执行任务',
  keepalive: '保持在线',
  login: '登录检查',
}

// 规则自上而下,命中即止。只覆盖技术性/内部说法,中文业务提示不在此列(自然放行)。
const RULES = [
  // 服务/链路层
  [/群控服务未连接|群控服务.*异常/, '群控服务暂时不可用，请稍后再试'],
  [/gc ?服务器同步失败/i, '同步群控数据失败，请稍后再试'],
  [/MQTT|mqtt bridge/i, '群控服务暂时不可用，请稍后再试'],
  // 账号状态
  [/网页版未登录|无账号昵称/, '该店铺的闲鱼账号未登录，请在电脑上登录闲鱼后重试'],
  [/账号掉登录/, '账号登录已失效，在电脑上重新登录闲鱼后自动恢复'],
  [/命中风控[:：]?\s*(.*)/, (m) => `账号被平台限制${m[1] ? `（${m[1].split(' @ ')[0]}）` : ''}，已自动暂停，请人工处理`],
  // 任务执行
  [/流程硬超时|执行超时|超时未执行|watchdog 收尸/, '任务执行超时，请重试；反复超时请联系管理员'],
  [/流程崩溃/, '任务执行中断，请重试'],
  [/UNCERTAIN|发布后.*未确认成功/, '发布结果未确认：可能已经成功，请先到闲鱼确认，避免重复发布'],
  [/发布结果待对账/, '发布结果待确认，请稍等，请勿重复发布'],
  [/需新版 ?APK/i, '手机端组件版本过旧，请联系管理员更新'],
  [/执行端还是旧版/, '工位执行端版本过旧，请联系管理员更新'],
  [/退回闲鱼首页|闲鱼首页不可见|卖闲置(不可见|未找到)/, '未能进入店铺的发布页，请重试'],
  [/未找到 peer|会话未找到/, '没找到该聊天会话，请刷新后重试'],
  [/AI.*(未生成|生成.*失败)|种子兜底注入也失败/, '商品图生成失败，请重试或手动上传图片'],
  // 发布页传图后闲鱼不收：喂了 N 张只出 M 张缩略图。10-27 四个货十六单全是图里带二维码
  // （铭牌、售后服务卡），截图核对过，别把「可能有别的收」写成绝对
  [/上传后缩略图/, '有图片没被闲鱼接收（常见是图里带二维码），换一张后重新上架'],
  [/图片下载失败/, '商品图下载失败，请稍后重试'],
  // 原图太大时发布页会卡到执行端等不到回应（10-27 M20261026-007 手机原图实锤），
  // 别的卡顿也走这个说法，但让人换小图最有用
  [/原语 dump_nodes 超时/, '发布页面卡住了（常见是图片太大），请稍后重试，反复出现请换小一点的图'],
  [/派发未生效/, '本次任务没有派发成功，请重试'],
]

// 一看就是技术细节的特征:异常类名、堆栈、路径、网络底层错误
const TECHNICAL =
  /Traceback|Exception|\w+Error[:：\s]|sqlalchemy|axios|ECONN\w*|ETIMEDOUT|ENOENT|EADDRINUSE|localhost|127\.0\.0\.1|[A-Z]:\\|\/Users\/|\/home\/|status[_ ]?code|HTTP\/\d/i

function isHtml(text) {
  return /<[a-z!][^>]*>/i.test(text) || /nginx|Bad Gateway|502 Bad/i.test(text)
}

function applyRules(text) {
  for (const [re, out] of RULES) {
    const m = text.match(re)
    if (m) return typeof out === 'function' ? out(m) : out
  }
  return null
}

// 后端字段原文 → 人话。认不出来但明显是技术细节的给通用兜底;否则原样放行。
function friendlyText(text) {
  const raw = String(text || '').trim()
  if (!raw) return ''
  const hit = applyRules(raw)
  if (hit) return hit
  // last_error 的 "[step] 原因" 形态:步骤码翻成中文,原因再走一遍规则
  const bracket = raw.match(/^\[([a-z_]+)\]\s*(.*)$/i)
  if (bracket) {
    const reason = applyRules(bracket[2]) ||
      (TECHNICAL.test(bracket[2]) ? '执行出错，请重试' : bracket[2])
    return `${friendlyStep(bracket[1])}失败：${reason}`
  }
  if (isHtml(raw) || TECHNICAL.test(raw)) {
    console.warn('[errmsg] 原始报错已拦截:', raw)
    return '系统繁忙，请稍后再试'
  }
  return raw
}

function friendlyStep(step) {
  if (!step) return ''
  return STEP_LABEL[step] || '任务'
}

// 请求层 reject 的 error 对象 → 一句话提示
function friendly(err, fallback = '操作失败，请稍后再试') {
  if (!err) return fallback
  // wx.request 的 fail 分支(断网/超时/DNS)
  if (err.errMsg) {
    console.warn('[errmsg] 网络错误:', err.errMsg)
    return '网络连接失败，请检查网络后重试'
  }
  let detail = err.detail
  // FastAPI 422:detail 是校验错误数组,不是给人看的字符串
  if (Array.isArray(detail)) return '提交的内容有误，请检查后重试'
  if (detail && typeof detail === 'object') detail = detail.msg || detail.message || ''
  const text = friendlyText(detail)
  if (text) return text
  // 没有任何可用文案时按状态码兜底
  if (err.statusCode === 401) return '登录已失效，请重新登录'
  if (err.statusCode === 403) return '没有权限执行此操作'
  if (err.statusCode >= 500) return '服务暂时开小差了，请稍后再试'
  return fallback
}

module.exports = { friendly, friendlyText, friendlyStep }
