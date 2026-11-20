import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const externalRoot = process.env.XIAN_YU_TEST_TMP || '/Volumes/ChatGPT/Codex-External/xianyu-compose-deploy-regression'

function run(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

await fs.mkdir(externalRoot, { recursive: true })
const fixture = await fs.mkdtemp(path.join(externalRoot, 'fixture-'))
const fakeBin = path.join(fixture, 'bin')
const volume = path.join(fixture, 'volume')
const backups = path.join(fixture, 'backups')
const deploy = path.join(fixture, 'deploy')
const certs = path.join(deploy, 'certs')
const calls = path.join(fixture, 'calls.log')
await fs.mkdir(fakeBin, { recursive: true })
await fs.mkdir(volume, { recursive: true })
await fs.mkdir(certs, { recursive: true })
await fs.writeFile(path.join(deploy, 'server.env'), [
  'NODE_ENV=production',
  'BROWSER_PROVIDER=camoufox',
  'CAMOUFOX_USE_CLI=true',
  'CAMOUFOX_REQUIRE_INSTALLED_RUNTIME=true',
  'CAMOUFOX_FORCE_HEADLESS=true',
  'SERVER_WEB_UI=renderer',
  'ALLOW_FAKE_PROVIDER=false',
  ''
].join('\n'), { mode: 0o640 })
await fs.writeFile(path.join(deploy, 'docker-compose.yml'), 'services: {}\n')
await fs.writeFile(path.join(deploy, 'docker-compose.caddy.yml'), 'services: {}\n')
await fs.writeFile(path.join(certs, 'server.crt'), 'fixture-cert')
await fs.writeFile(path.join(certs, 'server.key'), 'fixture-key', { mode: 0o600 })
await fs.writeFile(path.join(volume, 'server.sqlite'), 'fixture-db')
await fs.writeFile(path.join(fakeBin, 'uname'), '#!/usr/bin/env bash\nif [[ "\${1:-}" == "-m" ]]; then printf "x86_64\\n"; else printf "Linux\\n"; fi\n')
await fs.writeFile(path.join(fakeBin, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
args="$*"
if [[ "$args" == *" version" ]]; then
  printf 'Docker Compose version v2.30.0\\n'
elif [[ "$args" == *"network inspect"* ]]; then
  printf '{"Name":"fixture-caddy"}\n'
elif [[ "$args" == *"image inspect"* ]]; then
  if [[ "$args" == *"--format"* ]]; then
    printf '%s\\n' "\${FAKE_IMAGE_ARCH:-amd64}"
  else
    printf '{"Id":"sha256:fixture","Architecture":"\${FAKE_IMAGE_ARCH:-amd64}"}\n'
  fi
elif [[ "$args" == *" config --quiet" ]]; then
  :
elif [[ "$args" == *" ps -q xianyu-server" ]]; then
  printf 'fixture-container\\n'
elif [[ "$args" == *" exec -T xianyu-server"* ]]; then
  if [[ "\${FAKE_BACKUP_FAIL:-}" == 1 ]]; then
    printf 'simulated backup failure\\n' >&2
    exit 1
  fi
  tar -czf - -C "\$FAKE_VOLUME" .
elif [[ "$args" == *" up -d --build"* || "$args" == *" up -d --no-build"* ]]; then
  printf 'up\\n' >> "\$FAKE_CALLS"
  printf '%s\\n' "\$args" >> "\$FAKE_CALLS"
else
  printf 'unexpected fake docker invocation: %s\\n' "\$args" >&2
  exit 1
fi
`)
await fs.writeFile(path.join(fakeBin, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
url="\${@: -1}"
if [[ "$url" == */ready ]]; then
  printf '{"ready":true,"provider":"camoufox"}\\n'
else
  printf '<html><script type="module" src="/web-erp-adapter.js"></script></html>\\n'
fi
`)
for (const name of ['uname', 'docker', 'curl']) await fs.chmod(path.join(fakeBin, name), 0o755)

const env = {
  PATH: `${fakeBin}:${process.env.PATH || ''}`,
  XIAN_YU_ENV_FILE: path.join(deploy, 'server.env'),
  XIAN_YU_COMPOSE_FILE: path.join(deploy, 'docker-compose.yml'),
  XIAN_YU_CERT_ROOT: certs,
  XIAN_YU_PUBLIC_URL: 'https://fixture.invalid',
  XIAN_YU_DEPLOY_BACKUP_DIR: backups,
  FAKE_VOLUME: volume,
  FAKE_CALLS: calls
}

try {
  const deployed = await run('bash', ['scripts/deploy/deploy-compose.sh'], env)
  assert.equal(deployed.code, 0, deployed.stderr)
  assert.match(deployed.stdout, /deploy-compose: PASS/)
  assert.match(await fs.readFile(calls, 'utf8'), /^up$/m)
  const archives = (await fs.readdir(backups)).filter(name => name.endsWith('.tar.gz'))
  assert.equal(archives.length, 1, 'a running service must be backed up before upgrade')

  await fs.rm(calls, { force: true })
  const refused = await run('bash', ['scripts/deploy/deploy-compose.sh'], { ...env, FAKE_BACKUP_FAIL: '1' })
  assert.notEqual(refused.code, 0)
  assert.match(refused.stderr, /backup-compose|simulated backup failure/)
  await assert.rejects(() => fs.access(calls), 'failed backup must not start a replacement container')

  await fs.rm(path.join(certs, 'server.crt'), { force: true })
  await fs.rm(path.join(certs, 'server.key'), { force: true })
  const caddy = await run('bash', ['scripts/deploy/deploy-compose.sh'], {
    ...env,
    XIAN_YU_GATEWAY: 'caddy',
    XIAN_YU_CADDY_NETWORK: 'fixture-caddy',
    XIAN_YU_CADDY_COMPOSE_FILE: path.join(deploy, 'docker-compose.caddy.yml'),
    XIAN_YU_SERVER_IMAGE: 'xianyu-seller-pilot:server-20260831-amd64'
  })
  assert.equal(caddy.code, 0, caddy.stderr)
  assert.match(caddy.stdout, /deploy-compose: PASS/)
  assert.match(await fs.readFile(calls, 'utf8'), /up -d --no-build xianyu-server/)

  await fs.rm(calls, { force: true })
  const wrongArch = await run('bash', ['scripts/deploy/deploy-compose.sh'], {
    ...env,
    XIAN_YU_GATEWAY: 'caddy',
    XIAN_YU_CADDY_NETWORK: 'fixture-caddy',
    XIAN_YU_CADDY_COMPOSE_FILE: path.join(deploy, 'docker-compose.caddy.yml'),
    XIAN_YU_SERVER_IMAGE: 'xianyu-seller-pilot:server-20260831-arm64',
    FAKE_IMAGE_ARCH: 'arm64'
  })
  assert.equal(wrongArch.code, 2)
  assert.match(wrongArch.stderr, /architecture mismatch/)
  await assert.rejects(() => fs.access(calls), 'wrong image architecture must block before compose up')
} finally {
  await fs.rm(fixture, { recursive: true, force: true })
}

console.log('compose-deploy-regression: PASS (readiness gate, pre-deploy backup and fail-closed upgrade)')
