/**
 * 登录检测等：服务端只算 sign，主进程本机 POST h5api（与 windows-mode-v2 一致，避免服务端 IP 误判掉线）。
 */
import { postSignedMtopRequest } from '../utils/sxjk-post-signed-mtop.js'

/**
 * @param {import('electron').IpcMain} ipcMain
 */
export function registerSxjkLoginMtopIPC(ipcMain) {
  ipcMain.handle('sxjk-post-signed-mtop-request', async (_e, body = {}) => {
    return postSignedMtopRequest(body)
  })
}
