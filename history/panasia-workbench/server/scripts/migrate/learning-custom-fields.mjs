#!/usr/bin/env node
// server/scripts/migrate/learning-custom-fields.mjs — 教程搬到 Learning（B5）第 1 步：给 Learning 加 11 个 pa_ 自定义字段。
//
// 用法（在 panasia-workbench/ 下，Node 22+）：
//   node server/scripts/migrate/learning-custom-fields.mjs            # 默认只看（dry-run）：哪些字段在、哪些要建
//   node server/scripts/migrate/learning-custom-fields.mjs --apply    # 真建：只建缺的，已有的不动
// 环境变量（或 .env.local）：FRAPPE_BASE_URL（默认 http://127.0.0.1:8000）、FRAPPE_API_KEY、FRAPPE_API_SECRET。
// 建字段要 System Manager（工作台服务账号 10-19 已有）；只加字段，不改 Learning 程序、不用重做 Frappe 镜像。
//
// 顺带做 / 顺带查：
//   - 建「岗位教程」分类（LMS Category，迁移和工作台新建的教程课都放这里）
//   - 查服务账号有没有 Moderator（没有的话课时读出来是空的而且不报错）
//   - 查 LMS Settings 的「允许游客访问」：开着的话已发布课程的预览课时公网可见（教程课默认不发布，不受影响）
// 能重复跑：字段按 name（<doctype>-<fieldname>）查，已有的跳过；类型不对的只报出来，不改。
import { PA_FIELDS, TUTORIAL_CATEGORY, frappeClient, log, parseArgs } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const APPLY = args.apply === true;

async function main() {
  const frappe = frappeClient();
  log(`Learning：${frappe.siteUrl}（${APPLY ? '真跑：只建缺的' : 'dry-run：只看不写，加 --apply 才建'}）`);
  log('');

  let missing = 0;
  let mismatched = 0;
  let created = 0;
  log('── 11 个 pa_ 字段 ──');
  for (const field of PA_FIELDS) {
    const name = `${field.dt}-${field.fieldname}`;
    const existing = await frappe.get('Custom Field', name);
    if (existing) {
      const wrongType = existing.fieldtype !== field.fieldtype;
      const wrongUnique = Boolean(field.unique) !== Boolean(existing.unique);
      if (wrongType || wrongUnique) {
        mismatched += 1;
        log(`  ！ ${name} 已有，但是 ${existing.fieldtype}${existing.unique ? '（唯一）' : ''}，要求 ${field.fieldtype}${field.unique ? '（唯一）' : ''}：不改，人工处理`);
      } else {
        log(`  √ ${name} 已有（${field.fieldtype}）`);
      }
      continue;
    }
    missing += 1;
    if (!APPLY) {
      log(`  + ${name} 要建（${field.fieldtype}${field.unique ? '，唯一' : ''}，放在 ${field.insert_after} 后面）`);
      continue;
    }
    await frappe.create('Custom Field', { ...field, read_only: 1 });
    created += 1;
    log(`  + ${name} 已建（${field.fieldtype}${field.unique ? '，唯一' : ''}）`);
  }

  log('');
  log('── 「岗位教程」分类 ──');
  const category = await frappe.get('LMS Category', TUTORIAL_CATEGORY);
  if (category) {
    log(`  √ 已有`);
  } else if (APPLY) {
    await frappe.create('LMS Category', { category: TUTORIAL_CATEGORY });
    log('  + 已建');
  } else {
    log('  + 要建');
  }

  log('');
  log('── 上线检查（只读） ──');
  const user = await frappe.method('frappe.auth.get_logged_user', {}, 'GET');
  const userDoc = user ? await frappe.get('User', user).catch(() => null) : null;
  const roles = (userDoc?.roles ?? []).map((row) => row.role);
  if (!userDoc) {
    log(`  ？ 服务账号 ${user ?? '(未知)'}：读不到角色，请到 Learning 后台确认有 Moderator`);
  } else if (roles.includes('Moderator') || user === 'Administrator') {
    log(`  √ 服务账号 ${user} 有 Moderator（课时能读全）`);
  } else {
    log(`  × 服务账号 ${user} 没有 Moderator：课时读出来会是空的而且不报错，先加上。现有角色：${roles.join('、') || '无'}`);
  }
  const settings = await frappe.get('LMS Settings', 'LMS Settings').catch(() => null);
  if (!settings) {
    log('  ？ 读不到 LMS Settings，「允许游客访问」请到 Learning 后台看一眼');
  } else if (Number(settings.allow_guest_access) === 1) {
    log('  ！ LMS Settings「允许游客访问」开着：已发布课程的预览课时公网谁都能看。教程课默认不发布、不受影响；以后要发布教程课给员工看，先关掉它');
  } else {
    log('  √ LMS Settings「允许游客访问」已关');
  }

  log('');
  if (APPLY) {
    log(`完成：新建 ${created} 个字段，已有 ${PA_FIELDS.length - missing} 个${mismatched ? `，${mismatched} 个类型不对要人工看` : ''}`);
  } else {
    log(`dry-run：要建 ${missing} 个字段，已有 ${PA_FIELDS.length - missing} 个${mismatched ? `，${mismatched} 个类型不对要人工看` : ''}；确认后加 --apply`);
  }
  process.exitCode = mismatched > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(`失败：${error.message}`);
  process.exit(1);
});
