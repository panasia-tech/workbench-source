/**
 * 钉钉连接测试记录（本机 JSON，用于自动/手动测试结果落盘）
 */
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

const MAX_ENTRIES = 100

function previewWebhook(url) {
  try {
    const u = new URL(String(url || '').trim())
    const token = u.searchParams.get('access_token') || ''
    const tail = token.length >= 8 ? `…${token.slice(-6)}` : token ? '…' : ''
    return `${u.hostname}${tail}`
  } catch {
    return ''
  }
}

async function readState(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const j = JSON.parse(raw)
    return {
      lastAutoTestConfigSha256: typeof j.lastAutoTestConfigSha256 === 'string' ? j.lastAutoTestConfigSha256 : '',
      entries: Array.isArray(j.entries) ? j.entries : []
    }
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { lastAutoTestConfigSha256: '', entries: [] }
    }
    throw e
  }
}

async function writeState(filePath, state) {
  await fs.mkdir(dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8')
}

/** 时间上最后一条连接测试（成功或失败只展示这一条） */
function pickLatestConnectTest(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (!e || typeof e.success !== 'boolean') continue
    return {
      success: e.success,
      at: e.at,
      trigger: e.trigger,
      detail: e.success ? '' : e.error != null ? String(e.error) : '',
      webhookPreview: e.webhookPreview || ''
    }
  }
  return null
}

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {string} filePath
 */
export function registerDingtalkConnectTestIPC(ipcMain, filePath) {
  ipcMain.handle('get-dingtalk-connect-test-state', async () => {
    const s = await readState(filePath)
    const latestConnectTest = pickLatestConnectTest(s.entries)
    return {
      ok: true,
      filePath,
      lastAutoTestConfigSha256: s.lastAutoTestConfigSha256,
      latestConnectTest
    }
  })

  ipcMain.handle('record-dingtalk-connect-test', async (_e, payload) => {
    const configHash = String(payload?.configHash || '')
    const success = !!payload?.success
    const errRaw = payload?.error
    const error =
      success || errRaw === null || errRaw === undefined
        ? null
        : String(errRaw).slice(0, 2000)
    const trigger = payload?.trigger === 'manual' ? 'manual' : 'auto'
    const webhookUrl = typeof payload?.webhookUrl === 'string' ? payload.webhookUrl : ''

    const entry = {
      at: new Date().toISOString(),
      success,
      error,
      trigger,
      webhookPreview: previewWebhook(webhookUrl)
    }

    const state = await readState(filePath)
    state.entries = [...state.entries, entry].slice(-MAX_ENTRIES)
    // 成功一次即记入「该配置已测过」，避免进入高级设置时自动再发一条（手动成功也算）
    if (configHash && (trigger === 'auto' || (trigger === 'manual' && success))) {
      state.lastAutoTestConfigSha256 = configHash
    }
    await writeState(filePath, state)
    return { ok: true, filePath }
  })
}
