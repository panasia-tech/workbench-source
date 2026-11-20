"use strict"

function createServerScheduler({ db, tickMs = 1000, now = () => new Date() } = {}) {
  if (!db) throw new Error('scheduler database is required')
  let timer = null
  let running = false
  const tick = () => db.enqueueDueSchedules(now())
  return {
    async start() {
      if (running) return
      running = true
      tick()
      timer = setInterval(() => { try { tick() } catch {} }, Math.max(100, Number(tickMs) || 1000))
    },
    async stop() { running = false; if (timer) clearInterval(timer); timer = null },
    tick,
    isRunning: () => running
  }
}

module.exports = { createServerScheduler }
