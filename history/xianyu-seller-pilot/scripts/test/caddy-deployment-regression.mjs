import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const override = await fs.readFile(path.join(root, 'deploy/docker-compose.caddy.yml'), 'utf8')
const caddyfile = await fs.readFile(path.join(root, 'deploy/caddy/Caddyfile.example'), 'utf8')
const deployScript = await fs.readFile(path.join(root, 'scripts/deploy/deploy-compose.sh'), 'utf8')

assert.match(override, /XIAN_YU_CADDY_NETWORK:\?\s*Set XIAN_YU_CADDY_NETWORK/)
assert.match(override, /external:\s*true/)
assert.match(override, /aliases:\s*\n\s*- \$\{XIAN_YU_CADDY_UPSTREAM_NAME:-xianyu-server\}/)
assert.match(override, /profiles:\s*\n\s*- standalone-nginx/)
assert.match(caddyfile, /h5\.example\.com\s*\{/)
assert.match(caddyfile, /reverse_proxy xianyu-server:3080/)
assert.doesNotMatch(caddyfile, /password|token|api[_-]?key|secret/i)
assert.match(deployScript, /XIAN_YU_GATEWAY/)
assert.match(deployScript, /docker network inspect/)
assert.match(deployScript, /up -d --build xianyu-server/)
assert.match(deployScript, /XIAN_YU_SERVER_IMAGE/)
assert.match(deployScript, /up -d --no-build xianyu-server/)

console.log('caddy-deployment-regression: PASS (external network, upstream alias, Nginx profile and secret-free template)')
