/**
 * 闲鱼上新：本地保存用过的搜索关键词，便于添加监听时下拉复选
 */
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

const MAX_LEN = 60
const MAX_KEYWORD_CHARS = 120

function normalizeList(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const s of raw) {
    const k = String(s || '').trim().slice(0, MAX_KEYWORD_CHARS)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(k)
    if (out.length >= MAX_LEN) break
  }
  return out
}

export function registerSxjkKeywordHistoryIPC(ipcMain, filePath) {
  ipcMain.handle('get-sxjk-keyword-history', async () => {
    try {
      const text = await fs.readFile(filePath, 'utf-8')
      const data = JSON.parse(text)
      const arr = Array.isArray(data) ? data : data?.keywords
      return { ok: true, keywords: normalizeList(arr) }
    } catch (e) {
      if (e && e.code === 'ENOENT') return { ok: true, keywords: [] }
      return { ok: false, error: String(e.message || e), keywords: [] }
    }
  })

  ipcMain.handle('save-sxjk-keyword-history', async (_e, keywords) => {
    try {
      const list = normalizeList(keywords)
      await fs.mkdir(dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, JSON.stringify(list, null, 2), 'utf-8')
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })
}
