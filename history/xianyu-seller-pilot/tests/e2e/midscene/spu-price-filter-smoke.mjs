// Real GUI gate for page-price RPA. The offline adapter regression is separate;
// without an explicitly supplied logged-in AdsPower session this test must
// remain BLOCKED rather than claiming a fixture is a live pass.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const runDir = join(process.cwd(), 'artifacts', 'regression', `spu-price-filter-${Date.now()}`)
mkdirSync(runDir, { recursive: true })
const report = {
  feature: 'spu-price-filter',
  status: process.env.XIANYU_MIDSCENE_SESSION ? 'NOT_RUN' : 'BLOCKED',
  reason: process.env.XIANYU_MIDSCENE_SESSION ? 'Midscene runner integration is not configured in this workspace' : '缺少真实登录闲鱼会话/批准的 GUI 运行器',
  steps: ['launch', 'search', 'open price filter', 'input min/max', 'confirm', 'read state', 'capture screenshot'],
  evidenceDir: runDir
}
writeFileSync(join(runDir, 'report.json'), JSON.stringify(report, null, 2))
console.log(`SPU price-filter Midscene smoke: ${report.status} (${report.reason})`)
if (report.status === 'BLOCKED') process.exitCode = 2
