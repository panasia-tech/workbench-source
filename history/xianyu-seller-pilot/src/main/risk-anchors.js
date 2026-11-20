// 风控判据：**不在这里定义**，读群控那份共用的 risk_anchors.json。
//
// # 为什么不在这里定义
//
// 2026-09-16 核对发现三处判据（群控手机流程、群控网页版流程、这里的行情采集）
// 各写各的，而且内容真的不一样——两边只共享「验证码」和「安全验证」两个词：
//
//   群控有、这边认不出：账号异常 / 申诉 / 违规 / 人机验证 / 身份验证
//   这边有、群控认不出：访问受限 / 请求频繁 / 非法访问 / 风控拦截 / 访问异常 …
//
// 不是重复，是各学各的教训，谁也没拿到对方那半。漏判风控的症状是「照常重试」，
// 而重试风控页就是往枪口上撞。
//
// # 怎么共用的
//
// 那份 JSON 在同一个 git 仓库里（groupcontrol-server/app/flow/risk_anchors.json），
// 构建时由打包器内联进来，运行期不读文件——桌面端装到别人电脑上时那个目录并不存在。
//
// 不做「读不到就退回内置默认」：静默降级等于让「文件没打包进去」变成「风控判据
// 悄悄少了一半」，而症状要等到有账号被封才看得见。宁可构建期就失败。

// `with { type: 'json' }` 是 Node 跑原生 ESM 时的硬要求（回归就是这么跑的）；
// 打包器也认，所以两条路都走得通。
import table from '../../../groupcontrol-server/app/flow/risk_anchors.json' with { type: 'json' }

/** @type {Record<string, string[]>} 风控类别 → 命中这类的文案 */
export const RISK_SIGNALS = table.signals

/** 扁平化的锚点，命中任意一条即视为风控。 */
export const RISK_ANCHORS = Object.values(RISK_SIGNALS).flat()

/** 这段文本命中了哪一类风控；没命中返回空串。 */
export function riskSignalFor(text) {
  const haystack = String(text || '')
  for (const [name, texts] of Object.entries(RISK_SIGNALS)) {
    if (texts.some((t) => haystack.includes(t))) return name
  }
  return ''
}

/**
 * 注进页面脚本用的字面量。
 *
 * 采集那段判据跑在页面上下文里（executeJavaScript），拿不到本模块的作用域，
 * 只能把表序列化成字面量随脚本一起送进去。
 */
export function riskSignalsLiteral() {
  return JSON.stringify(RISK_SIGNALS)
}
