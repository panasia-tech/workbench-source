/**
 * 闲鱼会话 IPC（工作台式）：账号 Cookie 只读分区；游客 Cookie 只读写 guest JSON；无 HTTP 保活。
 */
import { session } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  readAccountCookieForApi,
  readAccountCookieHeader,
  readCookieHeaderFromPartition,
  cookiesToHeaderFromSession,
  partitionHasAccountLogin
} from '../utils/goofish-partition-cookie.js'
import { resolveAccountMtopCookieForTask, refreshAccountMh5TokenForExpired } from '../utils/goofish-account-mtop-cookie-resolve.js'
import {
  getGuestCookieHeader,
  setGuestCookieHeader,
  clearGuestCookieHeader,
  resolveGuestCookieForTask
} from '../utils/goofish-guest-cookies-store.js'
import { headerHasMh5Tk, parseAndValidateGoofishHttpsUrl } from '../utils/xianyu-goofish-open-session.js'
import {
  openGoofishUrlInAppBrowseWindow,
  partitionPersistIdForGoofishBrowseShell,
  syncGoofishCookiesIntoPartition
} from '../utils/xianyu-goofish-electron-browse-window.js'
import { partitionForListingAccount } from '../utils/xianyu-session-partition.js'
import { uploadGoofishChatImage } from '../utils/goofish-chat-image-upload.js'
import {
  sxjkGoofishImTestSendText,
  sxjkGoofishImTestSendImage
} from '../utils/goofish-im-ws-private-text.js'
import { runGoofishImWarmupWithPersist } from '../utils/goofish-im-connection-facade.js'
import {
  GOOFISH_IM_VERIFY_OPENED_HINT,
  humanizeGoofishImErrorMain,
  inferMtopAntiBotBodyFromImError,
  shouldOpenImSliderAssistForChallenge
} from '../utils/goofish-im-user-hints.js'
import {
  openGoofishImPageForManualConnectAndWaitClose,
  tryOpenGoofishImPageOnGreetingVerifyFailure,
  runMtopAntiBotVerifyAssist,
  runLockOrderRiskVerifyAssist,
  mtopSliderVerifyIpcFields
} from '../utils/goofish-mtop-antibot-verify-assist.js'
import { clearImSliderAssistUsed } from '../utils/goofish-im-slider-once-guard.js'
import { sxjkBackendPost } from '../utils/sxjk-backend-client.js'
import {
  runLocalMiaopaiOrder,
  listLocalMiaopaiDeliverAddresses
} from '../utils/sxjk-local-miaopai-order.js'
import {
  syncAccountProfileFromPartition,
  notifyAccountProfileSynced,
  finalizeGoofishBrowseWindowClose
} from '../utils/goofish-account-profile-sync.js'
import { readAutoLoginBrowseWindowShouldCloseWithoutSave } from '../utils/goofish-embed-login-page.js'
import { appendSxjkGrabLogEntry } from './sxjk-grab-logs.js'
import { ingestSxjkGreetingPrefetchRows } from '../utils/goofish-im-greeting-prefetch-cache.js'
import { GOOFISH_HOME_URL } from '../config/goofish.js'
import { initGoofishRiskCookieBridge } from '../utils/goofish-risk-cookie-bridge.js'
import { initGoofishImVerifyNotifyBridge } from '../utils/goofish-im-verify-notify-bridge.js'
import { flushAccountPartitionStore, repersistAccountPartitionCookiesForDisk } from '../utils/goofish-partition-persist.js'
import { touchAccountGoofishPageOpenedAt } from './accounts.js'
import { captureGuestCookieSilent } from '../utils/goofish-guest-cookie-silent.js'
import { GUEST_COOKIE_AUTH_TIMEOUT_MSG } from '../../shared/sxjkGuestCookieHints.js'

const notSupported = async () => ({ ok: false, error: 'not_supported', msg: '该功能已移除，请使用嵌入页登录' })

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ guestCookiesFilePath: string, accountsDir: string, getMainWindow: () => import('electron').BrowserWindow | null | undefined, electronDirname?: string }} opts
 */
