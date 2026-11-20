/**
 * 多钉钉机器人配置：与 app.js 中 dingtalkRobots / 旧版 dingtalkWebhook 字段一致
 */

export const DINGTALK_ROBOT_NAME_MAX_LEN = 32

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function clipDingtalkRobotName(raw) {
  let s = String(raw ?? '').trim()
  if (s.length > DINGTALK_ROBOT_NAME_MAX_LEN) s = s.slice(0, DINGTALK_ROBOT_NAME_MAX_LEN)
  return s
}

/**
 * 单条机器人落盘字段（与设置页、任务解析共用）
 * @param {object} r
 */
export function normalizeDingtalkRobotExtras(r) {
  const available = r?.available === false ? false : true
  const lastDingtalkTestAt = String(r?.lastDingtalkTestAt ?? '').trim().slice(0, 40)
  const lastDingtalkTestError = String(r?.lastDingtalkTestError ?? '').trim().slice(0, 500)
  const trig = String(r?.lastDingtalkTestTrigger ?? '').toLowerCase()
  const lastDingtalkTestTrigger =
    trig === 'manual' ? 'manual' : trig === 'auto' ? 'auto' : ''
  const lastAutoTestCredentialSha256 = String(r?.lastAutoTestCredentialSha256 ?? '')
    .trim()
    .slice(0, 128)
  return {
    available,
    lastDingtalkTestAt,
    lastDingtalkTestError,
    lastDingtalkTestTrigger,
    lastAutoTestCredentialSha256
  }
}

/**
 * @param {object} config - app.js 解析后的对象
 * @returns {object[]}
 */
export function normalizeDingtalkRobots(config) {
  if (!config || typeof config !== 'object') return []
  let list = config.dingtalkRobots
  if (!Array.isArray(list)) list = []
  const out = list
    .map((r) => ({
      webhook: String(r?.webhook ?? '').trim(),
      secret: String(r?.secret ?? '').trim(),
      name: clipDingtalkRobotName(r?.name),
      ...normalizeDingtalkRobotExtras(r)
    }))
    .filter((r) => r.webhook.length > 0)

  if (out.length === 0) {
    const w = String(config.dingtalkWebhook ?? '').trim()
    const s = String(config.dingtalkSecret ?? '').trim()
    if (w) {
      out.push({
        webhook: w,
        secret: s,
        name: '',
        ...normalizeDingtalkRobotExtras({})
      })
    }
  }
  return out
}

/**
 * 解析要使用的 Webhook/加签（override 优先；否则取全局配置中第一个有效机器人，供未传任务凭证时的回退）
 * @param {object} config
 * @param {{ webhook?: string, secret?: string } | null} [override] — 任务推送、连接测试等传入的指定机器人
 * @returns {{ webhook: string, secret: string } | null}
 */
export function pickDingtalkCredentials(config, override) {
  if (override && String(override.webhook || '').trim()) {
    return {
      webhook: String(override.webhook).trim(),
      secret: String(override.secret || '').trim()
    }
  }
  const robots = normalizeDingtalkRobots(config)
  if (!robots.length) return null
  return robots[0]
}
