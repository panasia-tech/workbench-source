/**
 * 闲鱼私聊 IM 会话池：按账号保活 WebSocket，复用 accessToken（对齐 XianYuApis 常驻通道）。
 * 仅在建连 / 断线重连时取 IM Token；同账号连续发消息不再重复取 token。
 *
 * 关闭：XIANYU_IM_SESSION_POOL=0
 */
import WebSocket from 'ws'
import {
  fetchGoofishImWsAccessToken,
  loadOrCreateImDeviceId,
  connectAndInitIm,
  sendGoofishImPrivateOnOpenWs,
  buildGoofishImHeartbeatPayload
} from './goofish-im-ws-private-text.js'

const HEARTBEAT_MS = 15_000

/** @type {Map<string, GoofishImSession>} */
const sessionsByAccountId = new Map()

/** 同账号发消息串行，避免建会话/发送回包互相抢 listener */
/** @type {Map<string, Promise<unknown>>} */
const sendChainsByAccountId = new Map()

/**
 * @typedef {{
 *   accountId: string,
 *   accountsDir: string,
 *   ws: import('ws'),
 *   sid: string,
 *   accessToken: string,
 *   deviceId: string,
 *   unb: string,
 *   cookieHeader: string,
 *   heartbeatTimer: ReturnType<typeof setInterval> | null,
 *   connecting: Promise<GoofishImSession> | null,
 *   silentDetach?: boolean
 * }} GoofishImSession
 */

function isPoolEnabled() {
  const v = String(process.env.XIANYU_IM_SESSION_POOL ?? '1').trim().toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'off'
}

function parseCookieUnb(cookieHeader) {
  for (const part of String(cookieHeader || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === 'unb') {
      return part.slice(i + 1).trim()
    }
  }
  return ''
}

function isWsOpen(ws) {
  return !!ws && ws.readyState === WebSocket.OPEN
}

/**
 * @param {GoofishImSession} session
 * @param {string} [reason]
 */
function detachSession(session, reason = '') {
  const id = String(session?.accountId || '').trim()
  if (!id) return
  const cur = sessionsByAccountId.get(id)
  if (cur !== session) return
  sessionsByAccountId.delete(id)
  if (session.heartbeatTimer) {
    clearInterval(session.heartbeatTimer)
    session.heartbeatTimer = null
  }
  if (reason) {
    console.log('[闲鱼私聊会话] 已断开', `账号=${id}`, reason)
  }
  if (session.silentDetach) return
  void notifyRealtimeDisconnected(session.accountsDir, id, reason)
}

/**
 * @param {string} accountId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
function enqueueAccountSend(accountId, fn) {
  const id = String(accountId || '').trim()
  const prev = sendChainsByAccountId.get(id) || Promise.resolve()
  const job = prev.catch(() => {}).then(fn)
  sendChainsByAccountId.set(
    id,
    job.then(
      () => {},
      () => {}
    )
  )
  return job
}

async function notifyRealtimeDisconnected(accountsDir, accountId, reason) {
  const dir = String(accountsDir || '').trim()
  const id = String(accountId || '').trim()
  if (!dir || !id || id === 'guest') return
  try {
    const { applyAccountGoofishImRealtimeMeta, broadcastAccountImRealtimeChanged } = await import(
      '../ipc/accounts.js'
    )
    const err = String(reason || '私聊通道已断开').trim().slice(0, 240)
    await applyAccountGoofishImRealtimeMeta(dir, id, { ok: false, err })
    broadcastAccountImRealtimeChanged(id, { ok: false, err })
  } catch (e) {
    console.warn('[闲鱼私聊会话] 写回断开状态失败', e?.message || e)
  }
}

/**
 * @param {GoofishImSession} session
 */
function startHeartbeat(session) {
  if (session.heartbeatTimer) {
    clearInterval(session.heartbeatTimer)
    session.heartbeatTimer = null
  }
  session.heartbeatTimer = setInterval(() => {
    const ws = session.ws
    if (!isWsOpen(ws)) {
      detachSession(session, '心跳时发现连接已关')
      return
    }
    try {
      ws.send(JSON.stringify(buildGoofishImHeartbeatPayload()))
    } catch (e) {
      detachSession(session, `心跳失败: ${e?.message || e}`)
      try {
        ws.terminate()
      } catch {
        /* */
      }
    }
  }, HEARTBEAT_MS)
  if (typeof session.heartbeatTimer.unref === 'function') {
    session.heartbeatTimer.unref()
  }
}

/**
 * @param {GoofishImSession} session
 */
