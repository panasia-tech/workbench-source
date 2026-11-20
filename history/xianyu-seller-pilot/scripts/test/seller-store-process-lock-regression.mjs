import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const script = fileURLToPath(import.meta.url)
const isChild = process.argv[2] === '--child'
const rounds = Math.max(1, Number(process.argv[process.argv.indexOf('--rounds') + 1]) || 20)
const suppliedRoot = process.argv[process.argv.indexOf('--temp-root') + 1]
const root = isChild ? join(process.env.XIANYU_SELLER_DATA_DIR || tmpdir(), '..') : (suppliedRoot && suppliedRoot !== '--assert-os-atomic' ? suppliedRoot : mkdtempSync(join(tmpdir(), 'xianyu-seller-lease-')))
const dataDir = isChild ? String(process.env.XIANYU_SELLER_DATA_DIR || '') : join(root, 'shared-user-data')
mkdirSync(dataDir, { recursive: true, mode: 0o700 })

const sourceRows = Array.from({ length: Math.max(rounds, 20) + 1 }, (_, index) => ({
  id: `source-${index}`,
  sellerId: `seller-${index}`,
  url: `https://www.goofish.com/personal?userId=seller-${index}`
}))
if (!isChild) writeFileSync(join(dataDir, 'seller-sources.json'), JSON.stringify(sourceRows), { mode: 0o600 })

async function child(mode, cycleKey, accountId = 'account-a', targetSellerId = '') {
  const { stdout, stderr } = await execFileAsync(process.execPath, [script, '--child', mode, cycleKey, accountId, targetSellerId], {
    env: { ...process.env, XIANYU_SELLER_DATA_DIR: dataDir },
    maxBuffer: 2 * 1024 * 1024
  })
  if (stderr && !/MODULE_TYPELESS_PACKAGE_JSON/.test(stderr)) process.stderr.write(stderr)
  const line = stdout.trim().split(/\r?\n/).at(-1) || '{}'
  return JSON.parse(line)
}

if (process.argv[2] === '--child') {
  const [, , , mode, cycleKey, accountId, targetSellerId] = process.argv
  const { default: _unused, ...store } = await import('../../src/main/seller-store.js')
  if (mode === 'status') {
    process.stdout.write(JSON.stringify({ ok: true, status: store.getStatus() }) + '\n')
  } else {
    const claimed = store.claimNext(`run-${cycleKey}`, accountId, 2, cycleKey, { pendingOnly: true, allowedSellerIds: targetSellerId ? [targetSellerId] : null })
    process.stdout.write(JSON.stringify({ ok: true, claimed: claimed ? { id: claimed.id, lease: claimed.currentAttempt?.lease } : null }) + '\n')
  }
  process.exit(0)
}

const claims = []
for (let index = 0; index < rounds; index += 1) {
  const cycleKey = `regression-cycle-${index}`
  const targetSellerId = `seller-${index}`
  const [first, second] = await Promise.all([
    child('claim', cycleKey, 'account-a', targetSellerId),
    child('claim', cycleKey, 'account-b', targetSellerId)
  ])
  const owners = [first, second].filter((entry) => entry.claimed)
  assert.equal(owners.length, 1, `round ${index} must have exactly one lease owner`)
  claims.push(owners[0].claimed)
}

const progressPath = join(dataDir, 'seller-progress.jsonl')
const checkpointPath = join(dataDir, 'seller-checkpoint-v3.json')
const beforeProgress = readFileSync(progressPath)
const beforeCheckpoint = existsSync(checkpointPath) ? readFileSync(checkpointPath) : null
const beforeProgressStat = statSync(progressPath)
await child('status', 'diagnostic-cycle')
assert.deepEqual(readFileSync(progressPath), beforeProgress, 'status must not rewrite progress JSONL')
if (beforeCheckpoint) assert.deepEqual(readFileSync(checkpointPath), beforeCheckpoint, 'status must not rewrite checkpoint')
assert.equal(statSync(progressPath).mtimeMs, beforeProgressStat.mtimeMs, 'status must not mutate progress mtime')

// A mismatched token cannot release another process's owner directory.
const { default: _unused, ...store } = await import('../../src/main/seller-store.js')
const owned = claims[0]
const mismatch = store.releaseLease(owned.id, {
  accountId: 'account-a',
  runId: 'wrong-run',
  cycleKey: 'regression-cycle-0',
  token: 'wrong-token'
})
assert.equal(mismatch.released, false)

// Expired owner quarantine: the stale lock is moved aside before replacement.
const staleCycle = 'expired-cycle'
const leaseHash = createHash('sha256').update(`${staleCycle}\0source-20`).digest('hex')
const stalePath = join(dataDir, 'seller-leases', `${leaseHash}.lock`)
mkdirSync(stalePath, { recursive: true, mode: 0o700 })
writeFileSync(join(stalePath, 'owner.json'), JSON.stringify({ token: 'legacy-token', sourceId: 'source-20', accountId: 'legacy', runId: 'legacy', cycleKey: staleCycle, expiresAt: new Date(Date.now() - 60_000).toISOString() }), { mode: 0o600 })
const recovered = await child('claim', staleCycle, 'account-recovered', 'seller-20')
assert.equal(recovered.claimed?.id, 'source-20')
assert.ok(readdirNames().some((name) => name.includes('.quarantine-')), 'expired lock must leave quarantine evidence')

assert.ok(root.startsWith(tmpdir()) || suppliedRoot, 'all lock tests must run below explicit temporary root')
console.log(JSON.stringify({ ok: true, rounds, owners: rounds, diagnosticsReadOnly: true, staleLeaseRecovered: true, root }))
if (!isChild) rmSync(root, { recursive: true, force: true })

function readdirNames() {
  try { return readdirSync(join(dataDir, 'seller-leases')) } catch { return [] }
}
