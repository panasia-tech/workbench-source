"use strict"

function enabledProfiles(db, requestedProfileId = null) {
  const all = db.listBrowserProfiles({ limit: 100 }).filter(profile => !['disabled', 'blocked'].includes(String(profile.status || '').toLowerCase()))
  if (requestedProfileId) {
    const exact = all.find(profile => String(profile.id) === String(requestedProfileId))
    return exact ? [exact] : []
  }
  return all
}

function pendingSellerSources(db, sample = 'all') {
  const result = db.listSellerSources({ page: 1, pageSize: 1000, group: 'pending' })
  const rows = result.items.filter(row => row.enabled)
  return sample === 'canary20' ? rows.slice(0, 20) : rows
}

function enqueueSellerRun(db, sources, { actorId = null, profileId = null, trigger = 'manual', sample = 'all' } = {}) {
  const selected = (Array.isArray(sources) ? sources : []).filter(Boolean)
  if (!selected.length) return { run: null, jobs: [], sources: [], skipped: true }
  const profiles = enabledProfiles(db, profileId)
  if (!profiles.length) throw Object.assign(new Error('请先配置可用浏览器 Profile'), { code: 'profile_required' })
  const run = db.createSellerRun({ trigger, total: selected.length, createdBy: actorId })
  const jobs = selected.map((source, index) => {
    const profile = profiles[index % profiles.length]
    return db.createJob({
      type: 'seller_snapshot',
      profileId: profile.id,
      operatorId: actorId,
      payload: {
        sellerSourceId: source.id,
        sellerUrl: source.url,
        sellerName: source.sellerName || source.name || '',
        sellerRunId: run.id,
        maxAttempts: 2
      }
    })
  })
  db.audit({ actorId, action: 'seller.run.start', entityType: 'seller_run', entityId: run.id, metadata: { total: jobs.length, profileIds: [...new Set(jobs.map(job => job.profile_id).filter(Boolean))], trigger, sample } })
  return { run, jobs, sources: selected, skipped: false }
}

function enqueueScheduledSeller(db, job) {
  const result = enqueueSellerRun(db, pendingSellerSources(db), { actorId: job?.operator_id || null, trigger: 'schedule', sample: 'all' })
  return { status: 'succeeded', kind: 'seller_schedule', runId: result.run?.id || null, total: result.jobs.length, skipped: result.skipped }
}

module.exports = { enabledProfiles, enqueueScheduledSeller, enqueueSellerRun, pendingSellerSources }