export function registerGoofishSessionIPC(ipcMain, opts) {
  const guestCookiesFilePath = String(opts?.guestCookiesFilePath || '').trim()
  const accountsDir = String(opts?.accountsDir || '').trim()
  const getMainWindow = opts?.getMainWindow
  if (accountsDir) {
    initGoofishRiskCookieBridge({ accountsDir, getMainWindow })
  }
  initGoofishImVerifyNotifyBridge({ getMainWindow })
  const electronDirname = String(opts?.electronDirname || '').trim()

  ipcMain.handle('get-xianyu-mtop-cookie-for-task', async (_e, body = {}) => {
    const mode = String(body?.mode || '').trim() === 'account' ? 'account' : 'guest'
    if (mode === 'account') {
      return resolveAccountMtopCookieForTask(String(body?.accountId || '').trim(), {
        fresh: body?.fresh === true,
        forceRefresh: body?.forceRefresh === true || body?.force === true,
        electronDirname
      })
    }
    if (!guestCookiesFilePath) {
      return { ok: false, cookie: '', error: 'need_guest_login', msg: '未配置游客 Cookie 存储' }
    }
    const gr = await resolveGuestCookieForTask(guestCookiesFilePath, {
      taskId: String(body?.taskId || '').trim(),
      guestCookieHeader: body?.guestCookieHeader
    })
    if (!gr.ok) {
      return {
        ok: false,
        cookie: '',
        error: 'need_guest_login',
        msg: '游客模式还没有可用登录状态，请先在全域监听完成游客授权'
      }
    }
    return { ok: true, cookie: gr.cookie, source: gr.source, mode: 'guest', accountId: null }
  })

  /**
   * 令牌过期：单账号静默进闲鱼强刷 _m_h5_tk（非常规启动预热；成功后会 notify 上行）
   */
  ipcMain.handle('sxjk-refresh-account-mh5-token', async (_e, body = {}) => {
    const accountId = String(body?.accountId || body?.id || '').trim()
    if (!accountId) return { ok: false, cookie: '', error: 'missing_account_id' }
    return refreshAccountMh5TokenForExpired(accountId, { electronDirname })
  })

  /** 批量读账号分区 Cookie（供 syncCookies 一次 IPC 收集，避免逐账号 invoke） */
  ipcMain.handle('get-xianyu-mtop-cookies-for-sync-batch', async (_e, body = {}) => {
    const accountIds = Array.isArray(body?.accountIds)
      ? body.accountIds.map((x) => String(x || '').trim()).filter(Boolean)
      : []
    const items = []
    for (const id of accountIds.slice(0, 100)) {
      try {
        const r = await resolveAccountMtopCookieForTask(id, {
          fresh: true,
          skipRefresh: true,
          electronDirname
        })
        items.push({
          accountId: id,
          ok: r?.ok === true,
          cookie: r?.ok ? String(r.cookie || '').trim() : ''
        })
      } catch {
        items.push({ accountId: id, ok: false, cookie: '' })
      }
    }
    return { ok: true, items }
  })

  /** 服务端 pull 下行：明文 Cookie 注入本机账号分区（工作缓存） */
  ipcMain.handle('inject-cloud-mtop-cookies-batch', async (_e, body = {}) => {
    const { isAccountCookieUplinkHeld } = await import('../utils/goofish-cookie-uplink-hold.js')
    const list = Array.isArray(body?.items) ? body.items : []
    let injected = 0
    let skippedHold = 0
    const results = []
    const t0 = Date.now()
    for (const x of list.slice(0, 200)) {
      const id = String(x?.accountId || x?.client_id || x?.id || '').trim()
      const cookie = String(x?.cookie || x?.mtop_cookie || '').trim()
      if (!id || !cookie) {
        results.push({ accountId: id, ok: false, error: 'missing' })
        continue
      }
      // 关窗刚上行：禁止 pull 用旧云端盖掉本机新区（含 x5sec）
      if (isAccountCookieUplinkHeld(id)) {
        skippedHold += 1
        results.push({ accountId: id, ok: true, skipped: true, reason: 'uplink_hold' })
        continue
      }
      try {
        await syncGoofishCookiesIntoPartition(partitionForListingAccount(id), cookie, [], {
          clearBeforeInject: true
        })
        await flushAccountPartitionStore(id)
        injected += 1
        results.push({ accountId: id, ok: true })
      } catch (e) {
        results.push({ accountId: id, ok: false, error: String(e?.message || e) })
      }
    }
    if (list.length) {
      console.info(
        '[闲鱼Cookie] 云端 Cookie 批量注入完成 total=%d injected=%d skippedHold=%d ms=%d',
        list.length,
        injected,
        skippedHold,
        Date.now() - t0
      )
    }
    return { ok: true, injected, skippedHold, results }
  })

  ipcMain.handle('get-guest-cookie', async (_e, body = {}) => {
    if (!guestCookiesFilePath) return { ok: false, error: 'no_guest_store' }
    return getGuestCookieHeader(guestCookiesFilePath, {
      scope: body?.scope,
      taskId: body?.taskId
    })
  })

  ipcMain.handle('set-guest-cookie', async (_e, body = {}) => {
    if (!guestCookiesFilePath) return { ok: false, error: 'no_guest_store' }
    return setGuestCookieHeader(guestCookiesFilePath, body)
  })

  ipcMain.handle('clear-guest-cookie', async (_e, body = {}) => {
    if (!guestCookiesFilePath) return { ok: false, error: 'no_guest_store' }
    return clearGuestCookieHeader(guestCookiesFilePath, body)
  })

  ipcMain.handle('get-xianyu-mtop-guest-cookie-for-suggest', async () => {
    if (!guestCookiesFilePath) return { ok: false, cookie: '' }
    const gr = await getGuestCookieHeader(guestCookiesFilePath, { scope: 'global' })
    return gr.ok ? { ok: true, cookie: gr.cookie, updatedAt: gr.updatedAt } : { ok: false, cookie: '' }
  })

  ipcMain.handle('xianyu-guest-auth-in-app-window', async (_e, body = {}) => {
    if (!guestCookiesFilePath) return { ok: false, msg: '未配置游客 Cookie 存储' }
    if (body?.silent === true) {
      const taskId = String(body?.taskId || '').trim()
      return captureGuestCookieSilent({
        guestCookiesFilePath,
        electronDirname,
        taskId,
        force: body?.force === true
      })
    }
    try {
      const timeoutMs = Math.max(10_000, Number(body?.timeoutMs) || 180_000)
      const browserKey = String(body?.browserKey || '__guest_auth__').trim() || '__guest_auth__'
      const taskId = String(body?.taskId || '').trim()
      const scope = taskId ? 'task' : 'global'
      const openRes = await openGoofishUrlInAppBrowseWindow({
        url: GOOFISH_HOME_URL,
        electronDirname,
        browserKey,
        allowEmptyCookieHeader: true,
        guestAuthHint: true
      })
      if (!openRes.ok) return { ok: false, msg: openRes.error || '打开授权窗口失败' }

      const openedWin = openRes.window && !openRes.window.isDestroyed() ? openRes.window : null
      const partition = partitionPersistIdForGoofishBrowseShell(browserKey)
      const sess = session.fromPartition(partition)
      const deadline = Date.now() + timeoutMs
      let captured = ''
      while (Date.now() < deadline) {
        if (openedWin?.isDestroyed()) break
        const header = String(await cookiesToHeaderFromSession(sess)).trim()
        if (headerHasMh5Tk(header)) {
          captured = header
          break
        }
        await new Promise((r) => setTimeout(r, 1000))
      }
      if (openedWin && !openedWin.isDestroyed()) {
        setTimeout(() => {
          try {
            if (!openedWin.isDestroyed()) openedWin.close()
          } catch {
            /* */
          }
        }, 150)
      }
      if (!captured) {
        return { ok: false, msg: GUEST_COOKIE_AUTH_TIMEOUT_MSG }
      }
      const saved = await setGuestCookieHeader(guestCookiesFilePath, {
        scope,
        taskId,
        cookieHeader: captured
      })
      return saved.ok
        ? { ok: true, updatedAt: saved.updatedAt, cookieHeader: captured }
        : { ok: false, msg: saved.error || '保存失败' }
    } catch (e) {
      return { ok: false, msg: String(e?.message || e) }
    }
  })

  ipcMain.handle('open-xianyu-goofish-in-session', async (_e, payload) => {
    const opts =
      typeof payload === 'string'
        ? { url: payload.trim() }
        : payload && typeof payload === 'object'
          ? payload
          : {}
    const urlParse = parseAndValidateGoofishHttpsUrl(opts.url)
    if (!urlParse.ok) return { ok: false, msg: urlParse.msg }
    const mode = String(opts.mode || '').trim().toLowerCase()
    const rawAccountId = String(opts.accountId || '').trim()
    const useGuest =
      mode === 'guest' || rawAccountId === 'guest' || rawAccountId === '__guest__'
    const accountId = useGuest ? '' : rawAccountId
    let cookieHeader = String(opts.cookieHeader || '').trim()
    if (useGuest && !cookieHeader) {
      if (!guestCookiesFilePath) {
        return { ok: false, msg: '未配置游客 Cookie 存储' }
      }
      const gr = await getGuestCookieHeader(guestCookiesFilePath, { scope: 'global' })
      if (!gr.ok || !String(gr.cookie || '').trim()) {
        return {
          ok: false,
          msg: '游客还没有可用登录状态，请先在全域监听完成游客授权'
        }
      }
      cookieHeader = String(gr.cookie || '').trim()
    } else if (!cookieHeader && accountId) {
      const snap = await readAccountCookieHeader(accountId)
      if (snap.ok) cookieHeader = snap.cookie
    }
    const browserKey = useGuest ? '__guest__' : accountId || '__global__'
    const ephemeral = opts.ephemeralPartition === true
    const autoCloseMs = Math.max(0, Number(opts.autoCloseMs) || 0)
    const skipSaveIfNotLoggedIn = opts.skipSaveIfNotLoggedIn === true
    const waitForClose =
      !ephemeral &&
      !!accountId &&
      (autoCloseMs > 0 || opts.waitForClose !== false)
    const preferExisting =
      !ephemeral && opts.preferExistingSession !== false && !!accountId && !String(opts.cookieHeader || '').trim()
    const openRes = await openGoofishUrlInAppBrowseWindow({
      url: urlParse.url,
      cookieHeader: cookieHeader || undefined,
      electronDirname,
      browserKey,
      allowEmptyCookieHeader: !cookieHeader,
      ephemeralPartition: ephemeral,
      preferExistingSession: preferExisting,
      navigateOnReuse: !preferExisting,
      taskWindow: opts.taskWindow === true,
      silentBackground: opts.silentBackground === true
    })
    if (!openRes.ok) return { ok: false, msg: openRes.error || '打开失败' }
    if (accountsDir && accountId && !ephemeral) {
      await touchAccountGoofishPageOpenedAt(accountsDir, accountId, getMainWindow)
    }
    if (waitForClose && openRes.window && !openRes.window.isDestroyed()) {
      const browseWin = openRes.window
      browseWin.on('close', () => {
        try {
          const wc = browseWin.webContents
          if (wc && !wc.isDestroyed?.()) wc.stop()
        } catch {
          /* */
        }
        void (async () => {
          try {
            await repersistAccountPartitionCookiesForDisk(accountId)
            if (await partitionHasAccountLogin(accountId)) {
              await flushAccountPartitionStore(accountId)
            }
          } catch (e) {
            console.warn('[闲鱼会话] 关窗落盘失败:', accountId, e?.message || e)
          }
        })()
      })
      if (autoCloseMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, autoCloseMs))
        if (!browseWin.isDestroyed()) {
          if (skipSaveIfNotLoggedIn) {
            try {
              const abortSt = await readAutoLoginBrowseWindowShouldCloseWithoutSave(
                browseWin.webContents
              )
              if (abortSt.abort) {
                browseWin.close()
                await new Promise((resolve) => {
                  if (browseWin.isDestroyed()) resolve(undefined)
                  else browseWin.once('closed', resolve)
                })
                return {
                  ok: true,
                  skippedSave: true,
                  sessionVerified: false,
                  profileSynced: false,
                  cookiePersisted: false,
                  msg: String(abortSt.reasonText || '未登录，未保存').trim()
                }
              }
            } catch {
              /* 仍走正常关窗落盘 */
            }
          }
          try {
            browseWin.close()
          } catch {
            /* */
          }
        }
      }
      await new Promise((resolve) => {
        if (browseWin.isDestroyed()) resolve(undefined)
        else browseWin.once('closed', resolve)
      })
      if (accountsDir && accountId) {
        const sync = await finalizeGoofishBrowseWindowClose(accountsDir, accountId, {
          injectedCookieHeader: String(opts.cookieHeader || '').trim(),
          getMainWindow
        })
        notifyAccountProfileSynced(getMainWindow, accountId, sync)
        return {
          ...sync,
          /** 窗口已正常开关；是否「已登录」看 sessionVerified / profileSynced */
          ok: true,
          profileSynced: sync.profileSynced === true,
          cookiePersisted: sync.cookiePersisted === true,
          sessionVerified: sync.sessionVerified === true
        }
      }
    } else if (openRes.closedDuringOpen && accountsDir && accountId) {
      const sync = await finalizeGoofishBrowseWindowClose(accountsDir, accountId, {
        injectedCookieHeader: String(opts.cookieHeader || '').trim(),
        getMainWindow
      })
      notifyAccountProfileSynced(getMainWindow, accountId, sync)
      return {
        ...sync,
        ok: true,
        profileSynced: sync.profileSynced === true,
        cookiePersisted: sync.cookiePersisted === true,
        sessionVerified: sync.sessionVerified === true
      }
    }
    return { ok: true }
  })

  ipcMain.handle('goofish-miaopai-confirm-buy', async (_e, body = {}) => {
    const accountId = String(body?.accountId || '').trim()
    const itemId = String(body?.itemId || '').trim()
    const item =
      body?.item && typeof body.item === 'object'
        ? body.item
        : { itemId, title: body?.title, price: body?.price }

    async function writeGrabLogFromResult(result) {
      if (body?.skipGrabLog === true || !itemId) return
      const itemPic = String(
        body?.pic ||
          item?.pic ||
          (Array.isArray(item?.pics) ? item.pics[0] : '') ||
          ''
      )
        .trim()
        .slice(0, 512)
      await appendSxjkGrabLogEntry({
        ok: !!result?.ok,
        keyword: String(body?.keyword ?? '').slice(0, 120),
        taskId: String(body?.taskId ?? '').slice(0, 64),
        itemId,
        title: String(result?.title || body?.title || item?.title || '').slice(0, 8000),
        price: String(result?.price ?? body?.price ?? item?.price ?? '').slice(0, 48),
        city: String(body?.city || item?.city || '').slice(0, 48),
        pic: itemPic,
        accountId,
        orderId: String(result?.orderId || '').slice(0, 64),
        error: result?.ok ? '' : String(result?.error || result?.msg || '').slice(0, 2000),
        riskStepLabel: String(result?.riskStepLabel || '').slice(0, 32),
        captchaTried: !!result?.captchaTried,
        captchaOk: !!result?.captchaOk,
        captchaScope: String(result?.captchaScope || '').slice(0, 64),
        failedStep: String(result?.failedStep || '').slice(0, 64),
        failedApi: String(result?.failedApi || '').slice(0, 120)
      })
    }

    /** 自动过码已成功且仍失败时仍可弹 UI；仅成功不弹 */
    async function maybeOpenUiSliderAssist(result) {
      if (result?.ok || !result?.error) return result
      try {
        const cookieSnap = await readAccountCookieForApi(accountId, { requireUnb: false })
        if (!cookieSnap.ok) return result
        const assist = await runLockOrderRiskVerifyAssist({
          accountId,
          cookieHeader: cookieSnap.cookie,
          itemId,
          errText: result.error
        })
        if (assist?.sliderVerifyOpened || assist?.itemPageOpened) {
          result.sliderVerifyOpened = true
          result.itemPageOpened = true
          const stepHint = result.riskStepLabel
            ? `（风控接口：${result.riskStepLabel}）`
            : ''
          result.error =
            assist.hint ||
            `已打开闲鱼验证窗口${stepHint}：请拖动滑块完成验证后关闭窗口，再重新锁单。`
        }
      } catch (assistErr) {
        console.warn('[闲鱼秒拍确认] risk assist', assistErr?.message || assistErr)
      }
      return result
    }

    if (!accountId || !itemId) {
      return { ok: false, error: '缺少秒拍账号或商品 ID' }
    }
    const snap = await resolveAccountMtopCookieForTask(accountId, { electronDirname })
    if (!snap.ok) {
      const fail = {
        ok: false,
        error: snap.msg || snap.error || '该账号无有效登录凭证'
      }
      await writeGrabLogFromResult(fail)
      return fail
    }
    try {
      const data = await runLocalMiaopaiOrder({
        accountId,
        cookie: snap.cookie,
        electronDirname,
        deliverId: String(body?.deliverId || body?.deliver_id || '').trim(),
        item: { ...item, itemId: String(item?.itemId || itemId).trim() }
      })
      let result = {
        ok: data?.ok === true,
        itemId,
        title: String(data?.title || body?.title || '').trim(),
        price: String(data?.price || body?.price || '').trim(),
        orderId: String(data?.orderId || '').trim(),
        multiSku: !!data?.multiSku,
        skuResults: Array.isArray(data?.skuResults) ? data.skuResults : [],
        error: data?.ok ? '' : String(data?.error || data?.msg || '锁单失败'),
        msg: String(data?.msg || '').trim(),
        failedStep: String(data?.failedStep || '').trim(),
        failedApi: String(data?.failedApi || '').trim(),
        riskStepLabel: String(data?.riskStepLabel || '').trim(),
        captchaTried: !!data?.captchaTried,
        captchaOk: !!data?.captchaOk,
        captchaScope: String(data?.captchaScope || '').trim(),
        debugSteps: Array.isArray(data?.debugSteps) ? data.debugSteps : []
      }
      result = await maybeOpenUiSliderAssist(result)
      await writeGrabLogFromResult(result)
      return result
    } catch (e) {
      let fail = { ok: false, error: String(e?.message || e) }
      fail = await maybeOpenUiSliderAssist(fail)
      await writeGrabLogFromResult(fail)
      return fail
    }
  })

  ipcMain.handle('sxjk-miaopai-list-deliver-address', async (_e, body = {}) => {
    const accountId = String(body?.accountId || '').trim()
    if (!accountId) return { ok: false, list: [], error: '请先选择秒拍账号' }
    try {
      return await listLocalMiaopaiDeliverAddresses({ accountId, electronDirname })
    } catch (e) {
      return { ok: false, list: [], error: String(e?.message || e || '收货地址获取失败') }
    }
  })

  ipcMain.handle('sxjk-assist-lock-order-risk-verify', async (_e, body = {}) => {
    const accountId = String(body?.accountId || '').trim()
    const itemId = String(body?.itemId || '').trim()
    const errText = String(body?.errText || body?.error || '').trim()
    if (!accountId || !itemId || !errText) {
      return { opened: false, itemPageOpened: false, sliderVerifyOpened: false }
    }
    const snap = await readAccountCookieForApi(accountId, { requireUnb: false })
    if (!snap.ok) {
      return {
        opened: false,
        itemPageOpened: false,
        sliderVerifyOpened: false,
        hint: snap.error || '无法读取锁单账号 Cookie'
      }
    }
    const assist = await runLockOrderRiskVerifyAssist({
      accountId,
      cookieHeader: snap.cookie,
      itemId,
      errText
    })
    return {
      opened: !!assist?.opened,
      itemPageOpened: !!assist?.itemPageOpened,
      sliderVerifyOpened: !!assist?.sliderVerifyOpened,
      hint: String(assist?.hint || '').trim()
    }
  })

  ipcMain.handle('sxjk-upload-goofish-chat-image', async (_e, payload = {}) => {
    const maxBytes = Math.min(
      10 * 1024 * 1024,
      Math.max(
        4096,
        parseInt(String(process.env.SXJK_GOOFISH_UPLOAD_MAX_BYTES || `${6 * 1024 * 1024}`), 10) ||
          6 * 1024 * 1024
      )
    )
    const b64 = String(payload?.dataBase64 ?? payload?.base64 ?? '').trim()
    if (!b64) return { ok: false, msg: '缺少图片数据' }
    let buf
    try {
      buf = Buffer.from(b64, 'base64')
    } catch {
      return { ok: false, msg: '图片数据格式无效' }
    }
    if (buf.length > maxBytes) return { ok: false, msg: `图片过大（>${maxBytes} 字节）` }
    const mode = String(payload?.mode || '').trim() === 'account' ? 'account' : 'guest'
    let cookie = ''
    if (mode === 'account') {
      const accountId = String(payload?.accountId || '').trim()
      if (!accountId) {
        return { ok: false, msg: '请先选择上传用的闲鱼账号' }
      }
      const acc = await readAccountCookieForApi(accountId, { requireUnb: true })
      if (!acc.ok) {
        return {
          ok: false,
          msg: acc.error || '无法读取账号 Cookie：请先在「账号管理」登录闲鱼并保存凭证',
          debug: { mode, accountId, hasCookie: !!acc.cookie }
        }
      }
      cookie = acc.cookie
    } else if (guestCookiesFilePath) {
      const gr = await getGuestCookieHeader(guestCookiesFilePath, { scope: 'global' })
      if (!gr.ok) return { ok: false, msg: '游客登录状态不可用' }
      cookie = gr.cookie
    }
    if (!headerHasMh5Tk(cookie)) {
      const debug = {
        mode,
        hasCookie: !!cookie,
        hasMh5Tk: false,
        fileBytes: buf.length,
        filename: String(payload?.filename || '').trim() || 'image.png'
      }
      console.warn('[闲鱼聊天图片上传] cookie unusable', debug)
      return {
        ok: false,
        msg: mode === 'account'
          ? '账号 Cookie 不可用：请先在「账号管理」登录闲鱼并保存凭证'
          : '游客登录状态不可用：请先在「全域监听」完成游客授权',
        debug
      }
    }
    const result = await uploadGoofishChatImage({
      cookieStr: cookie,
      buffer: buf,
      filename: payload?.filename,
      mimeType: payload?.mimeType
    })
    if (!result?.ok) {
      console.warn('[闲鱼聊天图片上传] upload fail', {
        mode,
        hasCookie: !!cookie,
        hasMh5Tk: true,
        fileBytes: buf.length,
        msg: result?.msg,
        debug: result?.debug
      })
      return {
        ok: false,
        msg: result?.msg || '上传失败',
        debug: {
          mode,
          hasCookie: true,
          hasMh5Tk: true,
          fileBytes: buf.length,
          ...(result?.debug && typeof result.debug === 'object' ? result.debug : {})
        }
      }
    }
    return result
  })

  ipcMain.handle('sxjk-goofish-im-warmup', async (_e, body = {}) => {
    const accountId = String(body?.accountId || '').trim()
    if (!accountId) return { ok: false, msg: '请选择监控账号' }
    // fresh：flush 后再读，确保用关窗/过码后的最新分区 Cookie
    const snap = await readAccountCookieForApi(accountId, { requireUnb: true, fresh: true })
    if (!snap.ok) {
      return { ok: false, msg: humanizeGoofishImErrorMain(snap.error || '无法读取账号登录信息') }
    }
    try {
      // 成功时才清「已弹过滑块」标记；每次点连接都清会导致过码后再点又弹空窗
      if (body?.openImWindowDirect === true) {
        const openIm = await openGoofishImPageForManualConnectAndWaitClose({
          accountId,
          cookieHeader: snap.cookie
        })
        if (!openIm?.ok) {
          return { ok: false, msg: humanizeGoofishImErrorMain(String(openIm?.hint || '消息页未能打开')) }
        }
      }
      const snap2 = await readAccountCookieForApi(accountId, { requireUnb: true, fresh: true })
      const cookieForWarmup = snap2.ok ? snap2.cookie : snap.cookie
      const result = await runGoofishImWarmupWithPersist({
        cookieHeader: cookieForWarmup,
        accountsDir,
        accountId,
        suppressSliderAssist: false,
        allowSliderCloseRetry: true
      })
      if (!result.ok) {
        const msg = result.sliderVerifyOpened
          ? GOOFISH_IM_VERIFY_OPENED_HINT
          : String(result.sliderVerifyHint || result.error || '私聊通道连接失败').trim()
        return {
          ok: false,
          msg: humanizeGoofishImErrorMain(msg),
          sliderVerifyOpened: !!result.sliderVerifyOpened,
          sliderVerifyHint: result.sliderVerifyHint || ''
        }
      }
      clearImSliderAssistUsed(accountId)
      return { ok: true, sid: result.sid }
    } catch (e) {
      return { ok: false, msg: String(e?.message || e) }
    }
  })

  ipcMain.handle('sxjk-goofish-im-test-send', async (_e, body = {}) => {
    const mode = String(body?.mode || '').trim().toLowerCase()
    const useGuest = mode === 'guest' || String(body?.accountId || '').trim() === 'guest'
    const peerUserId = String(body?.peerUserId || '').trim()
    if (!peerUserId) return { ok: false, msg: '缺少对方用户 id' }

    let cookie = ''
    let accountId = String(body?.accountId || '').trim()
    if (useGuest) {
      if (!guestCookiesFilePath) {
        return { ok: false, msg: '未配置游客 Cookie 存储' }
      }
      const gr = await getGuestCookieHeader(guestCookiesFilePath, { scope: 'global' })
      if (!gr.ok || !String(gr.cookie || '').trim()) {
        return {
          ok: false,
          msg: '游客还没有可用登录状态，请先在全域监听完成游客授权'
        }
      }
      cookie = String(gr.cookie || '').trim()
      accountId = 'guest'
    } else {
      if (!accountId) return { ok: false, msg: '请选择监控账号' }
      const snap = await readAccountCookieForApi(accountId, { requireUnb: true })
      if (!snap.ok) return { ok: false, msg: snap.error || '无法读取账号 Cookie' }
      cookie = snap.cookie
    }

    const imageUrl = String(body?.imageUrl ?? '').trim()
    const imageWidth = parseInt(String(body?.imageWidth ?? ''), 10)
    const imageHeight = parseInt(String(body?.imageHeight ?? ''), 10)
    const wantImage =
      imageUrl &&
      /^https:\/\//i.test(imageUrl) &&
      Number.isFinite(imageWidth) &&
      imageWidth > 0 &&
      Number.isFinite(imageHeight) &&
      imageHeight > 0
    try {
      if (wantImage) {
        const r = await sxjkGoofishImTestSendImage({
          cookieHeader: cookie,
          accountsDir,
          accountId,
          peerUserId,
          imageUrl: imageUrl.slice(0, 2048),
          imageWidth,
          imageHeight,
          itemId: String(body?.itemId || '').trim() || undefined
        })
        return { ok: true, sid: r.sid, cid: r.cid, toId: r.toId, accountId }
      }
      const text = String(body?.text || '【上新监控】打招呼测试').trim().slice(0, 500)
      const r = await sxjkGoofishImTestSendText({
        cookieHeader: cookie,
        accountsDir,
        accountId,
        peerUserId,
        text,
        itemId: String(body?.itemId || '').trim() || undefined
      })
      return { ok: true, sid: r.sid, cid: r.cid, toId: r.toId, accountId }
    } catch (e) {
      const msg = String(e?.message || e)
      let imPageOpened = false
      let sliderVerifyOpened = false
      let outMsg = msg
      if (!useGuest && accountId) {
        const challengeBody = inferMtopAntiBotBodyFromImError(e)
        if (shouldOpenImSliderAssistForChallenge(challengeBody)) {
          try {
            const v = await runMtopAntiBotVerifyAssist(challengeBody, {
              cookieHeader: cookie,
              accountId,
              browserKey: accountId,
              openImPageOnSlider: true,
              retryImRealtimeOnClose: false,
              forceSliderAssist: true,
              notifySource: 'greeting'
            })
            const hint = String(v?.hint || '').trim()
            if (v?.opened) {
              imPageOpened = true
              sliderVerifyOpened = true
              outMsg = hint || GOOFISH_IM_VERIFY_OPENED_HINT
            } else if (hint) {
              outMsg = hint
            }
          } catch (assistErr) {
            console.warn(
              '[闲鱼私聊试发] antibot assist',
              assistErr?.message || assistErr
            )
          }
        }
        if (!imPageOpened) {
          try {
            const opened = await tryOpenGoofishImPageOnGreetingVerifyFailure({
              accountId,
              cookieHeader: cookie,
              errText: msg
            })
            imPageOpened = !!opened?.opened
            if (imPageOpened) {
              outMsg = GOOFISH_IM_VERIFY_OPENED_HINT
            }
          } catch (openErr) {
            console.warn('[闲鱼私聊试发] 风控后打开消息页失败', openErr?.message || openErr)
          }
        }
      }
      return {
        ok: false,
        msg: humanizeGoofishImErrorMain(outMsg),
        imPageOpened,
        ...mtopSliderVerifyIpcFields({ opened: sliderVerifyOpened, hint: outMsg })
      }
    }
  })

  ipcMain.handle('sxjk-goofish-im-ingest-greeting-prefetch', async (_e, body = {}) => {
    const accountId = String(body?.accountId || '').trim()
    const rows = Array.isArray(body?.rows) ? body.rows : []
    const ingested = ingestSxjkGreetingPrefetchRows(accountId, rows)
    const win = getMainWindow?.()
    if (win && !win.isDestroyed()) {
      win.webContents.send('sxjk-greeting-detail-prefetch', { accountId, rows, ingested })
    }
    return { ok: true, ingested }
  })

  const removed = [
    'open-xianyu-mtop-login',
    'close-xianyu-mtop-login',
    'persist-xianyu-mtop-cookie-from-mtop-refresh',
    'persist-managed-account-mtop-from-mtop-refresh',
    'persist-xianyu-guest-cookie-from-mtop-refresh',
    'set-xianyu-mtop-cookie-manual',
    'xianyu-mtop-playwright-capture',
    'xianyu-mtop-refresh-session-playwright',
    'xianyu-mtop-managed-account-login',
    'xianyu-mtop-managed-account-http-refresh',
    'xianyu-background-auto-login-round',
    'xianyu-mtop-capture-from-embed-partition',
    'xianyu-wait-boot-session-prep',
    'get-xianyu-credential-sync-meta',
    'get-xianyu-mtop-session-meta',
    'get-xianyu-mtop-saved-cookie-for-edit',
    'get-xianyu-mtop-cookie-status',
    'get-xianyu-mtop-cookie-for-api',
    'refresh-xianyu-mtop-guest-cookie-for-suggest',
    'clear-xianyu-mtop-session',
    'apply-xianyu-managed-account-session',
    'xianyu-goofish-qr-create',
    'xianyu-goofish-qr-step',
    'xianyu-goofish-qr-cancel',
    'persist-managed-account-from-goofish-qr',
    'xianyu-mtop-detect-browser-env'
  ]
  for (const ch of removed) {
    ipcMain.handle(ch, notSupported)
  }
}

export { readCookieHeaderFromPartition, readAccountCookieHeader }
