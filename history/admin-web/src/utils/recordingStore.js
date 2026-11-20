// 开箱录像本地副本（IndexedDB）：边录边存每 5 秒的分块，上传确认完成前一直留着。
// 刷新、关页、浏览器崩溃后回到开箱验货页，还能把上次没传完的录像接着传或下载到电脑（禅道 WH04-13）。
const DB_NAME = 'erp-unbox-recordings'
const VERSION = 1

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('chunks')) {
        const s = db.createObjectStore('chunks', { autoIncrement: true })
        s.createIndex('jobId', 'jobId')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function tx(stores, mode, fn) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode)
    let out
    Promise.resolve(fn(t)).then((v) => (out = v))
    t.oncomplete = () => resolve(out)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  })
}

const req2p = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error)
})

/** 开始一段录像：记下属于哪张验货单、什么时候开始录、文件名（重试上传沿用同一个名字） */
export function saveJob(job) {
  return tx(['jobs'], 'readwrite', (t) => t.objectStore('jobs').put(job)).catch(() => {})
}

export function appendChunk(jobId, blob) {
  return tx(['chunks'], 'readwrite', (t) => t.objectStore('chunks').add({ jobId, blob })).catch(() => {})
}

export async function loadBlob(jobId, type) {
  try {
    const rows = await tx(['chunks'], 'readonly', (t) => req2p(t.objectStore('chunks').index('jobId').getAll(jobId)))
    return rows && rows.length ? new Blob(rows.map((r) => r.blob), { type }) : null
  } catch {
    return null
  }
}

export async function listJobs() {
  try {
    return (await tx(['jobs'], 'readonly', (t) => req2p(t.objectStore('jobs').getAll()))) || []
  } catch {
    return []
  }
}

/** 上传并登记成功后才删本地副本 */
export async function removeJob(jobId) {
  try {
    const keys = await tx(['chunks'], 'readonly', (t) => req2p(t.objectStore('chunks').index('jobId').getAllKeys(jobId)))
    await tx(['jobs', 'chunks'], 'readwrite', (t) => {
      t.objectStore('jobs').delete(jobId)
      for (const k of keys || []) t.objectStore('chunks').delete(k)
    })
  } catch {
    /* 删不掉下次还会提示，不影响业务 */
  }
}
