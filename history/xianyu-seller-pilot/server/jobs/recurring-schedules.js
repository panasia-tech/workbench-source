"use strict"

// The company runs in Asia/Shanghai.  Keeping the calendar calculation here
// avoids relying on the Linux host's local timezone and makes a restart safe:
// the durable schedules table remains the source of truth for the next due
// instant while this module only calculates a first/explicitly changed run.
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

const WORKBENCH_SCHEDULE_ID = 'system-workbench-daily'
const SELLER_SCHEDULE_ID = 'system-seller-weekly'

function localParts(now = new Date()) {
  const instant = new Date(now).getTime()
  if (!Number.isFinite(instant)) throw new TypeError('now must be a valid date')
  const value = new Date(instant + SHANGHAI_OFFSET_MS)
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth(),
    date: value.getUTCDate(),
    day: value.getUTCDay(),
    hour: value.getUTCHours(),
    minute: value.getUTCMinutes()
  }
}

function parseTime(value, fallback = '02:00') {
  const text = String(value || fallback).trim()
  const match = text.match(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
  if (!match) throw Object.assign(new Error('schedule time must use HH:mm'), { code: 'schedule_time_invalid' })
  return text
}

function nextDailyRun(now = new Date(), time = '02:00') {
  const value = parseTime(time)
  const [hour, minute] = value.split(':').map(Number)
  const current = localParts(now)
  let day = current.date
  if (current.hour > hour || (current.hour === hour && current.minute >= minute)) day += 1
  return new Date(Date.UTC(current.year, current.month, day, hour, minute) - SHANGHAI_OFFSET_MS)
}

function nextWeeklyRun(now = new Date(), weeklyDay = 1, time = '02:00') {
  const day = Number(weeklyDay)
  if (!Number.isInteger(day) || day < 0 || day > 6) throw Object.assign(new Error('weeklyDay must be an integer from 0 to 6'), { code: 'schedule_day_invalid' })
  const value = parseTime(time)
  const [hour, minute] = value.split(':').map(Number)
  const current = localParts(now)
  let daysAhead = (day - current.day + 7) % 7
  if (daysAhead === 0 && (current.hour > hour || (current.hour === hour && current.minute >= minute))) daysAhead = 7
  return new Date(Date.UTC(current.year, current.month, current.date + daysAhead, hour, minute) - SHANGHAI_OFFSET_MS)
}

function scheduleRow(db, id) {
  return typeof db.getSchedule === 'function' ? db.getSchedule(id) : null
}

function syncRecurringSchedule(db, {
  id,
  name,
  jobType,
  enabled,
  intervalMs,
  nextRunAt,
  payload = {},
  profileId = null,
  createdBy = null,
  preserveNext = true
} = {}) {
  const existing = scheduleRow(db, id)
  return db.upsertSchedule({
    id,
    name,
    jobType,
    enabled,
    intervalMs,
    payload,
    profileId,
    createdBy,
    nextRunAt: preserveNext && existing ? existing.next_run_at : nextRunAt
  })
}

function syncWorkbenchSchedule(db, settings = {}, { now = new Date(), actorId = null, forceNext = false } = {}) {
  const enabled = settings.dailyEnabled === true
  return syncRecurringSchedule(db, {
    id: WORKBENCH_SCHEDULE_ID,
    name: 'H5 行情任务每日采集',
    jobType: 'workbench_schedule',
    enabled,
    intervalMs: DAY_MS,
    nextRunAt: nextDailyRun(now, settings.dailyTime || '02:00'),
    payload: { kind: 'workbench', trigger: 'schedule' },
    createdBy: actorId,
    preserveNext: !forceNext
  })
}

function syncSellerSchedule(db, settings = {}, { now = new Date(), actorId = null, forceNext = false } = {}) {
  const timezone = String(settings.timezone || 'Asia/Shanghai').trim()
  if (timezone !== 'Asia/Shanghai') throw Object.assign(new Error('当前服务器计划只支持 Asia/Shanghai 时区'), { code: 'schedule_timezone_invalid' })
  const enabled = settings.weeklyEnabled === true
  return syncRecurringSchedule(db, {
    id: SELLER_SCHEDULE_ID,
    name: 'H5 卖家主页每周采集',
    jobType: 'seller_schedule',
    enabled,
    intervalMs: 7 * DAY_MS,
    nextRunAt: nextWeeklyRun(now, settings.weeklyDay ?? 1, settings.weeklyTime || '02:00'),
    payload: { kind: 'seller', trigger: 'schedule' },
    createdBy: actorId,
    preserveNext: !forceNext
  })
}

function syncAllRecurringSchedules(db, { now = new Date() } = {}) {
  const workbench = syncWorkbenchSchedule(db, db.getWorkbenchSettings(), { now })
  const seller = syncSellerSchedule(db, db.getSellerSettings(), { now })
  return { workbench, seller }
}

module.exports = {
  DAY_MS,
  SELLER_SCHEDULE_ID,
  WORKBENCH_SCHEDULE_ID,
  localParts,
  nextDailyRun,
  nextWeeklyRun,
  syncAllRecurringSchedules,
  syncSellerSchedule,
  syncWorkbenchSchedule
}
