import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const externalRoot = process.env.XIAN_YU_TEST_TMP || '/Volumes/ChatGPT/Codex-External/xianyu-compose-volume-regression'

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
const restore = path.join(fixture, 'restore')
const backups = path.join(fixture, 'backups')
const deploy = path.join(fixture, 'deploy')
await fs.mkdir(fakeBin, { recursive: true })
await fs.mkdir(path.join(volume, 'artifacts', 'nested'), { recursive: true })
await fs.mkdir(restore, { recursive: true })
await fs.mkdir(deploy, { recursive: true })
await fs.writeFile(path.join(deploy, 'server.env'), 'NODE_ENV=production\nBROWSER_PROVIDER=camoufox\n', { mode: 0o640 })
await fs.writeFile(path.join(deploy, 'docker-compose.yml'), 'services: {}\n')
await fs.writeFile(path.join(volume, 'server.sqlite'), 'before')
await fs.writeFile(path.join(volume, 'artifacts', 'nested', 'snapshot.html'), '<html>before</html>')
await fs.writeFile(path.join(fakeBin, 'uname'), '#!/usr/bin/env bash\nprintf "Linux\\n"\n')
await fs.writeFile(path.join(fakeBin, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
args="$*"
if [[ "$args" == *" version" ]]; then
  printf 'Docker Compose version v2.30.0\\n'
elif [[ "$args" == *" ps -q xianyu-server" ]]; then
  printf 'fixture-container\\n'
elif [[ "$args" == *" exec -T xianyu-server"* ]]; then
  tar -czf - -C "$FAKE_VOLUME" .
elif [[ "$args" == *" stop "* || "$args" == *" up -d "* ]]; then
  printf '%s\\n' "$args" >> "$FAKE_CALLS"
elif [[ "$args" == *" run -T "* ]]; then
  rm -rf "$FAKE_RESTORE"/*
  tar -xzf - -C "$FAKE_RESTORE"
  printf '%s\\n' "$args" >> "$FAKE_CALLS"
else
  printf 'unexpected fake docker invocation: %s\\n' "$args" >&2
  exit 1
fi
`)
await fs.chmod(path.join(fakeBin, 'uname'), 0o755)
await fs.chmod(path.join(fakeBin, 'docker'), 0o755)
const calls = path.join(fixture, 'calls.log')
const env = {
  PATH: `${fakeBin}:${process.env.PATH || ''}`,
  XIAN_YU_ENV_FILE: path.join(deploy, 'server.env'),
  XIAN_YU_COMPOSE_FILE: path.join(deploy, 'docker-compose.yml'),
  FAKE_VOLUME: volume,
  FAKE_RESTORE: restore,
  FAKE_CALLS: calls
}

try {
  const backup = await run('bash', ['scripts/deploy/backup-compose.sh', backups, 'fixture'], env)
  assert.equal(backup.code, 0, backup.stderr)
  assert.match(backup.stdout, /backup-compose: PASS/)
  const archive = backup.stdout.match(/archive=(.+)/)?.[1]?.trim()
  assert.ok(archive)
  assert.equal((await fs.stat(archive)).isFile(), true)
  assert.match(await fs.readFile(`${archive}.manifest`, 'utf8'), /sha256=[a-f0-9]{64}/)
  assert.match((await run('tar', ['-tzf', archive], env)).stdout, /server\.sqlite/)

  await fs.writeFile(path.join(volume, 'server.sqlite'), 'after')
  const rollback = await run('bash', ['scripts/deploy/rollback-compose.sh', archive], { ...env, XIAN_YU_ROLLBACK_CONFIRM: 'YES', XIAN_YU_ROLLBACK_BACKUP_DIR: backups })
  assert.equal(rollback.code, 0, rollback.stderr)
  assert.equal(await fs.readFile(path.join(restore, 'server.sqlite'), 'utf8'), 'before')
  const callLog = await fs.readFile(calls, 'utf8')
  assert.match(callLog, / stop /)
  assert.match(callLog, / run -T /)
  assert.match(callLog, / up -d /)
  const rollbackArchives = (await fs.readdir(backups)).filter(name => name.includes('before-rollback') && name.endsWith('.tar.gz'))
  assert.equal(rollbackArchives.length, 1)

  const refused = await run('bash', ['scripts/deploy/rollback-compose.sh', archive], env)
  assert.equal(refused.code, 2)
  assert.match(refused.stderr, /XIAN_YU_ROLLBACK_CONFIRM=YES/)
} finally {
  await fs.rm(fixture, { recursive: true, force: true })
}

console.log('compose-volume-regression: PASS (streamed backup, guarded restore and pre-rollback archive)')
