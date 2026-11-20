"use strict"

/**
 * Persist the DOM snapshot captured by the shared crawler into the server's
 * artifact store.  The browser transport is deliberately kept out of this
 * helper so Playwright and camoufox-cli use the same evidence path.
 */
async function persistHtmlSnapshot({ artifactStore = null, webContents = null, jobId = null, kind = 'crawl', now = () => new Date().toISOString() } = {}) {
  if (!artifactStore || !webContents) return null
  const { captureHtmlSnapshot } = await import('../../src/main/goofish.js')
  const snapshot = await captureHtmlSnapshot(webContents)
  if (!snapshot || typeof snapshot.html !== 'string' || !snapshot.html.trim()) return null
  const capturedAt = String(now())
  const stamp = capturedAt.replace(/[^0-9A-Za-z-]/g, '').slice(0, 40) || 'snapshot'
  const metadata = await artifactStore.put({
    name: `${String(kind || 'crawl').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60)}-${String(jobId || 'job').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60)}-${stamp}.html`,
    content: Buffer.from(snapshot.html, 'utf8'),
    mimeType: 'text/html; charset=utf-8',
    jobId
  })
  return {
    path: metadata.id,
    pageUrl: String(snapshot.url || '').slice(0, 2000),
    viewport: { width: Number(snapshot.width) || 1280, height: Number(snapshot.height) || 820 },
    capturedAt
  }
}

module.exports = { persistHtmlSnapshot }
