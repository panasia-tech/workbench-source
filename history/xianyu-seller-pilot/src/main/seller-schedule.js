export const SELLER_TIMEZONE = 'Asia/Shanghai'
export const SELLER_CATCH_UP_MS = 24 * 60 * 60 * 1000

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

function assertSchedule({ weeklyDay, weeklyTime, timezone }) {
  if (timezone !== SELLER_TIMEZONE) throw new TypeError(`timezone must be ${SELLER_TIMEZONE}`)
  if (!Number.isInteger(Number(weeklyDay)) || Number(weeklyDay) < 0 || Number(weeklyDay) > 6) {
    throw new TypeError('weeklyDay must be an integer from 0 to 6')
  }
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(weeklyTime || ''))) {
    throw new TypeError('weeklyTime must use HH:mm')
  }
}

function localParts(nowMs) {
  const local = new Date(nowMs + SHANGHAI_OFFSET_MS)
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth(),
    date: local.getUTCDate(),
    day: local.getUTCDay(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes()
  }
}

function scheduleInstant(nowMs, weeklyDay, weeklyTime) {
  const current = localParts(nowMs)
  const [hour, minute] = weeklyTime.split(':').map(Number)
  if (current.day === weeklyDay && (current.hour < hour || (current.hour === hour && current.minute < minute))) {
    return null
  }
  const daysBack = (current.day - weeklyDay + 7) % 7
  const localScheduleMs = Date.UTC(current.year, current.month, current.date - daysBack, hour, minute)
  return localScheduleMs - SHANGHAI_OFFSET_MS
}

function cycleKeyOf(instantMs, weeklyTime) {
  const local = localParts(instantMs)
  const date = `${local.year}-${String(local.month + 1).padStart(2, '0')}-${String(local.date).padStart(2, '0')}`
  return `seller-weekly:${date}:${weeklyTime}:${SELLER_TIMEZONE}`
}

/** Pure persisted-cycle eligibility decision; callers persist cycleKey before navigation. */
export function evaluateSchedule({
  now = new Date(),
  settings = null,
  weeklyDay = settings?.weeklyDay ?? 1,
  weeklyTime = settings?.weeklyTime ?? '02:00',
  timezone = settings?.timezone ?? SELLER_TIMEZONE,
  lastCycle = null,
  lastCycleKey = null,
  running = false,
  catchUpMs = SELLER_CATCH_UP_MS
} = {}) {
  if (settings?.weeklyEnabled === false) {
    return { outcome: 'idle', shouldStart: false, cycleKey: null, scheduledAt: null, ageMs: null }
  }
  assertSchedule({ weeklyDay, weeklyTime, timezone })
  const nowMs = new Date(now).getTime()
  if (!Number.isFinite(nowMs)) throw new TypeError('now must be a valid date')
  const scheduledMs = scheduleInstant(nowMs, Number(weeklyDay), weeklyTime)
  if (scheduledMs == null) return { outcome: 'idle', shouldStart: false, cycleKey: null, scheduledAt: null, ageMs: null }

  const cycleKey = cycleKeyOf(scheduledMs, weeklyTime)
  const scheduledAt = new Date(scheduledMs).toISOString()
  const ageMs = Math.max(0, nowMs - scheduledMs)
  const persistedCycleKey = lastCycle?.cycleKey || lastCycle?.lastCycleKey || lastCycleKey
  if (cycleKey === persistedCycleKey) return { outcome: 'duplicate', shouldStart: false, cycleKey, scheduledAt, ageMs }
  if (running) return { outcome: 'skipped_overlap', shouldStart: false, cycleKey, scheduledAt, ageMs }
  if (ageMs < 60 * 1000) return { outcome: 'scheduled', shouldStart: true, cycleKey, scheduledAt, ageMs }
  if (ageMs <= Number(catchUpMs)) return { outcome: 'catch_up', shouldStart: true, cycleKey, scheduledAt, ageMs }
  return { outcome: 'missed', shouldStart: false, cycleKey, scheduledAt, ageMs }
}
