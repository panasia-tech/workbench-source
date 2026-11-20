import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const config = fs.readFileSync(path.join(root, 'deploy/nginx.conf'), 'utf8')
const match = config.match(/location\s*=\s*\/events\s*\{([\s\S]*?)\n\s*\}/)
assert.ok(match, 'nginx must provide an exact /events location for SSE')
const events = match[1]
for (const directive of ['proxy_buffering off;', 'proxy_cache off;', 'proxy_read_timeout 1h;', 'proxy_http_version 1.1;']) {
  assert.match(events, new RegExp(directive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `SSE location missing ${directive}`)
}
assert.match(config, /location\s+\/\s*\{/, 'nginx must retain the default H5/API proxy location')
assert.match(config, /add_header Strict-Transport-Security "max-age=31536000" always;/, 'HTTPS must advertise a persistent HSTS policy')
assert.match(config, /add_header Content-Security-Policy "default-src 'self';[^\n]+frame-src 'self' blob:" always;/, 'H5 CSP must keep scripts/network same-origin while allowing evidence blobs')
console.log('nginx-sse-regression: PASS (SSE proxy buffering disabled and long-read timeout configured)')
