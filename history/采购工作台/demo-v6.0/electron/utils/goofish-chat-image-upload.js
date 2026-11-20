/**
 * 聊天图片上传到闲鱼 CDN（与 xianyu-login-lite/src/chat-image-upload.mjs 一致：
 * POST https://stream-upload.goofish.com/api/upload.api?floderId=0&appkey=xy_chat&_input_charset=utf-8）
 */
import crypto from 'node:crypto'
import axios from 'axios'

const UPLOAD_API = 'https://stream-upload.goofish.com/api/upload.api'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'

/**
 * @param {{ cookieStr?: string, cookieHeader?: string, buffer: Buffer, filename?: string, mimeType?: string }} p
 * @returns {Promise<{ ok: boolean, url?: string, width?: number, height?: number, msg?: string, debug?: Record<string, unknown> }>}
 */
export async function uploadGoofishChatImage(p) {
  const filename = p.filename || 'image.png'
  const mimeType = p.mimeType || 'image/png'
  const cookieStr = String(p.cookieStr || p.cookieHeader || '').trim()
  const boundary = `----WebKitFormBoundary${crypto.randomBytes(8).toString('hex')}`
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${String(filename).replace(/"/g, '')}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
    'utf8'
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  const body = Buffer.concat([head, p.buffer, tail])

  const q = new URLSearchParams({
    floderId: '0',
    appkey: 'xy_chat',
    _input_charset: 'utf-8'
  })

  try {
    const res = await axios.post(`${UPLOAD_API}?${q}`, body, {
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Cookie: cookieStr,
        Accept: '*/*',
        Origin: 'https://www.goofish.com',
        Referer: 'https://www.goofish.com/',
        'User-Agent': UA
      },
      validateStatus: () => true,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    })

    const rawText = typeof res.data === 'string' ? res.data : ''
    const looksLikeLoginHtml = /<!DOCTYPE\s+html/i.test(rawText) || /<title>闲鱼/i.test(rawText)
    const data = res.data
    const obj = data?.object
    if (!obj?.url) {
      if (looksLikeLoginHtml) {
        const msg = '闲鱼返回了登录页：请先在「账号管理」完成账号登录后再上传'
        const debug = {
          httpStatus: res.status,
          hasCookie: !!cookieStr,
          fileBytes: p.buffer?.length ?? 0,
          apiHint: 'login_html'
        }
        console.error('[闲鱼聊天图片] 登录页HTML', debug)
        return { ok: false, msg, debug }
      }
      const hint = typeof data === 'object' ? JSON.stringify(data).slice(0, 300) : String(data).slice(0, 300)
      const msg = `闲鱼接口未返回图片地址（HTTP ${res.status}）${hint ? `：${hint}` : ''}`
      const debug = {
        httpStatus: res.status,
        hasCookie: !!cookieStr,
        fileBytes: p.buffer?.length ?? 0,
        apiHint: hint
      }
      console.error('[闲鱼聊天图片] 失败', debug)
      return { ok: false, msg, debug }
    }
    const pix = String(obj.pix || '0x0')
    const parts = pix.split('x').map((x) => parseInt(x.trim(), 10))
    const width = Number.isFinite(parts[0]) && parts[0] > 0 ? parts[0] : 1
    const height = Number.isFinite(parts[1]) && parts[1] > 0 ? parts[1] : 1
    return { ok: true, url: obj.url, width, height }
  } catch (e) {
    const msg = e?.message || String(e)
    const debug = {
      hasCookie: !!cookieStr,
      fileBytes: p.buffer?.length ?? 0,
      error: msg
    }
    console.error('[闲鱼聊天图片] 异常', debug)
    return { ok: false, msg, debug }
  }
}
