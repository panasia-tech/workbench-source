import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const externalRoot = process.env.XIAN_YU_TEST_TMP || '/Volumes/ChatGPT/Codex-External/xianyu-compose-preflight'

async function run(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/deploy/compose-preflight.mjs'], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

await fs.mkdir(externalRoot, { recursive: true })
const fixture = await fs.mkdtemp(path.join(externalRoot, 'fixture-'))
try {
  const deploy = path.join(fixture, 'deploy')
  const certs = path.join(deploy, 'certs')
  await fs.mkdir(certs, { recursive: true })
  await fs.writeFile(path.join(deploy, 'server.env'), 'NODE_ENV=production\nBROWSER_PROVIDER=camoufox\nCAMOUFOX_USE_CLI=true\nCAMOUFOX_REQUIRE_INSTALLED_RUNTIME=true\nALLOW_FAKE_PROVIDER=false\n', { mode: 0o640 })
  await fs.writeFile(path.join(certs, 'server.crt'), 'fixture-cert')
  await fs.writeFile(path.join(certs, 'server.key'), 'fixture-key', { mode: 0o600 })
  const pass = await run({ XIAN_YU_DEPLOY_ROOT: fixture, XIAN_YU_ENV_FILE: './server.env', XIAN_YU_CERT_ROOT: './certs' })
  assert.equal(pass.code, 0, pass.stderr)
  assert.match(pass.stdout, /compose-preflight: PASS/)
  await fs.writeFile(path.join(deploy, 'server.env'), 'NODE_ENV=production\nBROWSER_PROVIDER=camoufox\nCAMOUFOX_USE_CLI=true\nCAMOUFOX_REQUIRE_INSTALLED_RUNTIME=true\nSERVER_WEB_UI=console\nALLOW_FAKE_PROVIDER=false\n', { mode: 0o640 })
  const legacyUi = await run({ XIAN_YU_DEPLOY_ROOT: fixture, XIAN_YU_ENV_FILE: './server.env', XIAN_YU_CERT_ROOT: './certs' })
  assert.equal(legacyUi.code, 2)
  assert.match(legacyUi.stderr, /SERVER_WEB_UI=renderer/)
  await fs.writeFile(path.join(deploy, 'server.env'), 'NODE_ENV=production\nBROWSER_PROVIDER=camoufox\nCAMOUFOX_USE_CLI=true\nCAMOUFOX_REQUIRE_INSTALLED_RUNTIME=true\nCAMOUFOX_FORCE_HEADLESS=false\nALLOW_FAKE_PROVIDER=false\n', { mode: 0o640 })
  const headed = await run({ XIAN_YU_DEPLOY_ROOT: fixture, XIAN_YU_ENV_FILE: './server.env', XIAN_YU_CERT_ROOT: './certs' })
  assert.equal(headed.code, 2)
  assert.match(headed.stderr, /CAMOUFOX_FORCE_HEADLESS=true/)
  await fs.writeFile(path.join(deploy, 'server.env'), 'NODE_ENV=production\nBROWSER_PROVIDER=camoufox\nCAMOUFOX_USE_CLI=true\nCAMOUFOX_REQUIRE_INSTALLED_RUNTIME=true\nALLOW_FAKE_PROVIDER=false\n', { mode: 0o640 })
  await fs.chmod(path.join(certs, 'server.key'), 0o644)
  const exposedKey = await run({ XIAN_YU_DEPLOY_ROOT: fixture, XIAN_YU_ENV_FILE: './server.env', XIAN_YU_CERT_ROOT: './certs' })
  assert.equal(exposedKey.code, 2)
  assert.match(exposedKey.stderr, /私钥不可被其他用户读取/)
  await fs.chmod(path.join(certs, 'server.key'), 0o600)
  await fs.unlink(path.join(certs, 'server.key'))
  const missing = await run({ XIAN_YU_DEPLOY_ROOT: fixture, XIAN_YU_ENV_FILE: './server.env', XIAN_YU_CERT_ROOT: './certs' })
  assert.equal(missing.code, 2)
  assert.match(missing.stderr, /TLS 文件不存在/)

  await fs.writeFile(path.join(deploy, 'server.env'), 'NODE_ENV=production\nBROWSER_PROVIDER=camoufox\nCAMOUFOX_USE_CLI=true\nCAMOUFOX_REQUIRE_INSTALLED_RUNTIME=true\nCAMOUFOX_FORCE_HEADLESS=true\nSERVER_WEB_UI=renderer\nALLOW_FAKE_PROVIDER=false\n', { mode: 0o640 })
  await fs.rm(path.join(certs, 'server.crt'), { force: true })
  await fs.rm(path.join(certs, 'server.key'), { force: true })
  const caddy = await run({ XIAN_YU_DEPLOY_ROOT: fixture, XIAN_YU_ENV_FILE: './server.env', XIAN_YU_CERT_ROOT: './certs', XIAN_YU_GATEWAY: 'caddy', XIAN_YU_CADDY_NETWORK: 'fixture-caddy' })
  assert.equal(caddy.code, 0, caddy.stderr)
  assert.match(caddy.stdout, /compose-preflight: PASS/)
  const badGateway = await run({ XIAN_YU_DEPLOY_ROOT: fixture, XIAN_YU_ENV_FILE: './server.env', XIAN_YU_CERT_ROOT: './certs', XIAN_YU_GATEWAY: 'haproxy', XIAN_YU_CADDY_NETWORK: 'fixture-caddy' })
  assert.equal(badGateway.code, 2)
  assert.match(badGateway.stderr, /只能是 nginx 或 caddy/)
} finally {
  await fs.rm(fixture, { recursive: true, force: true })
}

console.log('compose-preflight-regression: PASS (private env, production provider and Nginx TLS files)')
