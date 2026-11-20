// ERP 对接：登录凭据、型号清单同步。
//
// 凭据不写进源码——仓库是公开可读的版本库，密码进了 git 历史就撤不回来。
// 沿用本项目既有的私有配置约定（同 llm-private.json）：
//   1) Electron userData/erp-private.json   {"username":"...","password":"DEMO_ONLY_REDACTED"}
//   2) 环境变量 XIAN_YU_ERP_USERNAME / XIAN_YU_ERP_PASSWORD
// 两者都没有时，回落到设置页里手工填的登录态，不阻塞爬取。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import * as XLSX from 'xlsx'

import { importCrawlProducts, deviceLogin } from './api.js'
import { getToken, setToken } from './store.js'

function text(value) {
  return String(value ?? '').trim()
}

function privateConfig() {
  try {
    if (!app.isReady()) return {}
    const candidates = [join(app.getPath('userData'), 'erp-private.json')]
    try {
      const appData = app.getPath('appData')
      candidates.push(
        join(appData, 'xianyu-electron', 'erp-private.json'),
        join(appData, '闲鱼行情工作台', 'erp-private.json')
      )
    } catch { /* ignore platform-specific path errors */ }
    for (const filePath of [...new Set(candidates)]) {
      if (!existsSync(filePath)) continue
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
      if (parsed && typeof parsed === 'object') return parsed
    }
    return {}
  } catch {
    return {}
  }
}

export function readErpCredentials() {
  const file = privateConfig()
  return {
    username: text(file.username) || text(process.env.XIAN_YU_ERP_USERNAME),
    password: text(file.password) || text(process.env.XIAN_YU_ERP_PASSWORD)
  }
}

/** 已有登录态就复用；否则用私有凭据静默登录。拿不到 token 返回 null，调用方不应因此中断爬取。 */
export async function ensureCrawlerToken() {
  const existing = text(getToken())
  if (existing) return existing
  const { username, password } = readErpCredentials()
  if (!username || !password) return null
  try {
    const data = await deviceLogin(username, password)
    const token = text(data?.token)
    if (token) setToken(token)
    return token || null
  } catch {
    return null
  }
}

/**
 * 用当前 Excel 任务清单里的型号，构造 ERP 导入器认得的工作簿。
 *
 * 不直接上传用户导入的原始文件：那份文件的表头/列可能被改过，而且经过 AI 型号清洗后，
 * 实际参与爬取的型号名可能已与原始文件不同。这里以「实际会去搜的型号」为准。
 */
export function buildProductsWorkbook(tasks = []) {
  const rows = [['名称', '搜索词']]
  const seen = new Set()
  for (const task of tasks) {
    const name = text(task?.name)
    if (!name || seen.has(name)) continue
    seen.add(name)
    rows.push([name, text(task?.effectiveAlias) || ''])
  }
  if (rows.length === 1) return null
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '监控型号')
  return { buffer: XLSX.write(book, { bookType: 'xlsx', type: 'buffer' }), count: rows.length - 1 }
}

/**
 * 开爬前把型号清单同步到 ERP 的行情监控列表。
 *
 * 固定合并导入（replace=false）：巡航台的清单只是它自己的任务集，覆盖模式会删掉
 * ERP 里其余型号并连带删除历史行情。服务端对 CRAWLER 角色也强制了这一点，此处是第二道闸。
 * 同步失败只记日志、不阻断爬取——行情采集本身不依赖 ERP。
 */
export async function syncCrawlProducts(tasks = []) {
  const token = await ensureCrawlerToken()
  if (!token) return { ok: false, skipped: true, reason: '未配置 ERP 凭据，跳过型号同步' }
  const workbook = buildProductsWorkbook(tasks)
  if (!workbook) return { ok: false, skipped: true, reason: '当前清单没有可同步的型号' }
  try {
    const result = await importCrawlProducts(workbook.buffer, 'seller-pilot-tasks.xlsx', { token })
    return { ok: true, sent: workbook.count, ...result }
  } catch (e) {
    const detail = e?.response?.data?.detail || e?.message || String(e)
    return { ok: false, skipped: false, reason: '型号同步失败: ' + detail }
  }
}
