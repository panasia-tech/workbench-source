/**
 * 鱼小铺 seller 嵌入页 / 应用内登录弹窗脚本（与闲鱼工作台多开 accounts.js 同源）：
 * - 自动点「保持登录状态」（登录弹窗 / 淘宝系会话确认）
 * - 自动点「快速进入」越过登录中转页，避免长期停在「服务器忙」
 * - 隐藏嵌入顶栏右侧（通知/用户信息等），减少与外壳 UI 重叠
 */

const GOOFISH_QUICK_ENTRY_JS = `(function(){
  try {
    function visible(el) {
      if (!el || !el.getClientRects) return false
      const st = window.getComputedStyle(el)
      if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity || '1') === 0) return false
      if (st.pointerEvents === 'none') return false
      const r = el.getBoundingClientRect()
      return r.width > 2 && r.height > 2
    }
    function normText(el) {
      return (el && (el.innerText || el.textContent) || '').replace(/\\s+/g, ' ').trim()
    }
    function isQuickLabel(raw) {
      const s = (raw || '').replace(/\\s+/g, ' ').trim()
      if (s === '快速进入') return true
      if (s.indexOf('快速进入') === -1) return false
      return s.length <= 32
    }
    function tryClick(el) {
      if (!el || !visible(el)) return false
      try {
        el.click()
        return true
      } catch (e) {
        try {
          const ev = new MouseEvent('click', { bubbles: true, cancelable: true, view: window })
          el.dispatchEvent(ev)
          return true
        } catch (_) {
          return false
        }
      }
    }
    function scanRoot(root) {
      if (!root || !root.querySelectorAll) return false
      const tags = ['button', 'a', '[role="button"]', 'input[type="button"]', 'input[type="submit"]', '[class*="btn"]']
      for (const sel of tags) {
        let list
        try {
          list = root.querySelectorAll(sel)
        } catch (_) {
          continue
        }
        for (const el of list) {
          if (!isQuickLabel(normText(el))) continue
          if (tryClick(el)) return true
        }
      }
      for (const el of root.querySelectorAll('div, span')) {
        if (!isQuickLabel(normText(el))) continue
        if (!visible(el)) continue
        const tag = el.tagName
        if (tag === 'BUTTON' || tag === 'A' || el.getAttribute('role') === 'button' || typeof el.onclick === 'function') {
          if (tryClick(el)) return true
        }
      }
      return false
    }
    function walkShadow(root) {
      if (scanRoot(root)) return true
      const nodes = root.querySelectorAll ? root.querySelectorAll('*') : []
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i]
        if (n.shadowRoot && walkShadow(n.shadowRoot)) return true
      }
      return false
    }
    if (document.body && walkShadow(document)) return true
    return false
  } catch (e) {
    return false
  }
})();`

/** 登录弹窗 / passport：自动点「保持登录状态」或勾选对应复选框 */
const GOOFISH_KEEP_LOGIN_STATE_JS = `(function(){
  try {
    function visible(el) {
      if (!el || !el.getClientRects) return false
      const st = window.getComputedStyle(el)
      if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity || '1') === 0) return false
      if (st.pointerEvents === 'none') return false
      const r = el.getBoundingClientRect()
      return r.width > 2 && r.height > 2
    }
    function normText(el) {
      return (el && (el.innerText || el.textContent) || '').replace(/\\s+/g, ' ').trim()
    }
    function isKeepLoginLabel(raw) {
      const s = (raw || '').replace(/\\s+/g, ' ').trim()
      if (!s || s.indexOf('保持') === -1 || s.indexOf('登录') === -1) return false
      if (s === '保持登录状态' || s === '保持登录') return true
      return s.length <= 32
    }
    function tryClick(el) {
      if (!el || !visible(el)) return false
      try {
        el.click()
        return true
      } catch (e) {
        try {
          const ev = new MouseEvent('click', { bubbles: true, cancelable: true, view: window })
          el.dispatchEvent(ev)
          return true
        } catch (_) {
          return false
        }
      }
    }
    function tryCheckboxNear(el) {
      if (!el) return false
      const box =
        (el.tagName === 'INPUT' && String(el.type || '').toLowerCase() === 'checkbox' && el) ||
        el.querySelector?.('input[type="checkbox"]') ||
        (el.htmlFor && document.getElementById(el.htmlFor)) ||
        el.closest?.('label')?.querySelector?.('input[type="checkbox"]')
      if (box && !box.checked) return tryClick(box)
      return false
    }
    function scanRoot(root) {
      if (!root || !root.querySelectorAll) return false
      const tags = ['button', 'a', '[role="button"]', 'label', 'span', 'motion.div', 'motion.button', 'div']
      for (const sel of tags) {
        let list
        try {
          list = root.querySelectorAll(sel)
        } catch (_) {
          continue
        }
        for (const el of list) {
          if (!isKeepLoginLabel(normText(el))) continue
          if (tryCheckboxNear(el)) return true
          if (tryClick(el)) return true
        }
      }
      for (const el of root.querySelectorAll('input[type="checkbox"]')) {
        const label =
          (el.id && root.querySelector('label[for="' + el.id.replace(/"/g, '') + '"]')) ||
          el.closest('label')
        const t = normText(label) || normText(el.parentElement)
        if (!isKeepLoginLabel(t)) continue
        if (!el.checked && tryClick(el)) return true
      }
      return false
    }
    function walkShadow(root) {
      if (scanRoot(root)) return true
      const nodes = root.querySelectorAll ? root.querySelectorAll('*') : []
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i]
        if (n.shadowRoot && walkShadow(n.shadowRoot)) return true
      }
      return false
    }
    if (document.body && walkShadow(document)) return true
    return false
  } catch (e) {
    return false
  }
})();`

