/**
 * 闲鱼私聊「实时通道」：MTOP 取 IM Token → wss-goofish 建连 → /reg 并保活（对齐 XianYuApis）。
 * 同账号后续发消息复用连接，不再每条重取 token。
 */
import { warmupGoofishImWsOnce } from './goofish-im-ws-private-text.js'
import {
  applyAccountGoofishImRealtimeMeta,
  broadcastAccountImRealtimeChanged
} from '../ipc/accounts.js'
import { runMtopAntiBotVerifyAssist, mtopSliderVerifyIpcFields } from './goofish-mtop-antibot-verify-assist.js'
import { clearImSliderAssistUsed } from './goofish-im-slider-once-guard.js'
import {
  GOOFISH_IM_NEED_VERIFY_HINT,
  GOOFISH_IM_VERIFY_OPENED_HINT,
  humanizeGoofishImErrorMain,
  inferMtopAntiBotBodyFromImError,
  shouldOpenImSliderAssistForChallenge
} from './goofish-im-user-hints.js'

/**
 * @param {{
 *   cookieHeader: string,
 *   accountsDir: string,
 *   accountId: string,
 *   persistMergedCookie?: (mergedHeader: string) => void | Promise<void>,
 *   suppressSliderAssist?: boolean,
 *   allowSliderCloseRetry?: boolean
 * }} opts
 */
export async function runGoofishImWarmupWithPersist(opts) {
  const cookieHeader = String(opts?.cookieHeader || '').trim()
  const accountsDir = String(opts?.accountsDir || '').trim()
  const accountId = String(opts?.accountId || '').trim()
  if (!cookieHeader) return { ok: false, error: '缺少登录信息' }
  if (!accountsDir || !accountId) return { ok: false, error: '缺少账号信息' }

  async function persistRealtimeMeta(ok, err = '') {
    await applyAccountGoofishImRealtimeMeta(accountsDir, accountId, { ok, err })
    broadcastAccountImRealtimeChanged(accountId, { ok, err })
  }

  try {
    const r = await warmupGoofishImWsOnce({ cookieHeader, accountsDir, accountId })
    const merged = String(r?.cookieHeader || '').trim()
    if (merged && typeof opts.persistMergedCookie === 'function') {
      await opts.persistMergedCookie(merged)
    }
    clearImSliderAssistUsed(accountId)
    await persistRealtimeMeta(true)
    return {
      ok: true,
      sid: r?.sid,
      cookieHeader: merged || cookieHeader
    }
  } catch (e) {
    const challengeBody = inferMtopAntiBotBodyFromImError(e)
    try {
      const ret = Array.isArray(e?.body?.ret) ? e.body.ret.join(' | ') : String(e?.body?.ret || e?.message || e)
      console.warn('[闲鱼私聊] 预热失败原始原因', accountId, String(ret).slice(0, 240))
    } catch {
      /* */
    }
    // 仅真风控/滑块才弹窗；IM 注册超时、未收到 sid、会话过期等只提示，不开「拖滑块」空窗
    if (shouldOpenImSliderAssistForChallenge(challengeBody)) {
      const mayOpenSlider =
        opts.suppressSliderAssist !== true && opts.allowSliderCloseRetry === true
      if (mayOpenSlider) {
        const v = await runMtopAntiBotVerifyAssist(challengeBody, {
          cookieHeader,
          accountId,
          browserKey: accountId,
          openImPageOnSlider: true,
          retryImRealtimeOnClose: true,
          notifySource: 'warmup'
        })
        const hint = String(v?.hint || '').trim()
        let errMsg = hint
        if (v?.opened) {
          errMsg = errMsg || GOOFISH_IM_VERIFY_OPENED_HINT
        } else if (!errMsg) {
          errMsg = humanizeGoofishImErrorMain(String(e?.message || e))
        }
        await persistRealtimeMeta(false, errMsg)
        return {
          ok: false,
          error: errMsg,
          ...mtopSliderVerifyIpcFields(v)
        }
      }
      await persistRealtimeMeta(false, GOOFISH_IM_NEED_VERIFY_HINT)
      return { ok: false, error: GOOFISH_IM_NEED_VERIFY_HINT }
    }
    const errMsg = humanizeGoofishImErrorMain(String(e?.message || e))
    await persistRealtimeMeta(false, errMsg)
    return { ok: false, error: errMsg }
  }
}
