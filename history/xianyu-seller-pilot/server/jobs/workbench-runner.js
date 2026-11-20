"use strict"

const RESUMABLE_STATUSES = new Set(['pending', 'failed', 'empty', 'invalid_price', 'risk_control'])

function text(value) { return String(value ?? '').trim() }

function policyForTask(db, task) {
  const policy = task?.spuCode && typeof db.getSpuPolicy === 'function'
    ? (db.getSpuPolicy(task.spuCode) || {})
    : {}
  const settings = db.getWorkbenchSettings()
  const globalTerms = Array.isArray(settings.blacklistKeywords) ? settings.blacklistKeywords : []
  const localTerms = Array.isArray(policy.blacklist?.terms) ? policy.blacklist.terms : []
  const blacklistMode = text(policy.blacklist?.mode).toLowerCase() || 'inherit'
  const blacklistKeywords = blacklistMode === 'replace'
    ? localTerms
    : blacklistMode === 'append'
      ? [...globalTerms, ...localTerms]
      : globalTerms
  const explicitQueries = Array.isArray(policy.search?.queries) ? policy.search.queries.map(text).filter(Boolean) : []
  const keywords = text(policy.search?.mode).toLowerCase() === 'explicit' && explicitQueries.length
    ? explicitQueries
    : (Array.isArray(task.searchKeywords) ? task.searchKeywords : []).map(text).filter(Boolean)
  return {
    settings,
    policy,
    keywords: [...new Set(keywords)].slice(0, 20),
    blacklistKeywords: [...new Set(blacklistKeywords.map(text).filter(Boolean))].slice(0, 100),
    priceFence: policy.priceFence && typeof policy.priceFence === 'object' ? policy.priceFence : {}
  }
}

function jobInput(db, task, runId, profileId, { maxAttempts = 2 } = {}) {
  const resolved = policyForTask(db, task)
  return {
    type: 'market_snapshot',
    profileId,
    payload: {
      workbenchTaskId: task.id,
      workbenchRunId: runId,
      keywords: resolved.keywords,
      blacklistKeywords: resolved.blacklistKeywords,
      priceFence: resolved.priceFence,
      referencePrice: task.referencePrice,
      queryDelayMinMs: resolved.settings.queryDelayMinMs,
      queryDelayMaxMs: resolved.settings.queryDelayMaxMs,
      maxAttempts
    }
  }
}

function enabledProfiles(db, requestedProfileId = null) {
  const all = db.listBrowserProfiles({ limit: 100 }).filter(profile => !['disabled', 'blocked'].includes(String(profile.status || '').toLowerCase()))
  if (requestedProfileId) {
    const exact = all.find(profile => String(profile.id) === String(requestedProfileId))
    return exact ? [exact] : []
  }
  return all
}

function resumableTasks(db, { resume = false, taskId = '' } = {}) {
  const all = db.listWorkbenchTasks({ page: 1, pageSize: 2000, includeDisabled: false }).items
  if (taskId) return all.filter(task => String(task.id) === String(taskId) && RESUMABLE_STATUSES.has(String(task.lastStatus || 'pending')))
  if (resume) return all.filter(task => RESUMABLE_STATUSES.has(String(task.lastStatus || 'pending')))
  return all.filter(task => String(task.lastStatus || 'pending') === 'pending')
}

function retryableTasks(db, { taskId = '' } = {}) {
  const tasks = resumableTasks(db, { resume: true, taskId })
  return taskId ? tasks : tasks.filter(task => String(task.lastStatus || '') !== 'pending')
}

function enqueueWorkbenchTasks(db, tasks, { actorId = null, profileId = null, trigger = 'manual', resume = false, taskId = '' } = {}) {
  const settings = db.getWorkbenchSettings()
  const limit = Number(settings.maxTasks) > 0 ? Math.floor(Number(settings.maxTasks)) : 0
  const selected = (Array.isArray(tasks) ? tasks : []).filter(Boolean).slice(0, limit || undefined)
  if (!selected.length) return { run: null, jobs: [], tasks: [], skipped: true }
  const profiles = enabledProfiles(db, profileId)
  if (!profiles.length) throw Object.assign(new Error('请先配置可用浏览器 Profile'), { code: 'profile_required' })
  const run = db.createWorkbenchRun({ collectionId: selected[0].collectionId, trigger, total: selected.length, createdBy: actorId })
  const jobs = selected.map((task, index) => {
    const profile = profiles[index % profiles.length]
    return db.createJob({ ...jobInput(db, task, run.id, profile.id), operatorId: actorId })
  })
  db.audit({ actorId, action: 'workbench.run.start', entityType: 'workbench_run', entityId: run.id, metadata: { total: jobs.length, profileIds: [...new Set(jobs.map(job => job.profile_id).filter(Boolean))], trigger, resume: Boolean(resume), taskId: taskId || null } })
  return { run, jobs, tasks: selected, skipped: false }
}

function enqueueScheduledWorkbench(db, job) {
  const actorId = job?.operator_id || null
  const result = enqueueWorkbenchTasks(db, resumableTasks(db, { resume: true }), { actorId, trigger: 'schedule', resume: true })
  return { status: 'succeeded', kind: 'workbench_schedule', runId: result.run?.id || null, total: result.jobs.length, skipped: result.skipped }
}

module.exports = {
  RESUMABLE_STATUSES,
  enqueueScheduledWorkbench,
  enqueueWorkbenchTasks,
  enabledProfiles,
  jobInput,
  policyForTask,
  retryableTasks,
  resumableTasks
}
