// Live smoke against the AdsPower client running on this machine.
//
// Unlike the other adspower-* regressions this one talks to the real Local API
// and a real Chromium, so it only runs where AdsPower is installed.  It is
// deliberately non-invasive:
//   - it prefers an environment that is already running;
//   - if none is, it starts the first listed one and stops it again at the end,
//     leaving the machine as it found it (pass --no-start to skip instead);
//   - it asks the adapter for a purpose-owned ('preview') target, which creates
//     its own tab rather than reusing whatever the operator has open, and
//     closes that tab when done.
import assert from 'node:assert/strict'
import { AdsPowerApi, AdsPowerWebContents } from '../../src/main/adspower.js'

const allowStart = !process.argv.includes('--no-start')
const api = new AdsPowerApi()

// /status is the Local API health probe: {"code":0,"msg":"success"}.  get()
// already throws on a non-zero code, so reaching this line is the assertion.
const health = await api.health()
assert.ok(health, 'AdsPower Local API must answer /status')

// Full enumeration (/api/v1/user/list) needs a paid subscription; on the free
// tier listProfiles resolves to { list: [], paidOnly: true } instead.
const profilesResponse = await api.listProfiles(1, 100)
const profiles = Array.isArray(profilesResponse?.list) ? profilesResponse.list : []
const paidOnly = Boolean(profilesResponse?.paidOnly)

// ports() is normalised to [{ id, port, ws }] from /api/v1/browser/local-active.
let running = await api.ports()
assert.ok(Array.isArray(running), 'ports() must normalise local-active into an array')

let startedByTest = null
if (!running.length) {
  const candidate = String(profiles[0]?.user_id || '').trim()
  assert.ok(candidate || !allowStart,
    'no environment is running and none could be listed — open one in AdsPower first')
  assert.ok(allowStart, 'no environment is running and --no-start was passed')
  await api.open(candidate)
  startedByTest = candidate
  running = await api.ports()
  assert.ok(running.length > 0, `environment ${candidate} did not come up`)
}

for (const entry of running) {
  assert.ok(entry.id, 'every running entry must carry its user_id')
  assert.ok(Number.isInteger(entry.port) && entry.port > 0, `environment ${entry.id} must expose a debug port`)
}

const profileId = startedByTest || running[0].id
const port = running.find((entry) => entry.id === profileId)?.port || running[0].port
// start is also the documented foreground/focus call for an already-running
// environment, and it is what the preview entry point uses before attaching.
const started = await api.open(profileId)
assert.ok(started?.ws?.puppeteer || started?.debug_port, 'browser/start must return a CDP endpoint')

const contents = new AdsPowerWebContents({ profileId, purpose: 'preview' })
let evidence = null
try {
  await contents.ensureConnected()
  assert.equal(contents.ownedTarget, true, 'the live smoke must own the tab it created')
  await contents.loadURL('https://www.goofish.com/')
  evidence = await contents.executeJavaScript('({ href: location.href, title: document.title })')
  assert.equal(typeof evidence?.href, 'string')
  assert.equal(typeof evidence?.title, 'string')
  assert.match(evidence.href, /goofish\.com/i)
} finally {
  await contents.close()
  // Leave the machine as we found it.
  if (startedByTest) await api.close(startedByTest).catch(() => {})
}

console.log(JSON.stringify({
  ok: true,
  apiBase: api.baseUrl,
  paidProfileListing: !paidOnly,
  listedProfileCount: profiles.length,
  runningEnvironmentCount: running.length,
  startedByTest: startedByTest || null,
  connectedProfile: profileId,
  debugPort: port,
  pageHost: (() => { try { return new URL(evidence.href).hostname } catch { return '' } })(),
  pageTitle: String(evidence?.title || '').slice(0, 60)
}, null, 2))
