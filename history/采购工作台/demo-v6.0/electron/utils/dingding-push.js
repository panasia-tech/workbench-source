/**
 * 钉钉 Markdown 推送（读用户数据目录 app.js；无 credentialsOverride 时读全局首个可用机器人，供连接测试等）
 */
import axios from 'axios'
import CryptoJS from 'crypto-js'
import { pickDingtalkCredentials } from './dingtalk-robots.js'
import { promises as fs, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const defaultConfigFile = join(__dirname, '..', 'data', 'config', 'app.js')

function getConfigFilePath() {
  try {
    const userConfigFile = join(app.getPath('userData'), 'data', 'config', 'app.js')
    if (existsSync(userConfigFile)) return userConfigFile
    return defaultConfigFile
  } catch {
    return defaultConfigFile
  }
}

async function readAppConfig() {
  try {
    const configFile = getConfigFilePath()
    const content = await fs.readFile(configFile, 'utf-8')
    const match = content.match(/export\s+default\s+({[\s\S]*})/m)
    if (match) {
      const configObj = new Function('return ' + match[1])()
      return configObj || {}
    }
    return {}
  } catch (e) {
    console.warn('[钉钉推送] 读取配置失败:', e.message)
    return {}
  }
}

function calculateSign(secret, timestamp) {
  const stringToSign = `${timestamp}\n${secret}`
  const hmac = CryptoJS.HmacSHA256(stringToSign, secret)
  return CryptoJS.enc.Base64.stringify(hmac)
}

function addSignToUrl(url, secret) {
  if (!secret) return url
  const timestamp = Date.now()
  const sign = calculateSign(secret, timestamp)
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`
}

/**
 * 钉钉互动卡片（自定义机器人 Webhook）：开放平台要求 actionCard 使用 **text** 作为正文（支持 Markdown），
 * **btns** 内为 **actionURL**。不要使用 actionCard.markdown，否则会报 text 缺失（400503）。
 * 若正文为空串，会回退为标题，避免 text 无效。
 *
 * @param {{
 *   title?: string,
 *   markdown?: string,
 *   text?: string,
 *   btn_orientation?: string,
 *   btnOrientation?: string,
 *   btn_json_list?: Array<{ title?: string, action_url?: string, actionURL?: string }>,
 *   btnJsonList?: Array<{ title?: string, action_url?: string, actionURL?: string }>,
 *   btns?: Array<{ title?: string, action_url?: string, actionURL?: string }>,
 *   single_title?: string,
 *   single_url?: string,
 *   singleTitle?: string,
 *   singleUrl?: string
 * }} payload
 * @returns {Promise<{ success: boolean, error?: string, errcode?: number, data?: object }>}
 */
export async function sendActionCardMessage(payload) {
  const config = await readAppConfig()
  const creds = pickDingtalkCredentials(config, payload?.credentialsOverride ?? null)
  const webhook = creds?.webhook || ''
  const secret = creds?.secret || ''

  if (!webhook) {
    return { success: false, error: '未配置钉钉 Webhook', errcode: -2 }
  }

  let url = webhook
  if (secret) url = addSignToUrl(url, secret)

  const title = String(payload?.title || '通知').slice(0, 128)
  /** 钉钉机器人 ActionCard 只认 actionCard.text，不认 markdown 字段（与 open.dingtalk.com 文档一致） */
  let bodyMd = String(payload?.markdown ?? payload?.text ?? '').trim()
  if (!bodyMd) {
    bodyMd = title || '闲鱼上新'
  }

  const singleTitle = String(payload?.single_title || payload?.singleTitle || '').trim()
  const singleUrl = String(payload?.single_url || payload?.singleUrl || '').trim()
  const useSingle = Boolean(singleTitle && singleUrl)

  const btnOrientation = String(payload?.btn_orientation ?? payload?.btnOrientation ?? '1')
  const rawList = Array.isArray(payload?.btn_json_list)
    ? payload.btn_json_list
    : Array.isArray(payload?.btnJsonList)
      ? payload.btnJsonList
      : Array.isArray(payload?.btns)
        ? payload.btns
        : []

  const pairs = rawList
    .slice(0, 6)
    .map((b) => ({
      title: String(b?.title || '').trim().slice(0, 32),
      actionURL: String(b?.action_url ?? b?.actionURL ?? '').trim()
    }))
    .filter((b) => b.title && b.actionURL)

  if (!useSingle && !pairs.length) {
    return { success: false, error: '互动卡片缺少有效按钮', errcode: -3 }
  }

  /** @type {object[]} */
  const attempts = []

  if (useSingle) {
    attempts.push({
      msgtype: 'actionCard',
      actionCard: {
        title,
        text: bodyMd,
        singleTitle: singleTitle.slice(0, 32),
        singleURL: singleUrl
      }
    })
  } else {
    const btns = pairs.map((b) => ({ title: b.title, actionURL: b.actionURL }))
    /** 主路径：与钉钉开放平台「自定义机器人」ActionCard 示例一致（text + btns） */
    attempts.push({
      msgtype: 'actionCard',
      actionCard: {
        title,
        text: bodyMd,
        btnOrientation,
        btns
      }
    })
    /** 少数旧文档使用 hideAvatar */
    attempts.push({
      msgtype: 'actionCard',
      actionCard: {
        title,
        text: bodyMd,
        hideAvatar: '0',
        btnOrientation,
        btns
      }
    })
  }

  let lastErr = /** @type {{ errmsg?: string, errcode?: number } | null} */ (null)

  try {
    for (const body of attempts) {
      const response = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      })
      if (response.data?.errcode === 0) {
        return { success: true, data: response.data }
      }
      lastErr = response.data || null
      console.warn('[钉钉推送] ActionCard 变体未通过，尝试下一种', response.data)
    }
    return {
      success: false,
      error: lastErr?.errmsg || '发送失败',
      errcode: lastErr?.errcode
    }
  } catch (error) {
    console.error('[钉钉推送] ActionCard 请求失败:', error.message)
    return { success: false, error: error.message || '网络请求失败', errcode: -1 }
  }
}

/**
 * 钉钉图文链接（自定义机器人）：头图 + 标题 + 摘要 + 点击跳转。
 * 文档：自定义机器人发送消息 → 消息类型 → link
 *
 * @param {{ title?: string, text?: string, picUrl?: string, messageUrl?: string }} payload
 */
export async function sendLinkMessage(payload) {
  const config = await readAppConfig()
  const creds = pickDingtalkCredentials(config, payload?.credentialsOverride ?? null)
  const webhook = creds?.webhook || ''
  const secret = creds?.secret || ''

  if (!webhook) {
    return { success: false, error: '未配置钉钉 Webhook', errcode: -2 }
  }

  const messageUrl = String(payload?.messageUrl || '').trim()
  if (!messageUrl) {
    return { success: false, error: '缺少跳转链接 messageUrl', errcode: -3 }
  }

  let url = webhook
  if (secret) url = addSignToUrl(url, secret)

  const title = String(payload?.title || '通知').slice(0, 128)
  const text = String(payload?.text ?? '').slice(0, 500)
  const picUrl = String(payload?.picUrl || '').trim().slice(0, 500)

  const body = {
    msgtype: 'link',
    link: {
      text: text || title,
      title,
      picUrl,
      messageUrl
    }
  }

  try {
    const response = await axios.post(url, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    })
    if (response.data?.errcode === 0) {
      return { success: true, data: response.data }
    }
    return {
      success: false,
      error: response.data?.errmsg || '发送失败',
      errcode: response.data?.errcode
    }
  } catch (error) {
    console.error('[钉钉推送] link 请求失败:', error.message)
    return { success: false, error: error.message || '网络请求失败', errcode: -1 }
  }
}

export async function sendMarkdownMessage(title, text, credentialsOverride) {
  const config = await readAppConfig()
  const creds = pickDingtalkCredentials(config, credentialsOverride ?? null)
  const webhook = creds?.webhook || ''
  const secret = creds?.secret || ''

  if (!webhook) {
    return { success: false, error: '未配置钉钉 Webhook', errcode: -2 }
  }

  let url = webhook
  if (secret) url = addSignToUrl(url, secret)

  const payload = {
    msgtype: 'markdown',
    markdown: { title: title || '通知', text: text || '' },
    at: { atMobiles: [], isAtAll: false }
  }

  try {
    const response = await axios.post(url, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    })
    if (response.data?.errcode === 0) {
      return { success: true, data: response.data }
    }
    return {
      success: false,
      error: response.data?.errmsg || '发送失败',
      errcode: response.data?.errcode
    }
  } catch (error) {
    console.error('[钉钉推送] 请求失败:', error.message)
    return { success: false, error: error.message || '网络请求失败', errcode: -1 }
  }
}
