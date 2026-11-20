const $ = id => document.getElementById(id)
const login = $('login'); const consoleView = $('console'); const jobs = $('jobs'); const events = $('events'); const profiles = $('profiles'); const schedules = $('schedules')
const api = async (url, options = {}) => { const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData; const headers = { ...(options.headers || {}) }; if (!isForm && options.body !== undefined) headers['content-type'] = 'application/json'; const response = await fetch(url, { credentials: 'same-origin', ...options, headers }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error?.message || data.error?.code || `HTTP ${response.status}`); return data }
const renderJobs = list => { jobs.textContent = ''; for (const job of list) { const item = document.createElement('li'); item.className = 'job'; const label = document.createElement('span'); const detail = job.result?.price != null ? ` · ¥${job.result.price}` : (job.error_code ? ` · ${job.error_code}` : ''); label.textContent = `${job.type} · ${job.status}${detail} · ${job.id}`; item.append(label); if (['pending', 'running'].includes(job.status)) { const button = document.createElement('button'); button.textContent = '停止'; button.className = 'danger'; button.onclick = async () => { await api(`/jobs/${job.id}/cancel`, { method: 'POST', body: '{}' }); await refreshJobs() }; item.append(button) } jobs.append(item) } }
let profileList = []
const renderProfiles = list => { profileList = list; profiles.textContent = ''; for (const id of ['job-profile', 'schedule-profile']) { const select = $(id); select.textContent = ''; const blank = document.createElement('option'); blank.value = ''; blank.textContent = '请选择 Profile'; select.append(blank); for (const profile of list) { const option = document.createElement('option'); option.value = profile.id; option.textContent = `${profile.label} · ${profile.provider}`; select.append(option) } } for (const profile of list) { const item = document.createElement('li'); item.className = 'job'; item.textContent = `${profile.label} · ${profile.provider} · ${profile.vendor_profile_id}`; profiles.append(item) } }
const refreshProfiles = async () => { const data = await api('/profiles'); renderProfiles(data.profiles || []) }
const renderSchedules = list => { schedules.textContent = ''; for (const schedule of list) { const item = document.createElement('li'); item.className = 'job'; item.textContent = `${schedule.name} · 每 ${Math.round(schedule.interval_ms / 1000)} 秒 · ${schedule.enabled ? '启用' : '停用'}`; schedules.append(item) } }
const refreshSchedules = async () => { const data = await api('/schedules'); renderSchedules(data.schedules || []) }
const renderArtifacts = list => { $('artifacts').textContent = ''; for (const artifact of list) { const item = document.createElement('li'); item.className = 'job'; const link = document.createElement('a'); link.href = `/artifacts/${encodeURIComponent(artifact.id)}`; link.textContent = `${artifact.name}（${artifact.size} bytes）`; link.download = artifact.name; item.append(link); $('artifacts').append(item) } }
const refreshArtifacts = async () => { const data = await api('/artifacts'); renderArtifacts(data.artifacts || []) }
const refreshJobs = async () => { const data = await api('/jobs'); renderJobs(data.jobs || []); await Promise.all([refreshProfiles(), refreshSchedules(), refreshArtifacts()]) }
let eventCursor = 0
let eventReconnectTimer = null
const connectEvents = () => {
  if (eventReconnectTimer) { clearTimeout(eventReconnectTimer); eventReconnectTimer = null }
  const source = new EventSource(`/events?after=${encodeURIComponent(eventCursor)}`)
  const handle = event => {
    const cursor = Number(event.lastEventId)
    if (Number.isFinite(cursor) && cursor > eventCursor) eventCursor = cursor
    events.textContent += `${event.lastEventId} ${event.type}: ${event.data}\n`
    refreshJobs().catch(() => {})
  }
  for (const type of ['job.created', 'job.claimed', 'job.succeeded', 'job.failed', 'job.cancelled', 'worker.heartbeat', 'task.pause', 'task.resume', 'task.stop']) source.addEventListener(type, handle)
  // This legacy console explicitly reconnects with the last cursor. The full
  // renderer adapter relies on native EventSource retry, but both paths must
  // replay events instead of starting from cursor zero after a network flap.
  source.onerror = () => { source.close(); eventReconnectTimer = setTimeout(connectEvents, 3000) }
}
$('login-form').onsubmit = async event => { event.preventDefault(); $('login-error').textContent = ''; try { const data = await api('/auth/login', { method: 'POST', body: JSON.stringify({ username: $('username').value, password: $('password').value }) }); $('user').textContent = `${data.user.displayName}（${data.user.role}）`; login.classList.add('hidden'); consoleView.classList.remove('hidden'); await refreshJobs(); connectEvents() } catch (error) { $('login-error').textContent = error.message } }
$('logout').onclick = async () => { await api('/auth/logout', { method: 'POST', body: '{}' }).catch(() => {}); location.reload() }
$('refresh').onclick = () => refreshJobs().catch(error => { $('job-error').textContent = error.message })
$('job-form').onsubmit = async event => { event.preventDefault(); $('job-error').textContent = ''; try { const payload = JSON.parse($('job-payload').value || '{}'); await api('/jobs', { method: 'POST', body: JSON.stringify({ type: $('job-type').value, profileId: $('job-profile').value || undefined, payload }) }); await refreshJobs() } catch (error) { $('job-error').textContent = error.message } }
$('profile-form').onsubmit = async event => { event.preventDefault(); $('profile-error').textContent = ''; try { await api('/profiles', { method: 'POST', body: JSON.stringify({ provider: $('profile-provider').value, vendorProfileId: $('vendor-profile-id').value, label: $('profile-label').value }) }); event.target.reset(); await refreshProfiles() } catch (error) { $('profile-error').textContent = error.message } }
$('schedule-form').onsubmit = async event => { event.preventDefault(); $('schedule-error').textContent = ''; try { const payload = JSON.parse($('schedule-payload').value || '{}'); await api('/schedules', { method: 'POST', body: JSON.stringify({ name: $('schedule-name').value, intervalMs: Number($('schedule-interval').value) * 1000, profileId: $('schedule-profile').value || undefined, jobType: 'market_snapshot', payload }) }); await refreshSchedules() } catch (error) { $('schedule-error').textContent = error.message } }
$('artifact-form').onsubmit = async event => { event.preventDefault(); $('artifact-error').textContent = ''; try { const file = $('artifact-file').files[0]; const form = new FormData(); form.append('file', file); await api('/artifacts', { method: 'POST', body: form }); event.target.reset(); await refreshArtifacts() } catch (error) { $('artifact-error').textContent = error.message } }
api('/auth/me').then(data => { $('user').textContent = `${data.user.displayName}（${data.user.role}）`; login.classList.add('hidden'); consoleView.classList.remove('hidden'); refreshJobs(); connectEvents() }).catch(() => {})
