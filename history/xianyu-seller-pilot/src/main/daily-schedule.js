// 每天按点开爬：到点了吗、错过了要不要补。纯函数，scheduler.rearmDaily 每分钟问一次。
//
// 为什么要「错过就补」：只认整点那一分钟的话，那一分钟电脑关着、巡航台没开、租约
// 还没拿到，这一天就白过了。工位电脑夜里常关机，默认的 02:00 基本碰不上。
// 所以过了点、今天本机一轮都还没跑过，就补一轮；一天只补一次，补不起来（没任务、
// 账号都没登上）也不每分钟重试，第二天再说。

const pad = (n) => String(n).padStart(2, '0')
const TIME_RE = /^\d{2}:\d{2}$/

export function dayKey(now) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

// 本机今天（按本地日期）有没有开过一轮，手动、定时、补采都算
export function ranToday(runs, now) {
  const today = now.toDateString()
  return (runs || []).some((run) => run?.startedAt && new Date(run.startedAt).toDateString() === today)
}

/**
 * @returns {null | { kind: 'due' | 'catch_up', day: string, key?: string }}
 *   due：正好到点；catch_up：过了点、今天还没跑过、今天还没补过
 */
export function dailyDecision({ now, dailyTime = '02:00', runs = [], firedKey = '', catchUpDay = '' }) {
  const at = TIME_RE.test(dailyTime || '') ? dailyTime : '02:00'
  const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  const day = dayKey(now)
  if (hhmm === at) {
    const key = `${day}-${hhmm}`
    return key === firedKey ? null : { kind: 'due', day, key }
  }
  if (hhmm > at && catchUpDay !== day && !ranToday(runs, now)) return { kind: 'catch_up', day }
  return null
}
