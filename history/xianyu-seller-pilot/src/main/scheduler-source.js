// Pure scheduler source projection.  Keeping the final source decision free
// of Electron/network imports makes the fail-closed contract testable without
// starting a browser window or connecting to the upstream API.

export function buildUnifiedSchedulerSource({ tasks = [], settings = {}, sourceState = null } = {}) {
  const ready = sourceState?.ready === true
  if (!ready) {
    return {
      tasks: [],
      source: 'api_spu',
      settings,
      sourceState: sourceState || null,
      blockedReason: sourceState?.reason || '库存 API 尚无可用的最近成功快照'
    }
  }
  const executable = Array.isArray(tasks) ? tasks : []
  return {
    tasks: executable,
    source: 'api_spu',
    settings,
    sourceState,
    blockedReason: executable.length ? null : '当前 API-SPU/Excel 扩展投影没有可执行任务'
  }
}
