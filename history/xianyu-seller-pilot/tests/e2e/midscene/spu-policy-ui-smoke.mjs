import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const runDir = join(process.cwd(), 'artifacts', 'regression', `spu-policy-${Date.now()}`)
mkdirSync(runDir, { recursive: true })
const report = { feature: 'spu-policy-ui', status: 'BLOCKED', reason: '未提供真实安装版 Electron + Midscene 登录会话；仅完成离线 UI 契约测试', evidenceDir: runDir, steps: ['launch installed artifact', 'open inventory SPU', 'save policy', 'preview effective policy', 'request recollect'] }
writeFileSync(join(runDir, 'report.json'), JSON.stringify(report, null, 2))
console.log(`SPU policy UI Midscene smoke: ${report.status} (${report.reason})`)
process.exitCode = 2