const GOOFISH_HIDE_EMBEDDED_HEADER_RIGHT_JS = `(function(){
  try {
    const KEY = '__xySxjkHideGoofishHeaderRight'
    const SEL = '[class*="headerRight--"],[class*="userInfoWrap--"]'
    function injectCss(root) {
      if (!root || !root.documentElement) return
      const id = 'xy-sxjk-hide-goofish-header-right-css'
      if (root.getElementById(id)) return
      const s = root.createElement('style')
      s.id = id
      s.textContent = SEL + '{display:none!important;visibility:hidden!important}'
      root.documentElement.appendChild(s)
    }
    function applyInline(root) {
      if (!root || !root.querySelectorAll) return
      root.querySelectorAll(SEL).forEach((el) => {
        try {
          el.style.setProperty('display', 'none', 'important')
        } catch (_) {
          try { el.style.display = 'none' } catch (_) {}
        }
      })
    }
    function install(root) {
      const w = root.defaultView || (typeof window !== 'undefined' ? window : null)
      if (!w || !root.documentElement) return
      if (w[KEY]) return
      w[KEY] = true
      injectCss(root)
      applyInline(root)
      try {
        const mo = new MutationObserver(() => applyInline(root))
        mo.observe(root.documentElement, { childList: true, subtree: true })
      } catch (_) {}
    }
    install(document)
    return true
  } catch (_) {
    return false
  }
})();`

const quickEntryHooked = new WeakSet()
const quickEntryTimers = new WeakMap()
const hideHeaderHooked = new WeakSet()
const hideHeaderTimers = new WeakMap()

function clearTimerMap(map, wc) {
  const ids = map.get(wc)
  if (ids && Array.isArray(ids)) ids.forEach((t) => clearTimeout(t))
  map.delete(wc)
}

function throttle(fn, ms) {
  let last = 0
  let pending = null
  return () => {
    const now = Date.now()
    const run = () => {
      last = Date.now()
      pending = null
      fn()
    }
    if (now - last >= ms) {
      run()
      return
    }
    if (pending) clearTimeout(pending)
    pending = setTimeout(run, ms - (now - last))
  }
}

async function runInjectedLoginAssistInWebContents(webContents, js) {
  if (!webContents || webContents.isDestroyed()) return false
  const runInFrame = async (frame) => {
    if (!frame || frame.isDestroyed?.() || frame.detached) return false
    try {
      return (await frame.executeJavaScript(js, true)) === true
    } catch {
      return false
    }
  }
  try {
    const root = webContents.mainFrame
    if (root && !root.isDestroyed?.() && !root.detached) {
      const frames = root.framesInSubtree
      if (frames?.length) {
        for (const frame of frames) {
          if (await runInFrame(frame)) return true
        }
        return false
      }
    }
  } catch {
    /* */
  }
  try {
    return (await webContents.executeJavaScript(js, true)) === true
  } catch {
    return false
  }
}

async function tryRunKeepLoginStateScript(webContents) {
  return runInjectedLoginAssistInWebContents(webContents, GOOFISH_KEEP_LOGIN_STATE_JS)
}

async function tryRunQuickEntryScript(webContents) {
  return runInjectedLoginAssistInWebContents(webContents, GOOFISH_QUICK_ENTRY_JS)
}

function scheduleGoofishLoginAssistAttempts(webContents) {
  if (!webContents || webContents.isDestroyed()) return
  clearTimerMap(quickEntryTimers, webContents)
  const delays = [200, 600, 1200, 2200, 3800, 6000, 9000, 12000]
  const ids = delays.map((ms) =>
    setTimeout(() => {
      void (async () => {
        await tryRunKeepLoginStateScript(webContents)
        await tryRunQuickEntryScript(webContents)
      })()
    }, ms)
  )
  quickEntryTimers.set(webContents, ids)
}

