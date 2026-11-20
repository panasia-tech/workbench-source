"use strict"

const fs = require('node:fs')
const path = require('node:path')

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon'
}

function safeFile(root, relative) {
  const value = String(relative || '').replace(/^\/+/, '')
  if (!value || value.includes('\0')) return null
  const base = path.resolve(root)
  const file = path.resolve(base, value)
  if (file !== base && !file.startsWith(`${base}${path.sep}`)) return null
  return file
}

function sendFile(reply, file) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return reply.code(404).send({ error: { code: 'asset_not_found', message: 'Asset not found' } })
  const type = CONTENT_TYPES[path.extname(file).toLowerCase()]
  if (!type) return reply.code(404).send({ error: { code: 'asset_not_found', message: 'Asset not found' } })
  return reply.type(type).send(fs.createReadStream(file))
}

function registerWebRoutes(fastify, { root = null, builtRoot: builtRootOverride = null } = {}) {
  const configured = String(process.env.SERVER_WEB_UI || '').trim().toLowerCase()
  const builtRoot = path.resolve(builtRootOverride || path.join(process.cwd(), 'out/web'))
  const fallbackRoot = path.resolve(root || path.join(__dirname, '../../web'))
  const rendererRequested = configured === 'renderer'
  const rendererAvailable = fs.existsSync(path.join(builtRoot, 'index.html'))
  // In production the full Vue renderer is the employee-facing product. A
  // missing build must stop startup instead of silently serving the legacy
  // console, which would look healthy while exposing the wrong capabilities.
  if (rendererRequested && String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production' && !rendererAvailable) {
    throw new Error(`SERVER_WEB_UI=renderer requires built H5 artifact: ${path.join(builtRoot, 'index.html')}`)
  }
  const directory = rendererRequested && rendererAvailable ? builtRoot : fallbackRoot
  const rendererMode = directory === builtRoot

  fastify.get('/', async (_request, reply) => {
    const index = path.join(directory, 'index.html')
    if (!fs.existsSync(index)) return reply.code(404).send({ error: { code: 'asset_not_found', message: 'H5 index not built' } })
    let html = fs.readFileSync(index, 'utf8')
    if (rendererMode && !html.includes('/web-erp-adapter.js')) html = html.replace('</head>', '<script src="/web-erp-adapter.js"></script></head>')
    return reply.type(CONTENT_TYPES['.html']).send(html)
  })
  fastify.get('/web-erp-adapter.js', async (_request, reply) => sendFile(reply, path.join(fallbackRoot, 'erp-adapter.js')))
  // Renderer assets live below the built bundle's `assets/` directory. Keep
  // the wildcard rooted there so a valid H5 bundle cannot render a blank page
  // merely because the server looked for `/assets/foo.js` at `/foo.js`.
  fastify.get('/assets/*', async (request, reply) => sendFile(reply, safeFile(path.join(directory, 'assets'), request.params['*'])))
  fastify.get('/:asset', async (request, reply) => {
    const name = path.basename(String(request.params.asset || ''))
    return sendFile(reply, safeFile(directory, name))
  })
}

module.exports = { registerWebRoutes }