function bindSessionLifecycle(session) {
  const ws = session.ws
  const onClose = () => detachSession(session, 'WebSocket 关闭')
  const onError = (err) => {
    console.warn('[闲鱼私聊会话] WS error', session.accountId, err?.message || err)
  }
  ws.on('close', onClose)
  ws.on('error', onError)
}

/**
 * 一次性建连发消息（池关闭时回退）
 * @param {{
 *   cookieHeader: string,
 *   accountsDir: string,
 *   accountId: string,
 *   peerUserId: string,
 *   text?: string,
 *   innerContent?: object,
 *   customType?: number,
 *   itemId?: string
 * }} p
 */
async function sendOneShot(p) {
  const cookieHeader = String(p.cookieHeader || '').trim()
  if (!cookieHeader) throw new Error('缺少 Cookie')
  const peerUserId = String(p.peerUserId || '').trim()
  if (!peerUserId) throw new Error('缺少对方用户 id')
  const unb = parseCookieUnb(cookieHeader)
  if (!unb) throw new Error('Cookie 中缺少 unb')

  const deviceId = await loadOrCreateImDeviceId(p.accountsDir, p.accountId, unb)
  const tokenPack = await fetchGoofishImWsAccessToken(cookieHeader, deviceId, {
    accountId: p.accountId
  })
  const { sendGoofishImPrivateTextOnce } = await import('./goofish-im-ws-private-text.js')
  const sent = await sendGoofishImPrivateTextOnce({
    cookieStr: tokenPack.cookies || cookieHeader,
    accessToken: tokenPack.accessToken,
    deviceId: tokenPack.deviceId,
    unb: tokenPack.unb,
    toUserId: peerUserId,
    text: p.text,
    innerContent: p.innerContent,
    customType: p.customType,
    itemId: p.itemId,
    keepAlive: false
  })
  return {
    ...sent,
    cookieHeader: sent.cookieHeader || tokenPack.cookies || cookieHeader
  }
}

/**
 * 确保账号私聊通道已连接（已连则复用，不重取 token）
 * @param {{ cookieHeader: string, accountsDir: string, accountId: string }} p
 */
export async function ensureGoofishImSession(p) {
  const accountId = String(p.accountId || '').trim()
  const accountsDir = String(p.accountsDir || '').trim()
  const cookieHeader = String(p.cookieHeader || '').trim()
  if (!accountId) throw new Error('缺少账号信息')
  if (!cookieHeader) throw new Error('缺少 Cookie')

  if (!isPoolEnabled()) {
    const unb = parseCookieUnb(cookieHeader)
    if (!unb) throw new Error('Cookie 中缺少 unb')
    const deviceId = await loadOrCreateImDeviceId(accountsDir, accountId, unb)
    const tokenPack = await fetchGoofishImWsAccessToken(cookieHeader, deviceId, { accountId })
    const { ws, sid } = await connectAndInitIm({
      cookieStr: tokenPack.cookies || cookieHeader,
      accessToken: tokenPack.accessToken,
      deviceId: tokenPack.deviceId,
      requireSid: true
    })
    await new Promise((r) => setTimeout(r, 500))
    try {
      ws.close()
    } catch {
      /* */
    }
    return { sid, cookieHeader: tokenPack.cookies || cookieHeader, pooled: false }
  }

  const existing = sessionsByAccountId.get(accountId)
  if (existing && isWsOpen(existing.ws) && existing.sid) {
    if (cookieHeader && cookieHeader !== existing.cookieHeader) {
      existing.cookieHeader = cookieHeader
    }
    return {
      sid: existing.sid,
      cookieHeader: existing.cookieHeader,
      pooled: true,
      reused: true
    }
  }

  if (existing?.connecting) {
    const s = await existing.connecting
    return { sid: s.sid, cookieHeader: s.cookieHeader, pooled: true, reused: true }
  }

  // 旧连接已死但尚未从 Map 清掉：静默摘掉，避免 close 回调误伤新会话
  if (existing) {
    existing.silentDetach = true
    detachSession(existing, '替换失效连接')
    try {
      existing.ws?.terminate?.()
    } catch {
      /* */
    }
  }

  /** @type {GoofishImSession} */
  const placeholder = {
    accountId,
    accountsDir,
    ws: /** @type {any} */ (null),
    sid: '',
    accessToken: '',
    deviceId: '',
    unb: '',
    cookieHeader,
    heartbeatTimer: null,
    connecting: null
  }

  const connecting = (async () => {
    const unb = parseCookieUnb(cookieHeader)
    if (!unb) throw new Error('Cookie 中缺少 unb')

    const deviceId = await loadOrCreateImDeviceId(accountsDir, accountId, unb)
    const tokenPack = await fetchGoofishImWsAccessToken(cookieHeader, deviceId, { accountId })
    const { ws, sid } = await connectAndInitIm({
      cookieStr: tokenPack.cookies || cookieHeader,
      accessToken: tokenPack.accessToken,
      deviceId: tokenPack.deviceId,
      requireSid: true
    })

    placeholder.ws = ws
    placeholder.sid = sid
    placeholder.accessToken = tokenPack.accessToken
    placeholder.deviceId = tokenPack.deviceId
    placeholder.unb = tokenPack.unb
    placeholder.cookieHeader = tokenPack.cookies || cookieHeader
    placeholder.connecting = null

    sessionsByAccountId.set(accountId, placeholder)
    bindSessionLifecycle(placeholder)
    startHeartbeat(placeholder)
    console.log('[闲鱼私聊会话] 已保活', `账号=${accountId}`, `sid=${sid}`)
    return placeholder
  })()

  placeholder.connecting = connecting
  sessionsByAccountId.set(accountId, placeholder)

  try {
    const session = await connecting
    return { sid: session.sid, cookieHeader: session.cookieHeader, pooled: true, reused: false }
  } catch (e) {
    if (sessionsByAccountId.get(accountId) === placeholder) {
      sessionsByAccountId.delete(accountId)
    }
    throw e
  }
}

