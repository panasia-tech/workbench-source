// 运行断点的纯规则层：不读写本地存储，方便调度器和回归测试共用。
// 成功、无在售和低价错误都代表这一条任务已经有了可交付结果；失败/风控
// 不算完成，继续运行时会重试，避免把半截任务永久跳过。
export const RESUME_COMPLETED_STATUSES = new Set(['success', 'empty', 'invalid_price'])

export function buildResumePlan({ collectionId = null, tasks = [], runs = [], runResults = [] } = {}) {
  // runs 按新到旧保存。只认当前清单最新一轮，避免员工已经“从头开始”并完成
  // 新一轮后，界面又把更早的旧中断批次拿出来继续。
  const latestRun = (runs || []).find((run) => run.collectionId === collectionId) || null
  const previousRun = latestRun?.status === 'stopped' ? latestRun : null
  const allTasks = Array.isArray(tasks) ? tasks : []
  if (!previousRun) {
    return {
      available: false,
      runId: null,
      total: allTasks.length,
      completedCount: 0,
      pendingCount: 0,
      nextTask: '',
      stoppedAt: '',
      reason: '',
      pendingTaskIds: []
    }
  }

  const completedTaskIds = new Set(
    (runResults || [])
      .filter((row) => row.runId === previousRun.id && RESUME_COMPLETED_STATUSES.has(row.status))
      .map((row) => row.taskId)
      .filter(Boolean)
  )
  const pendingTasks = allTasks.filter((task) => !completedTaskIds.has(task.id))
  return {
    available: pendingTasks.length > 0,
    runId: previousRun.id,
    total: allTasks.length,
    completedCount: allTasks.length - pendingTasks.length,
    pendingCount: pendingTasks.length,
    nextTask: pendingTasks[0]?.name || '',
    stoppedAt: previousRun.finishedAt || previousRun.startedAt || '',
    reason: previousRun.reason || (previousRun.riskControl || previousRun.risk_control ? '检测到风控后暂停' : '上次任务中断'),
    pendingTaskIds: pendingTasks.map((task) => task.id)
  }
}
