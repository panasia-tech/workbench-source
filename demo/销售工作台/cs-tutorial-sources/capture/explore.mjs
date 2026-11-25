import fs from 'node:fs';
import { launch, nav, snap, click, dump, sleep } from './cdp.mjs';

const HERE = decodeURIComponent(new URL('.', import.meta.url).pathname);
const OUT = HERE + 'raw/explore/';
fs.mkdirSync(OUT, { recursive: true });

const { cdp, close } = await launch({ w: 1440, h: 900 });
try {
  // 1. cs_newbie
  await nav(cdp, '/cs-workbench', 'cs_newbie');
  await snap(cdp, OUT + '01_newbie.png');
  console.log('=== 01_newbie ===\n' + await dump(cdp));

  // Click unlock practice
  try {
    await click(cdp, '立即去做 3 关练习解锁', 'button');
    await snap(cdp, OUT + '02_newbie_gate.png');
    console.log('=== 02_newbie_gate ===\n' + await dump(cdp));
  } catch (e) { console.log('newbie gate err:', e.message); }

  // 2. outsource_lu presale (default)
  await nav(cdp, '/cs-workbench', 'outsource_lu');
  await snap(cdp, OUT + '03_outsource_presale.png');
  console.log('=== 03_outsource_presale ===\n' + await dump(cdp));

  // Click 售后
  await click(cdp, '售后', 'button');
  await snap(cdp, OUT + '04_outsource_aftersale.png');
  console.log('=== 04_outsource_aftersale ===\n' + await dump(cdp));

  // Click 问题订单
  await click(cdp, '问题订单', 'button');
  await snap(cdp, OUT + '05_outsource_issue.png');
  console.log('=== 05_outsource_issue ===\n' + await dump(cdp));

  // Open 自动发图 drawer
  await click(cdp, '自动发图', 'button');
  await snap(cdp, OUT + '06_auto_rules.png');
  console.log('=== 06_auto_rules ===\n' + await dump(cdp));

  // Open 全维考核
  await nav(cdp, '/cs-workbench', 'outsource_lu');
  await click(cdp, '全维考核', 'button');
  await snap(cdp, OUT + '07_kpi_drawer.png');
  console.log('=== 07_kpi_drawer ===\n' + await dump(cdp));

  // 3. chenxm internal takeover view
  await nav(cdp, '/cs-workbench', 'chenxm');
  await snap(cdp, OUT + '08_chenxm_cs.png');
  console.log('=== 08_chenxm_cs ===\n' + await dump(cdp));

  // Expand fold 跨部门协同
  try {
    await click(cdp, '跨部门协同', 'button.fold-head');
    await snap(cdp, OUT + '09_chenxm_takeover.png');
    console.log('=== 09_chenxm_takeover ===\n' + await dump(cdp));
  } catch (e) { console.log('chenxm fold err:', e.message); }

  // 4. admin settlement drawer
  await nav(cdp, '/cs-workbench', 'admin');
  await click(cdp, '全维考核', 'button');
  await snap(cdp, OUT + '10_admin_kpi.png');
  console.log('=== 10_admin_kpi ===\n' + await dump(cdp));
} finally {
  await close();
}
