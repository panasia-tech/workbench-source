const formatTime = (date) => {
  const y = date.getFullYear()
  const m = date.getMonth() + 1
  const d = date.getDate()
  const h = date.getHours()
  const min = date.getMinutes()
  return `${y}-${m}-${d} ${h}:${min}`
}

module.exports = { formatTime }
