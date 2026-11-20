#!/usr/bin/env node
// server/scripts/demo/refresh-today.mjs — 任务日期收敛（2026-10-01 用户拍板）：
// 严重堵塞演示最多 1 条（保留「商品图片抽检」2026-09-26），其余未完结任务 target_date 全部改为今天。
// 幂等：target_date 已是今天则跳过；已完结/取消任务不动（保历史完成日期）。
import { plane, asList, allIssues, log } from './lib.mjs';

const SEVERE_KEEP = '商品图片抽检'; // 唯一的严重堵塞演示任务
const CLOSED_GROUPS = ['completed', 'cancelled'];
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

const main = async () => {
  log(`== 任务日期收敛 → ${today}（保留严重堵塞：${SEVERE_KEEP}） ==`);
  const projects = asList(await plane.get('/projects/'));
  let changed = 0;
  for (const p of projects) {
    const states = asList(await plane.get(`/projects/${p.id}/states/`));
    const openStateIds = new Set(
      states.filter((s) => !CLOSED_GROUPS.includes(s.group)).map((s) => s.id),
    );
    const issues = await allIssues(p.id);
    for (const it of issues) {
      if (!openStateIds.has(it.state)) continue;
      if (it.name.startsWith(SEVERE_KEEP)) continue;
      if (it.target_date === today) continue;
      await plane.patch(`/projects/${p.id}/issues/${it.id}/`, { target_date: today });
      log(`  √ ${it.name} → ${today}`);
      changed += 1;
    }
  }
  log(`完成：更新 ${changed} 条任务日期为 ${today}`);
};

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
