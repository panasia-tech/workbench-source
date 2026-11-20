// 本地配置写盘的统一收口。
//
// electron-store 底层用 atomically：先写 .tmp-xxx，再 rename 成正式文件。
// Windows 上如果同一个配置文件被另一个实例/杀毒软件占着，rename 会报
// EPERM/EBUSY/EACCES；以前这个错误直接抛到界面，退出登录也会卡住。
// 这里只做两件事：短暂重试；重试仍失败时给一句能照做的提示。
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'EEXIST'])
const DELAYS_MS = [0, 120, 300, 600]

function pause(ms) {
  if (!ms) return
  // 主进程极少走到这里（只在配置被锁时）；同步阻塞几百毫秒比把错误丢给用户更好。
  const end = Date.now() + ms
  while (Date.now() < end) { /* wait */ }
}

function friendlyError(label, cause) {
  const code = String(cause?.code || '').trim()
  const suffix = code ? `（${code}）` : ''
  const error = new Error(
    `${label}失败：本地配置文件被占用或没有写权限${suffix}。` +
      '请关闭其他巡航台实例；如果还不行，把巡航台加入杀毒软件白名单后重试。'
  )
  error.cause = cause
  if (code) error.code = code
  return error
}

/** 执行一次写盘；遇到 Windows 文件锁错误时按 0/120/300/600ms 重试。 */
export function writeWithRetry(fn, label = '保存本地配置') {
  let last = null
  for (const delay of DELAYS_MS) {
    try {
      return fn()
    } catch (error) {
      last = error
      if (!RETRYABLE.has(String(error?.code || ''))) break
      pause(delay)
    }
  }
  throw friendlyError(label, last)
}

/**
 * 给 electron-store 实例包一层：set/delete/clear 都走重试和友好错误。
 * 读操作不包——读永远是安全的，锁住的只是写入。
 */
export function makeResilientStore(store, label = '保存本地配置') {
  const rawSet = store.set.bind(store)
  const rawDelete = store.delete.bind(store)
  const rawClear = store.clear.bind(store)
  store.set = (key, value) => writeWithRetry(() => rawSet(key, value), label)
  store.delete = (key) => writeWithRetry(() => rawDelete(key), label)
  store.clear = () => writeWithRetry(() => rawClear(), label)
  return store
}

export { RETRYABLE }