async function tryRunHideEmbeddedHeaderRightScript(webContents) {
  if (!webContents || webContents.isDestroyed()) return
  const runInFrame = async (frame) => {
    if (!frame || frame.isDestroyed?.() || frame.detached) return
    try {
      await frame.executeJavaScript(GOOFISH_HIDE_EMBEDDED_HEADER_RIGHT_JS, true)
    } catch {
      /* */
    }
  }
  try {
    await webContents.executeJavaScript(GOOFISH_HIDE_EMBEDDED_HEADER_RIGHT_JS, true)
  } catch {
    /* */
  }
  try {
    const root = webContents.mainFrame
    if (root && !root.isDestroyed?.() && !root.detached) {
      const frames = root.framesInSubtree
      if (frames?.length) {
        for (const frame of frames) {
          await runInFrame(frame)
        }
      }
    }
  } catch {
    /* */
  }
}

function scheduleHideEmbeddedHeaderRightAttempts(webContents) {
  if (!webContents || webContents.isDestroyed()) return
  clearTimerMap(hideHeaderTimers, webContents)
  const delays = [0, 120, 400, 900, 1800, 3200, 5500]
  const ids = delays.map((ms) =>
    setTimeout(() => {
      void tryRunHideEmbeddedHeaderRightScript(webContents)
    }, ms)
  )
  hideHeaderTimers.set(webContents, ids)
}

/** seller / 登录中转页 / 登录弹窗：自动点「保持登录状态」「快速进入」 */
export function attachGoofishSellerQuickEntryAutoClick(webContents) {
  attachGoofishLoginAssistAutoClick(webContents)
}

export function attachGoofishLoginAssistAutoClick(webContents) {
  if (!webContents || webContents.isDestroyed()) return
  if (quickEntryHooked.has(webContents)) return
  quickEntryHooked.add(webContents)
  const run = () => scheduleGoofishLoginAssistAttempts(webContents)
  const runOnSubframes = throttle(run, 1200)
  webContents.on('did-finish-load', run)
  webContents.on('dom-ready', run)
  webContents.on('did-navigate', run)
  webContents.on('did-navigate-in-page', run)
  webContents.on('did-frame-finish-load', runOnSubframes)
  webContents.once('destroyed', () => clearTimerMap(quickEntryTimers, webContents))
}

/** 嵌入页隐藏闲鱼顶栏右侧，避免与账号管理顶栏重复 */
export function attachGoofishSellerHideEmbeddedHeaderRight(webContents) {
  if (!webContents || webContents.isDestroyed()) return
  if (hideHeaderHooked.has(webContents)) return
  hideHeaderHooked.add(webContents)
  const run = () => scheduleHideEmbeddedHeaderRightAttempts(webContents)
  const runOnSubframes = throttle(run, 1200)
  webContents.on('did-finish-load', run)
  webContents.on('dom-ready', run)
  webContents.on('did-navigate', run)
  webContents.on('did-navigate-in-page', run)
  webContents.on('did-frame-finish-load', runOnSubframes)
  webContents.once('destroyed', () => clearTimerMap(hideHeaderTimers, webContents))
}

export function attachGoofishSellerEmbedPageHooks(webContents) {
  attachGoofishLoginAssistAutoClick(webContents)
  attachGoofishSellerHideEmbeddedHeaderRight(webContents)
}

const SELLER_PAGE_READY_JS = `(function(){
  try {
    const href = String(location.href || '')
    if (!/seller\\.goofish\\.com/i.test(href)) return false
    const t = String((document.body && (document.body.innerText || document.body.textContent)) || '')
      .replace(/\\s+/g, ' ')
      .trim()
    if (!t) return false
    if (t.indexOf('服务器忙') >= 0) return false
    if (t.indexOf('快速进入') >= 0 && t.indexOf('其他账号登录') >= 0) return false
    return true
  } catch (_) {
    return false
  }
})()`

/** 是否已进入鱼小铺工作台（非登录中转 / 服务器忙页） */
export async function sellerWorkbenchPageLooksReady(webContents) {
  if (!webContents || webContents.isDestroyed()) return false
  try {
    return (await webContents.executeJavaScript(SELLER_PAGE_READY_JS, true)) === true
  } catch {
    return false
  }
}

export async function runGoofishSellerQuickEntryOnce(webContents) {
  await tryRunKeepLoginStateScript(webContents)
  return tryRunQuickEntryScript(webContents)
}
