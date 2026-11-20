/**
 * 主进程统一走后端 execute API（经渲染进程桥接）
 */
import { createSxjkBackendPost } from './sxjk-backend-bridge.js'

/** @type {ReturnType<createSxjkBackendPost> | null} */
let postFn = null

/**
 * @param {() => import('electron').BrowserWindow | null | undefined} getMainWindow
 */
export function initSxjkBackendClient(getMainWindow) {
  postFn = createSxjkBackendPost(getMainWindow)
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} [body]
 */
export async function sxjkBackendPost(path, body = {}, opts = {}) {
  if (!postFn) throw new Error('后端客户端未初始化')
  return postFn(path, body, opts)
}
