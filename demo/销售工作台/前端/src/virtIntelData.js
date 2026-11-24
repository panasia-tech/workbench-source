import seed from './virtIntelSeed.json'

export const VIRT_INTEL_SEED = seed

export function cloneSeed () {
  return JSON.parse(JSON.stringify(seed))
}

export function computeEconomics (price, directCost, feeRate, laborHours, hourlyRate = 50) {
  const p = Number(price) || 0
  const dc = Number(directCost) || 0
  const fr = Number(feeRate) || 0
  const lh = Number(laborHours) || 0
  const hr = Number(hourlyRate) || 50
  const fee = p * fr
  const labor = lh * hr
  const net = p - fee - dc - labor
  const marginPct = p > 0 ? (net / p) * 100 : -100
  const roiPerHour = lh > 0 ? net / lh : net * 50
  return {
    fee: Number(fee.toFixed(2)),
    laborCost: Number(labor.toFixed(2)),
    netProfit: Number(net.toFixed(2)),
    marginPct: Number(marginPct.toFixed(1)),
    roiPerHour: Number(roiPerHour.toFixed(1)),
  }
}
