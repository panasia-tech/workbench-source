// 网页快照保留期的判定逻辑。纯函数，可独立回归（不依赖 electron-store / fs）。
//
// runResults 有 RESULT_CAP 上限、runs 有 RUN_CAP 上限，元数据是有界的；但它们指向的
// 整页 DOM 文件此前从不删除——结果行滚出上限后，那份快照就永远无法再被引用，
// 只能一直堆在盘上（一个型号一轮最多 12 个搜索词 = 12 份整页 DOM）。

// 还被结果行引用着的快照留多久。原来 30 天；F01-13 要「31 天以上能回看」，放到 400 天
// （一年多一点，跨年同期能对上）。注意真正的上限常常不是它而是 task-store 的 RESULT_CAP：
// 结果行滚出上限后，它指向的快照就没人引用了，过 SNAPSHOT_MIN_AGE_HOURS 照删，不等保留期。
export const SNAPSHOT_RETENTION_DAYS = 400
// 快照先落盘、结果行后写入，刚生成的文件可能属于正在跑的那一轮，先放过。
export const SNAPSHOT_MIN_AGE_HOURS = 24

const HOUR_MS = 3600 * 1000

/**
 * 决定哪些快照该删。
 *
 * @param entries    [{ name, path, mtimeMs, size, kind: 'html' | 'resourceDir' }]
 * @param referenced 仍被结果行引用的绝对路径集合
 * @returns { deleteHtml, deleteDirs, keptCount }
 */
export function planSnapshotPrune({
  entries = [],
  referenced = new Set(),
  now = Date.now(),
  retentionDays = SNAPSHOT_RETENTION_DAYS,
  minAgeHours = SNAPSHOT_MIN_AGE_HOURS
} = {}) {
  const html = entries.filter((entry) => entry.kind === 'html')
  const dirs = entries.filter((entry) => entry.kind === 'resourceDir')

  const deleteHtml = []
  let keptCount = 0
  for (const entry of html) {
    const ageHours = (now - entry.mtimeMs) / HOUR_MS
    if (ageHours < minAgeHours) {
      keptCount += 1        // 可能属于正在跑的那一轮
      continue
    }
    if (referenced.has(entry.path) && ageHours < retentionDays * 24) {
      keptCount += 1        // 员工点历史还要能打开当时的页面
      continue
    }
    deleteHtml.push(entry)
  }

  // savePage('HTMLComplete') 兜底路径会在同级写 `<名字>_files/`：
  // 只清 .html 会把图片和 CSS 永久留下，所以资源目录跟着它的 .html 一起走。
  const removedBases = new Set(deleteHtml.map((entry) => baseName(entry.name)))
  const survivingBases = new Set(
    html.filter((entry) => !removedBases.has(baseName(entry.name))).map((entry) => baseName(entry.name))
  )
  const deleteDirs = dirs.filter((dir) => !survivingBases.has(dirBase(dir.name)))

  return { deleteHtml, deleteDirs, keptCount }
}

function baseName(name) {
  return String(name || '').replace(/\.html$/i, '')
}

function dirBase(name) {
  return String(name || '').replace(/_files$/, '')
}

/** 从一行结果里取出它引用到的全部快照路径。 */
export function snapshotPathsOfResult(row) {
  const out = []
  if (!row || typeof row !== 'object') return out
  if (row.snapshotPath) out.push(row.snapshotPath)
  for (const item of Array.isArray(row.snapshotPaths) ? row.snapshotPaths : []) {
    if (item) out.push(item)
  }
  for (const entry of Array.isArray(row.snapshotEntries) ? row.snapshotEntries : []) {
    if (entry?.path) out.push(entry.path)
  }
  return out
}
