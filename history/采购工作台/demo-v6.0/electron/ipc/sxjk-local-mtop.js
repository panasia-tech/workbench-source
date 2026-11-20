/**
 * 本机闲鱼 MTOP：主进程算签 + POST h5api → normalize（条件过滤在渲染进程统一执行）
 */
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { postSignedMtopRequest } from '../utils/sxjk-post-signed-mtop.js'
import { executeLocalPcItemDetail } from '../utils/sxjk-local-pc-item-detail.js'
import { xianyuMtop } from '../utils/xianyu-mtop-client.js'
import { pageDedupeItems } from '../../shared/sxjk-item-filter.js'
import { readCookieHeaderFromPartition } from '../utils/goofish-partition-cookie.js'
import { partitionForListingAccount } from '../utils/xianyu-session-partition.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { normalizeItems, pickSearchNumFoundFromMtopJson } = require(
  join(__dirname, '..', 'lib', 'xy_sxjk', 'normalize-items.js')
)

function isSearchMtopDebugAlwaysOn() {
  const v = String(process.env.XIANYU_SEARCH_MTOP_DEBUG || '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

/** 截断字符串，避免控制台被整包 MTOP 刷爆 */
function clipDebugText(v, maxLen = 1200) {
  const s =
    typeof v === 'string'
      ? v
      : (() => {
          try {
            return JSON.stringify(v)
          } catch {
            return String(v)
          }
        })()
  if (s.length <= maxLen) return s
  return `${s.slice(0, maxLen)}…(共${s.length}字)`
}

/**
 * 搜索/店铺列表：整理一份可读的原始返回摘要（不含 Cookie）
 * @param {unknown} json
 * @param {{ tag?: string, keyword?: string, pageNumber?: number, rawItemCount?: number, force?: boolean }} meta
 */
function logMtopRawResponseDebug(json, meta = {}) {
  const rawCount = Number(meta.rawItemCount)
  const empty = !Number.isFinite(rawCount) || rawCount <= 0
  if (!empty && !meta.force && !isSearchMtopDebugAlwaysOn()) return

  const data = json && typeof json === 'object' ? json.data : null
  const dataObj = data && typeof data === 'object' ? data : null
  const listLens = {}
  if (dataObj) {
    for (const k of ['resultList', 'items', 'list', 'cardList', 'itemList', 'cards']) {
      if (Array.isArray(dataObj[k])) listLens[k] = dataObj[k].length
    }
  }
  const resultInfo = dataObj?.resultInfo
  const control =
    resultInfo && typeof resultInfo === 'object' ? resultInfo.searchResControlFields : null

  const summary = {
    关键词: String(meta.keyword || '').slice(0, 80) || undefined,
    页码: meta.pageNumber,
    ret: Array.isArray(json?.ret) ? json.ret : json?.ret,
    api: json?.api || undefined,
    v: json?.v || undefined,
    dataKeys: dataObj ? Object.keys(dataObj).slice(0, 40) : [],
    列表长度: listLens,
    numFound: control?.numFound ?? dataObj?.numFound ?? undefined,
    totalCount: control?.totalCount ?? dataObj?.totalCount ?? undefined,
    解析后条数: Number.isFinite(rawCount) ? rawCount : undefined
  }

  console.warn(`[${meta.tag || '本机MTOP'}] 原始返回摘要`, summary)

  /** 空结果多打一小段 data 片段，方便看结构是否变了 */
  if (empty && dataObj) {
    console.warn(
      `[${meta.tag || '本机MTOP'}] data 片段`,
      clipDebugText(dataObj, isSearchMtopDebugAlwaysOn() ? 4000 : 1600)
    )
  } else if (isSearchMtopDebugAlwaysOn() && json) {
    console.warn(`[${meta.tag || '本机MTOP'}] 整包片段`, clipDebugText(json, 4000))
  }
}

/**
 * @param {import('electron').IpcMain} ipcMain
 */
export function registerSxjkLocalMtopIPC(ipcMain) {
  ipcMain.handle('sxjk-execute-client-search-poll', async (_e, body = {}) => {
    try {
      const requestUrl = String(body?.requestUrl || '').trim()
      const mtopData = body?.mtopData
      const cookie = String(body?.cookie || body?.client_mtop_cookie || '').trim()
      const referer = String(body?.referer || 'https://www.goofish.com/').trim()
      const taskBody = body?.taskBody && typeof body.taskBody === 'object' ? body.taskBody : {}
      const sellerBlacklistIds = Array.isArray(body?.sellerBlacklistIds) ? body.sellerBlacklistIds : []
      const pageNumber =
        body?.pageNumber != null && Number.isFinite(Number(body.pageNumber))
          ? Math.max(1, Math.floor(Number(body.pageNumber)))
          : 1

      if (!requestUrl || mtopData == null || typeof mtopData !== 'string') {
        return { ok: false, error: '缺少签名请求参数' }
      }
      if (!cookie) {
        return { ok: false, error: '缺少 Cookie' }
      }

      const postRes = await postSignedMtopRequest({
        requestUrl,
        mtopData,
        cookie,
        referer,
        forSearch: true
      })

      if (!postRes?.ok) {
        console.warn('[本机搜索] MTOP 失败', {
          error: String(postRes?.error || '').slice(0, 300),
          httpStatus: postRes?.httpStatus || 0,
          ret: postRes?.mtopRawJson?.ret,
          关键词: String(taskBody?.keyword || '').slice(0, 80)
        })
        if (postRes?.mtopRawJson) {
          logMtopRawResponseDebug(postRes.mtopRawJson, {
            tag: '本机搜索',
            keyword: taskBody?.keyword,
            pageNumber,
            rawItemCount: 0,
            force: true
          })
        }
        return {
          ok: false,
          error: String(postRes?.error || '闲鱼请求失败'),
          httpStatus: postRes?.httpStatus || 0
        }
      }

      const json = postRes.mtopRawJson
      const rawNormalized = normalizeItems(json)
      const normalizedItems = pageDedupeItems(rawNormalized)
      const searchNumFound = pickSearchNumFoundFromMtopJson(json)
      void sellerBlacklistIds

      logMtopRawResponseDebug(json, {
        tag: '本机搜索',
        keyword: taskBody?.keyword,
        pageNumber,
        rawItemCount: rawNormalized.length
      })

      return {
        ok: true,
        normalizedItems,
        items: normalizedItems,
        rawItemCount: rawNormalized.length,
        filterStats: {},
        searchPageNumber: pageNumber,
        searchNumFound,
        httpStatus: postRes.httpStatus || 0,
        client_mtop_cookie_updated: postRes.client_mtop_cookie_updated || ''
      }
    } catch (e) {
      console.error('[本机搜索轮询]', e)
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('sxjk-execute-client-pc-item-detail', async (_e, body = {}) => {
    try {
      const itemId = String(body?.itemId || body?.item_id || '').trim()
      const cookie = String(body?.cookie || body?.client_mtop_cookie || '').trim()
      if (!itemId) return { ok: false, error: '缺少商品 ID' }
      if (!cookie) return { ok: false, error: '缺少 Cookie' }
      return await executeLocalPcItemDetail({
        itemId,
        cookie,
        accountId: String(body?.accountId || '').trim()
      })
    } catch (e) {
      console.error('[本机商品详情]', e)
      return { ok: false, error: String(e?.message || e) }
    }
  })

  /** 本机算签+搜索+normalize（替代后端 signSearch） */
  ipcMain.handle('sxjk-mtop-search', async (_e, body = {}) => {
    try {
      const cookie = String(body?.cookie || body?.client_mtop_cookie || '').trim()
      const taskBody = body?.taskBody && typeof body.taskBody === 'object' ? body.taskBody : body
      const keyword = String(taskBody?.keyword || body?.keyword || '').trim()
      const pageNumber =
        body?.pageNumber != null && Number.isFinite(Number(body.pageNumber))
          ? Math.max(1, Math.floor(Number(body.pageNumber)))
          : undefined
      const accountId = String(
        body?.accountId ||
          body?.pollAccountId ||
          body?.poll_account_id ||
          taskBody?.accountId ||
          taskBody?.pollAccountId ||
          taskBody?.poll_account_id ||
          ''
      ).trim()

      const searchBody = {
        ...taskBody,
        keyword,
        ...(pageNumber != null ? { pageNumber } : {}),
        ...(body?.rowsPerPage != null ? { rowsPerPage: body.rowsPerPage } : {})
      }

      const signedPost = await xianyuMtop.search(cookie, searchBody, { accountId })
      if (!signedPost?.ok) {
        console.warn('[本机搜索] MTOP 失败', {
          error: String(signedPost?.error || '').slice(0, 300),
          httpStatus: signedPost?.httpStatus || 0,
          关键词: keyword.slice(0, 80)
        })
        if (signedPost?.mtopRawJson) {
          logMtopRawResponseDebug(signedPost.mtopRawJson, {
            tag: '本机搜索',
            keyword,
            pageNumber: signedPost.pageNumber,
            rawItemCount: 0,
            force: true
          })
        }
        return {
          ok: false,
          error: String(signedPost?.error || '闲鱼请求失败'),
          httpStatus: signedPost?.httpStatus || 0,
          code: signedPost?.code || '',
          client_mtop_cookie_updated: signedPost?.client_mtop_cookie_updated || ''
        }
      }

      const json = signedPost.mtopRawJson
      const rawNormalized = normalizeItems(json)
      const normalizedItems = pageDedupeItems(rawNormalized)
      const searchNumFound = pickSearchNumFoundFromMtopJson(json)
      const sellerNickHit = normalizedItems.filter((x) => String(x?.seller || '').trim()).length
      console.warn('[本机搜索] 卖家昵称', {
        关键词: keyword.slice(0, 40),
        条数: normalizedItems.length,
        有昵称: sellerNickHit,
        每页: signedPost.rowsPerPage ?? searchBody.rowsPerPage ?? 90
      })
      logMtopRawResponseDebug(json, {
        tag: '本机搜索',
        keyword,
        pageNumber: signedPost.pageNumber,
        rawItemCount: rawNormalized.length
      })
      return {
        ok: true,
        normalizedItems,
        items: normalizedItems,
        rawItemCount: rawNormalized.length,
        filterStats: {},
        searchPageNumber: signedPost.pageNumber,
        searchNumFound,
        httpStatus: signedPost.httpStatus || 0,
        client_mtop_cookie_updated: signedPost.client_mtop_cookie_updated || ''
      }
    } catch (e) {
      console.error('[本机搜索]', e)
      return { ok: false, error: String(e?.message || e) }
    }
  })

  /** 本机算签+店铺列表+normalize */
  ipcMain.handle('sxjk-mtop-xyh-item-list', async (_e, body = {}) => {
    try {
      const cookie = String(body?.cookie || body?.client_mtop_cookie || '').trim()
      const sellerUserId = String(body?.sellerUserId || body?.seller_user_id || body?.userId || '').trim()
      const pageNumber = Math.max(1, Math.floor(Number(body?.pageNumber) || 1))
      const pageSize = Math.min(50, Math.max(1, Math.floor(Number(body?.pageSize) || 20)))

      const listRes = await xianyuMtop.xyhItemList(cookie, {
        userId: sellerUserId,
        seller_user_id: sellerUserId,
        pageNumber,
        pageSize,
        /** 默认走「最新」；仅调用方显式传 true 时才 needGroupInfo */
        needGroupInfo: body?.needGroupInfo === true,
        groupName: body?.groupName != null ? body.groupName : '最新',
        groupSortId: body?.groupSortId != null ? body.groupSortId : 'newest'
      })
      if (!listRes?.ok) {
        console.warn('[本机店铺列表] MTOP 失败', {
          error: String(listRes?.error || '').slice(0, 300),
          httpStatus: listRes?.httpStatus || 0
        })
        if (listRes?.mtopRawJson) {
          logMtopRawResponseDebug(listRes.mtopRawJson, {
            tag: '本机店铺列表',
            rawItemCount: 0,
            force: true
          })
        }
        return {
          ok: false,
          error: String(listRes?.error || '闲鱼请求失败'),
          httpStatus: listRes?.httpStatus || 0,
          code: listRes?.code || '',
          client_mtop_cookie_updated: listRes?.client_mtop_cookie_updated || ''
        }
      }
      const items = normalizeItems(listRes.mtopRawJson)
      logMtopRawResponseDebug(listRes.mtopRawJson, {
        tag: '本机店铺列表',
        rawItemCount: items.length
      })
      return {
        ok: true,
        items,
        rawItemCount: items.length,
        httpStatus: listRes.httpStatus || 0,
        client_mtop_cookie_updated: listRes.client_mtop_cookie_updated || ''
      }
    } catch (e) {
      console.error('[本机店铺列表]', e)
      return { ok: false, error: String(e?.message || e) }
    }
  })

  /** 本机批量检测过期：读分区 Cookie → nav */
  ipcMain.handle('sxjk-mtop-verify-login-batch', async (_e, body = {}) => {
    try {
      const ids = Array.isArray(body?.accountIds)
        ? body.accountIds.map((x) => String(x || '').trim()).filter(Boolean)
        : Array.isArray(body?.client_ids)
          ? body.client_ids.map((x) => String(x || '').trim()).filter(Boolean)
          : []
      const items = []
      for (const id of ids.slice(0, 100)) {
        let cookie = ''
        try {
          cookie = await readCookieHeaderFromPartition(partitionForListingAccount(id))
        } catch {
          cookie = ''
        }
        items.push({ accountId: id, id, cookie })
      }
      return await xianyuMtop.verifyLoginBatch(items)
    } catch (e) {
      console.error('[本机登录检测]', e)
      return { results: [], error: String(e?.message || e) }
    }
  })

  ipcMain.handle('sxjk-mtop-fetch-profile', async (_e, body = {}) => {
    try {
      const cookie = String(body?.cookie || body?.client_mtop_cookie || '').trim()
      return await xianyuMtop.fetchProfile(cookie, {
        accountId: String(body?.accountId || '').trim()
      })
    } catch (e) {
      return { ok: false, displayName: '', avatar: '', error: String(e?.message || e) }
    }
  })

  ipcMain.handle('sxjk-mtop-search-suggest', async (_e, body = {}) => {
    try {
      const cookie = String(body?.cookie || body?.client_mtop_cookie || '').trim()
      return await xianyuMtop.searchSuggest(cookie, body || {})
    } catch (e) {
      return { ok: false, suggestions: [], error: String(e?.message || e) }
    }
  })

  ipcMain.handle('sxjk-mtop-user-page-head', async (_e, body = {}) => {
    try {
      const cookie = String(body?.cookie || body?.client_mtop_cookie || '').trim()
      return await xianyuMtop.userPageHead(cookie, body || {})
    } catch (e) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('sxjk-mtop-pc-item-seller', async (_e, body = {}) => {
    try {
      const cookie = String(body?.cookie || body?.client_mtop_cookie || '').trim()
      return await xianyuMtop.pcItemSeller(cookie, body || {})
    } catch (e) {
      return { ok: false, error: String(e?.message || e), sellerUserId: '' }
    }
  })

  ipcMain.handle('sxjk-execute-client-shop-xyh-item-list', async (_e, body = {}) => {
    try {
      const requestUrl = String(body?.requestUrl || '').trim()
      const mtopData = body?.mtopData
      const cookie = String(body?.cookie || body?.client_mtop_cookie || '').trim()
      const referer = String(body?.referer || 'https://www.goofish.com/').trim()

      if (!requestUrl || mtopData == null || typeof mtopData !== 'string') {
        return { ok: false, error: '缺少签名请求参数' }
      }
      if (!cookie) {
        return { ok: false, error: '缺少 Cookie' }
      }

      const postRes = await postSignedMtopRequest({
        requestUrl,
        mtopData,
        cookie,
        referer,
        forSearch: false
      })

      if (!postRes?.ok) {
        console.warn('[本机店铺列表] MTOP 失败', {
          error: String(postRes?.error || '').slice(0, 300),
          httpStatus: postRes?.httpStatus || 0,
          ret: postRes?.mtopRawJson?.ret
        })
        if (postRes?.mtopRawJson) {
          logMtopRawResponseDebug(postRes.mtopRawJson, {
            tag: '本机店铺列表',
            rawItemCount: 0,
            force: true
          })
        }
        return {
          ok: false,
          error: String(postRes?.error || '闲鱼请求失败'),
          httpStatus: postRes?.httpStatus || 0,
          code: postRes?.code || ''
        }
      }

      const json = postRes.mtopRawJson
      const items = normalizeItems(json)
      logMtopRawResponseDebug(json, {
        tag: '本机店铺列表',
        rawItemCount: items.length
      })
      return {
        ok: true,
        items,
        rawItemCount: items.length,
        httpStatus: postRes.httpStatus || 0,
        client_mtop_cookie_updated: postRes.client_mtop_cookie_updated || ''
      }
    } catch (e) {
      console.error('[本机店铺列表]', e)
      return { ok: false, error: String(e?.message || e) }
    }
  })
}