/**
 * 经保活会话发私聊（同账号串行；断线则重连一次）
 * @param {{
 *   cookieHeader: string,
 *   accountsDir: string,
 *   accountId: string,
 *   peerUserId: string,
 *   text?: string,
 *   innerContent?: object,
 *   customType?: number,
 *   itemId?: string
 * }} p
 */
export async function sendGoofishImViaSession(p) {
  const peerUserId = String(p.peerUserId || '').trim()
  if (!peerUserId) throw new Error('缺少对方用户 id')
  const hasInner = p.innerContent != null && typeof p.innerContent === 'object'
  if (!hasInner && !String(p.text || '').trim()) throw new Error('缺少发送内容')

  if (!isPoolEnabled()) {
    return sendOneShot(p)
  }

  const accountId = String(p.accountId || '').trim()
  if (!accountId) throw new Error('缺少账号信息')

  return enqueueAccountSend(accountId, async () => {
    const runOnce = async () => {
      await ensureGoofishImSession({
        cookieHeader: p.cookieHeader,
        accountsDir: p.accountsDir,
        accountId
      })
      const session = sessionsByAccountId.get(accountId)
      if (!session || !isWsOpen(session.ws) || !session.sid) {
        throw new Error('私聊通道未就绪')
      }
      const sent = await sendGoofishImPrivateOnOpenWs({
        ws: session.ws,
        sid: session.sid,
        unb: session.unb,
        toUserId: peerUserId,
        text: p.text,
        innerContent: p.innerContent,
        customType: p.customType,
        itemId: p.itemId,
        cookieStr: session.cookieHeader
      })
      return {
        ...sent,
        cookieHeader: sent.cookieHeader || session.cookieHeader
      }
    }

    try {
      return await runOnce()
    } catch (e) {
      const msg = String(e?.message || e)
      const cur = sessionsByAccountId.get(accountId)
      const shouldRetry =
        !cur ||
        !isWsOpen(cur.ws) ||
        /未连接|未就绪|关闭|WebSocket|发私聊结果超时|建会话超时/i.test(msg)
      if (!shouldRetry) throw e
      if (cur) {
        detachSession(cur, '发送失败，将重连')
        try {
          cur.ws?.terminate?.()
        } catch {
          /* */
        }
      }
      return runOnce()
    }
  })
}

/**
 * @param {string} accountId
 * @param {{ silent?: boolean }} [opts]
 */
export function closeGoofishImSession(accountId, opts = {}) {
  const id = String(accountId || '').trim()
  if (!id) return
  const session = sessionsByAccountId.get(id)
  if (!session) return
  if (opts.silent) session.silentDetach = true
  detachSession(session, opts.silent ? '' : '主动关闭')
  try {
    session.ws?.close?.()
  } catch {
    /* */
  }
}

/** 应用退出时关闭全部保活连接 */
export function closeAllGoofishImSessions() {
  const ids = [...sessionsByAccountId.keys()]
  for (const id of ids) {
    closeGoofishImSession(id, { silent: true })
  }
  sendChainsByAccountId.clear()
}

export function getGoofishImSessionCount() {
  return sessionsByAccountId.size
}
