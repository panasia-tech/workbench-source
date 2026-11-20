import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const unit = fs.readFileSync(path.join(root, 'deploy/systemd/xianyu-server.service'), 'utf8')

for (const directive of [
  'EnvironmentFile=/etc/xianyu-seller/server.env',
  'Environment=NODE_ENV=production',
  'Environment=ALLOW_FAKE_PROVIDER=false',
  'Environment=CAMOUFOX_USE_CLI=true',
  'Environment=CAMOUFOX_FORCE_HEADLESS=true',
  'Environment=CAMOUFOX_REQUIRE_INSTALLED_RUNTIME=true',
  'Environment=CAMOUFOX_CLI_COMMAND=/opt/camoufox-cli/bin/camoufox-cli',
  'Environment=CAMOUFOX_INSTALL_DIR=/opt/camoufox',
  'Environment=PATH=/opt/camoufox-cli/bin:/usr/local/bin:/usr/bin:/bin',
  'Environment=SERVER_WEB_UI=renderer',
  'Environment=XIAN_YU_SERVER_DATA_DIR=/var/lib/xianyu-server',
  'ReadWritePaths=/var/lib/xianyu-server',
  'ProtectSystem=strict'
]) {
  assert.match(unit, new RegExp(`^${directive.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}$`, 'm'), `systemd unit missing ${directive}`)
}
assert.match(unit, /^User=xianyu$/m, 'systemd service must not run as root')
for (const preflight of [
  'ExecStartPre=/usr/bin/test -f /opt/xianyu-seller-pilot/current/out/web/index.html',
  'ExecStartPre=/usr/bin/test -f /opt/xianyu-seller-pilot/current/server/http-server.js',
  'ExecStartPre=/usr/bin/test -x /opt/camoufox-cli/bin/camoufox-cli',
  'ExecStartPre=/usr/bin/test -x /opt/camoufox/camoufox-bin'
]) assert.match(unit, new RegExp(`^${preflight.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}$`, 'm'), `systemd unit missing ${preflight}`)
assert.match(unit, /^ExecStart=\/usr\/bin\/node .*server\/http-server\.js$/m, 'systemd unit must start the standalone HTTP server')
const envExample = fs.readFileSync(path.join(root, 'deploy/server.env.example'), 'utf8')
assert.match(envExample, /^SERVER_WEB_UI=renderer$/m, 'server env example must select the full Vue H5')
assert.match(envExample, /^# CAMOUFOX_CLI_COMMAND=\/opt\/camoufox-cli\/bin\/camoufox-cli$/m, 'server env example must document the deterministic CLI path')
const dockerfile = fs.readFileSync(path.join(root, 'deploy/Dockerfile'), 'utf8')
assert.match(dockerfile, /^COPY resources \.\/resources$/m, 'production image must retain reusable repository resources')
assert.match(dockerfile, /^COPY scripts\/data \.\/scripts\/data$/m, 'production image must retain server-side data helpers')
assert.match(dockerfile, /^COPY src\/shared \.\/src\/shared$/m, 'production image must retain shared crawler policy modules')
const composeBootstrap = fs.readFileSync(path.join(root, 'scripts/deploy/bootstrap-compose-admin.sh'), 'utf8')
assert.match(composeBootstrap, /xianyu-server node scripts\/deploy\/bootstrap-admin\.mjs/, 'Compose bootstrap must execute inside the server container')
assert.match(composeBootstrap, /XIAN_YU_ENV_FILE/, 'Compose bootstrap must resolve the private env file used by the service')
assert.ok((fs.statSync(path.join(root, 'scripts/deploy/bootstrap-compose-admin.sh')).mode & 0o111) !== 0, 'Compose bootstrap must be executable')
const composeDeploy = fs.readFileSync(path.join(root, 'scripts/deploy/deploy-compose.sh'), 'utf8')
assert.match(composeDeploy, /production Compose deployment must run on the company Linux host/, 'Compose deploy must refuse a developer workstation')
assert.match(composeDeploy, /compose-preflight\.mjs/, 'Compose deploy must run the private env/TLS preflight')
assert.match(composeDeploy, /web-erp-adapter\.js/, 'Compose deploy must verify the employee H5 entrypoint')
assert.match(composeDeploy, /backup-compose\.sh/, 'Compose deploy must preserve a pre-deploy volume backup for upgrades')
assert.match(composeDeploy, /XIAN_YU_DEPLOY_BACKUP_DIR/, 'Compose deploy must allow an explicit pre-deploy backup directory')
assert.ok((fs.statSync(path.join(root, 'scripts/deploy/deploy-compose.sh')).mode & 0o111) !== 0, 'Compose deploy must be executable')
for (const name of ['backup-compose.sh', 'rollback-compose.sh']) {
  const script = fs.readFileSync(path.join(root, 'scripts/deploy', name), 'utf8')
  assert.match(script, /xianyu-server/, `${name} must target the Compose server volume`)
  assert.match(script, /XIAN_YU_ENV_FILE/, `${name} must reuse the private env file`)
  assert.ok((fs.statSync(path.join(root, 'scripts/deploy', name)).mode & 0o111) !== 0, `${name} must be executable`)
}
assert.match(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), /"test:compose-volume"\s*:/, 'package scripts must expose Compose volume regression')
assert.match(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), /"test:compose-deploy"\s*:/, 'package scripts must expose Compose deploy regression')
const rollbackCompose = fs.readFileSync(path.join(root, 'scripts/deploy/rollback-compose.sh'), 'utf8')
assert.match(rollbackCompose, /XIAN_YU_ROLLBACK_CONFIRM/, 'Compose rollback must require explicit confirmation')
assert.match(rollbackCompose, /before-rollback/, 'Compose rollback must create a recoverable pre-rollback backup')
const installer = fs.readFileSync(path.join(root, 'scripts/deploy/install-camoufox-linux.sh'), 'utf8')
for (const fragment of [
  'camoufox-cli@' + '$' + '{CLI_VERSION}',
  'CAMOUFOX_INSTALL_DIR="$BROWSER_ROOT" "$CLI_BIN" install --with-deps',
  'Camoufox browser version.json is missing',
  'Camoufox browser executable is missing or not executable',
  'Node.js 22+',
  'refusing a broad install path'
]) assert.ok(installer.includes(fragment), 'Camoufox installer missing ' + fragment)
for (const name of ['backup-server.sh', 'rollback-server.sh']) {
  const script = fs.readFileSync(path.join(root, 'scripts/deploy', name), 'utf8')
  assert.match(script, /\/var\/tmp\/xianyu-backup-tmp/, `${name} must have a portable Linux temp default`)
  assert.doesNotMatch(script, /\/Volumes\/ChatGPT\/Codex-External/, `${name} must not require a macOS-only path`)
}
const serverCheck = fs.readFileSync(path.join(root, 'scripts/deploy/server-check.mjs'), 'utf8')
assert.match(serverCheck, /process\.platform === 'darwin'/, 'server-check must select a target-platform temp root')
console.log('systemd-deployment-regression: PASS (server data path, deterministic CLI path and Camoufox installer are explicit)')
