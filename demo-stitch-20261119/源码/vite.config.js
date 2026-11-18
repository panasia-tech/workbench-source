import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { appendFileSync, writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

// 全部商品 Gallery（重新设计的界面）。/api 代理到 ERP。
//   演示：不设 ERP_TARGET，代理到本机演示后端，免登录。
//   真数据：ERP_TARGET=https://主机/路径前缀 （例如 http://127.0.0.1:8000），走真登录页；
//           默认只读——开发服务器会拦住所有非 GET 请求（登录除外），界面里也会提前拒绝。ERP_WRITE=1 才放开（不建议）。
const raw = process.env.ERP_TARGET || ''
const demo = !raw
const u = raw ? new URL(raw) : null
const origin = u ? u.origin : 'http://127.0.0.1:8000'
const prefix = u ? u.pathname.replace(/\/+$/, '') : ''
const remote = !!u && !/127\.0\.0\.1|localhost/.test(u.hostname)

// 真 ERP 里没有的部分（虚拟/服务、练习、订单对账等）仍然要能演示：这些路径转到本机演示后端（127.0.0.1:8000），
// 由开发服务器替浏览器用演示账号（陈小满，演示数据）登录，写入也只写演示库，不碰生产。
const DEMO_ROUTE = /^\/api\/(virtual|demo)/
const DEMO_BACKEND = 'http://127.0.0.1:8000'
let demoTok = ''
async function loginDemo() {
  try {
    const r = await fetch(DEMO_BACKEND + '/api/auth/h5-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'chenxm', password: 'DEMO_ONLY_REDACTED' }) })
    demoTok = (await r.json()).token || ''
  } catch { demoTok = '' }
}
const demoProxy = {
  target: DEMO_BACKEND, changeOrigin: false,
  configure: (proxy) => {
    proxy.on('proxyReq', (pr) => { if (demoTok) pr.setHeader('Authorization', 'Bearer ' + demoTok) })
    proxy.on('proxyRes', (res) => { if (res.statusCode === 401) loginDemo() })
  }
}
// ===== 真实版「免登录」（用户 2026-11-11 明确同意：把 ERP 登录状态保存在本机、自动续期）=====
// 登录一次（或浏览器里已有登录状态）→ 令牌交给开发服务器，存本机文件（权限 600，只有本人可读）。
// 之后任何浏览器打开都不用再登录：开发服务器替浏览器给发往真 ERP 的请求带上令牌。令牌 7 天有效，每 12 小时自动续期（/api/auth/refresh）。
// 不保存密码。开发服务器只监听 127.0.0.1。页面「退出登录」会删掉这个文件。
const SESSION_FILE = process.env.SESSION_FILE || homedir() + '/Library/Caches/panasia-gallery-demo/real-session.json'
let session = null
if (!demo) { try { session = JSON.parse(readFileSync(SESSION_FILE, 'utf-8')) } catch { session = null } }
const saveSession = () => { try { mkdirSync(dirname(SESSION_FILE), { recursive: true }); writeFileSync(SESSION_FILE, JSON.stringify(session), { mode: 0o600 }); chmodSync(SESSION_FILE, 0o600) } catch {} }
const dropSession = () => { session = null; try { if (existsSync(SESSION_FILE)) unlinkSync(SESSION_FILE) } catch {} }
const erp = (path, init = {}) => fetch(origin + prefix + path, init)
async function refreshSession() {
  if (!session?.token) return
  try {
    const r = await erp('/api/auth/refresh', { method: 'POST', headers: { Authorization: 'Bearer ' + session.token } })
    if (r.ok) { const d = await r.json(); if (d.token) { session = { ...session, token: d.token, staff: d.staff || session.staff, at: Date.now() }; saveSession() } }
    else if (r.status === 401) dropSession()
  } catch { /* 网络抖动，下次再试 */ }
}
const sessionRoute = (req, res) => {
  const send = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)) }
  const m = (req.method || 'GET').toUpperCase()
  if (m === 'GET') return send(200, { ok: !!session?.token, staff: session?.staff || null, user: session?.user || '' })
  if (m === 'DELETE') { dropSession(); return send(200, { ok: false }) }
  if (m === 'POST') {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', async () => {
      try {
        const { token, staff, user } = JSON.parse(b || '{}')
        if (!token) return send(400, { ok: false })
        const r = await erp('/api/auth/me', { headers: { Authorization: 'Bearer ' + token } }) // 令牌是不是真的、有没有过期
        if (!r.ok) return send(401, { ok: false })
        session = { token, staff: staff || (await r.json().catch(() => null)), user: user || '', at: Date.now() }
        saveSession(); send(200, { ok: true })
      } catch { send(400, { ok: false }) }
    })
    return
  }
  send(405, { ok: false })
}
const snapFile = process.env.SNAP_FILE || ''
const demoSwitch = { name: 'demo-switch', transformIndexHtml: (html) => html.replace(/__DEMO__/g, demo ? 'true' : 'false').replace(/__SNAP__/g, snapFile ? 'true' : 'false') }
const readonlyGuard = {
  name: 'real-readonly', apply: 'serve',
  configureServer(server) {
    // 排查用（只在设了 SNAP_FILE 时开）：页面把「读到了多少、红黄绿各几件」这类汇总（不含令牌）发到本机文件，方便核对数据
    if (!demo) { loginDemo(); server.middlewares.use('/__session', sessionRoute); refreshSession(); setInterval(refreshSession, 12 * 3600 * 1000) }
    if (!demo && snapFile) server.middlewares.use('/__snap', (req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { writeFileSync(snapFile, b) } catch {} res.end('ok') }) })
    if (demo || process.env.ERP_WRITE === '1') return
    server.middlewares.use((req, res, next) => {
      const m = (req.method || 'GET').toUpperCase()
      if (req.url.startsWith('/api') && !['GET', 'HEAD', 'OPTIONS'].includes(m) && !/^\/api\/auth\/(h5-login|logout)(\?|$)/.test(req.url) && !DEMO_ROUTE.test(req.url)) {
        res.statusCode = 403
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ detail: '真实数据模式只读：开发服务器拦住了这次写入，生产数据没有被改动' }))
        return
      }
      next()
    })
  }
}
export default defineConfig({
  base: './',
  plugins: [vue(), demoSwitch, readonlyGuard],
  preview: { port: 5300, host: '0.0.0.0', proxy: { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: false } } },
  server: {
    port: Number(process.env.PORT) || 5200, host: '127.0.0.1',
    proxy: { ...(demo ? {} : { '/api/virtual': demoProxy, '/api/demo': demoProxy }), '/api': { target: origin, changeOrigin: remote, secure: true, rewrite: (p) => prefix + p,
      // 只记「方法 + 路径（不含参数）+ 状态码」到 /tmp/gallery-real-access.log，不记令牌、不记内容，用来排查哪个接口读失败
      configure: (proxy) => { if (!demo) proxy.on('proxyReq', (pr, req) => { if (session?.token && !/^\/api\/auth\/(h5-login)/.test(req.url)) pr.setHeader('Authorization', 'Bearer ' + session.token) }); if (!demo) proxy.on('proxyRes', (res, req) => { try { appendFileSync('/tmp/gallery-real-access.log', `${new Date().toISOString()} ${req.method} ${String(req.url).split('?')[0]} ${res.statusCode}\n`) } catch {} }) } } }
  }
})
