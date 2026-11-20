#!/usr/bin/env node
// server/scripts/migrate/nocobase-to-learning.mjs — 教程从 NocoBase 搬到 Learning（需求 B5，10-19 老板定稿）。
//
// 搬：教程 → 课程（pa_code=nocobase-<id>-<code>，分类「岗位教程」，不发布，关自助报名，讲师 = 服务账号）、
//     阶段 → 章节（pa_description / pa_duration_note）、步骤 → 课时（pa_step_key=nb-<步骤 id> + 指引 / 闸口 / 视频 / 材料，
//     正文按 pa_ 字段生成，和工作台保存时同一份代码 server/modules/profile/tutorial-lesson-body.ts）。
// 不搬：案例、提交（妙搭时期的测试数据）、tutorial_admins；导出 JSON 里留档。
// 撞名（Learning 已有同名课）以 NocoBase 为准：新建岗位教程课，旧的同名课取消发布、不删（--keep-old 不动它）。
//
// 用法（在 panasia-workbench/ 下，Node 22.18+，要直接 import .ts）：
//   node server/scripts/migrate/nocobase-to-learning.mjs                       # dry-run：导出 NocoBase + 和 Learning 对照，出报告，不写
//   node server/scripts/migrate/nocobase-to-learning.mjs --apply --from-export deploy/dump/tutorial-migration-<时间>
//                                                                              # 真跑：按老板看过的那份导出写 Learning
//   node server/scripts/migrate/nocobase-to-learning.mjs --rollback [--restore <apply-result.json>] [--apply]
//                                                                              # 回退：删 pa_code 以 nocobase- 开头的课，按记录恢复旧课发布
// 选项：--projects 2,3,5,7（默认这 4 套）  --out <目录>（默认 deploy/dump/tutorial-migration-<时间>，已在 .gitignore）
//       --rebuild（已搬过的课原地重建章节课时：课程 name、步骤编号不变，工作台已有的案例接得上）
//       --keep-old（撞名的旧课不取消发布）  --instructor <邮箱>（默认 LEARNING_INSTRUCTOR，再默认服务账号自己）
// 环境变量（或 .env.local）：FRAPPE_BASE_URL / FRAPPE_API_KEY / FRAPPE_API_SECRET；
//   NOCOBASE_BASE_URL / NOCOBASE_AUTHENTIK_UID / NOCOBASE_AUTHENTIK_EMAIL（--from-export 时不用）。
// 能重复跑：已有同 pa_code 的课跳过（不完整的报出来，加 --rebuild 修）。新建中途失败，整门课删掉再报错。
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PA_FIELDS,
  TUTORIAL_CATEGORY,
  frappeClient,
  log,
  nocobaseClient,
  parseArgs,
  timestamp,
} from './lib.mjs';
import {
  DEFAULT_PROJECTS,
  buildPlan,
  coursesToRetire,
  renderConsole,
  renderMarkdown,
} from './migrate-plan.mjs';

const TABLES = [
  'tutorial_projects',
  'tutorial_stages',
  'tutorial_steps',
  'tutorial_step_materials',
  'tutorial_cases',
  'tutorial_step_submissions',
  'tutorial_admins',
];
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const args = parseArgs(process.argv.slice(2), ['projects', 'out', 'from-export', 'restore', 'instructor']);
const APPLY = args.apply === true;

/** 正文生成和工作台同一份代码；包没写 "type": "module"，Node 按 ES module 重解析时的提示压掉 */
async function loadLessonBody() {
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    if (warning.code !== 'MODULE_TYPELESS_PACKAGE_JSON') console.warn(String(warning));
  });
  try {
    return await import('../../modules/profile/tutorial-lesson-body.ts');
  } catch (error) {
    throw new Error(`加载 tutorial-lesson-body.ts 失败（要 Node 22.18+，老版本加 --experimental-strip-types）：${error.message}`);
  }
}

function outDir() {
  const dir = resolve(ROOT, args.out ?? join('deploy', 'dump', `tutorial-migration-${timestamp()}`));
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function exportNocobase(dir) {
  const noco = nocobaseClient();
  log(`导出 NocoBase ${noco.base} 的 ${TABLES.length} 张表（只读，20 条一页翻到底）…`);
  const tables = {};
  for (const name of TABLES) {
    try {
      tables[name] = await noco.listAll(name);
    } catch (error) {
      if (name !== 'tutorial_admins') throw error;
      log(`  ！ ${name} 读不到（${error.message}），工作台本来就不读它，记空`);
      tables[name] = [];
    }
    log(`  ${name}: ${tables[name].length}`);
  }
  const data = { exportedAt: new Date().toISOString(), source: noco.base, tables };
  writeFileSync(join(dir, 'nocobase-export.json'), JSON.stringify(data, null, 2));
  return data;
}

function readExport(path) {
  const full = resolve(ROOT, path);
  const file = statSync(full).isDirectory() ? join(full, 'nocobase-export.json') : full;
  if (!existsSync(file)) throw new Error(`找不到导出文件 ${file}`);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  for (const name of TABLES) data.tables[name] ??= [];
  return data;
}

/** Learning 现状：pa_ 字段在不在、每门课的大纲（章节 / 课时标题）、讲师、发布、创建时间 */
async function snapshotLearning(frappe) {
  const missingFields = [];
  for (const field of PA_FIELDS) {
    if (!(await frappe.get('Custom Field', `${field.dt}-${field.fieldname}`))) {
      missingFields.push(`${field.dt}.${field.fieldname}`);
    }
  }
  const hasCode = !missingFields.includes('LMS Course.pa_code');
  const hasStepKey = !missingFields.includes('Course Lesson.pa_step_key');
  const rows = await frappe.list('LMS Course', [
    'name',
    'title',
    'category',
    'published',
    'creation',
    ...(hasCode ? ['pa_code'] : []),
  ]);
  const stepKeys = new Map();
  if (hasStepKey) {
    for (const lesson of await frappe.list('Course Lesson', ['name', 'pa_step_key'])) {
      if (lesson.pa_step_key) stepKeys.set(lesson.name, lesson.pa_step_key);
    }
  }
  const courses = [];
  for (const row of rows) {
    const [outline, doc] = await Promise.all([
      frappe.method('lms.lms.utils.get_course_outline', { course: row.name }, 'GET'),
      frappe.get('LMS Course', row.name),
    ]);
    courses.push({
      name: row.name,
      title: row.title ?? row.name,
      category: row.category ?? null,
      published: Number(row.published) === 1,
      creation: row.creation ?? null,
      paCode: row.pa_code || null,
      instructors: (doc?.instructors ?? []).map((item) => item.instructor).filter(Boolean),
      chapters: (Array.isArray(outline) ? outline : []).map((chapter) => ({
        name: chapter.name,
        title: chapter.title ?? chapter.name,
        lessons: (chapter.lessons ?? []).map((lesson) => ({
          name: lesson.name,
          title: lesson.title ?? lesson.name,
          stepKey: stepKeys.get(lesson.name) ?? null,
        })),
      })),
    });
  }
  return { missingFields, courses };
}

/** 写一套教程。已搬过（--rebuild）：课程原地留着、章节课时删了重建；新建失败整门课删掉 */
async function writeProject(frappe, body, project, instructor) {
  const intro = body.courseIntro(project.name, project.description);
  let courseName;
  let createdNow = false;
  if (project.existing) {
    courseName = project.existing.name;
    await frappe.update('LMS Course', courseName, { title: project.name, ...intro });
    for (const chapter of project.existing.chapters) {
      await frappe.method('lms.lms.api.delete_chapter', { chapter: chapter.name });
    }
  } else {
    const course = await frappe.create('LMS Course', {
      title: project.name,
      ...intro,
      // 讲师必填（不填 MandatoryError，老坑）
      instructors: [{ instructor }],
      category: TUTORIAL_CATEGORY,
      published: 0,
      disable_self_learning: 1,
      pa_code: project.targetCode,
    });
    courseName = course.name;
    createdNow = true;
  }
  try {
    for (const stage of project.tree.stages) {
      const chapter = await frappe.method('lms.lms.api.upsert_chapter', {
        title: stage.title,
        course: courseName,
        is_scorm_package: false,
      });
      if (stage.description || stage.durationNote) {
        await frappe.update('Course Chapter', chapter.name, {
          pa_description: stage.description ?? '',
          pa_duration_note: stage.durationNote ?? '',
        });
      }
      let idx = 0;
      for (const step of stage.steps) {
        // 带真标题直接建课时（不用 create_lesson，它先建「Untitled lesson」），再像 Learning 前台一样挂进章节
        const lesson = await frappe.create('Course Lesson', {
          title: step.title,
          chapter: chapter.name,
          course: courseName,
          pa_step_key: step.key,
          ...body.stepFieldsToLesson(step.fields),
        });
        idx += 1;
        await frappe.method('frappe.client.insert', {
          doc: {
            doctype: 'Lesson Reference',
            parent: chapter.name,
            parenttype: 'Course Chapter',
            parentfield: 'lessons',
            lesson: lesson.name,
            idx,
          },
        });
      }
      log(`    章节「${stage.title}」：${stage.steps.length} 节课时`);
    }
  } catch (error) {
    if (createdNow) {
      log(`    中途失败，删掉整门课 ${courseName} …`);
      await frappe
        .method('lms.lms.api.delete_course', { course: courseName })
        .catch((cleanup) => log(`    ！ 删课也失败了，请到 Learning 手工删 ${courseName}：${cleanup.message}`));
    }
    throw error;
  }
  return courseName;
}

async function applyPlan(frappe, body, plan, snapshot, dir) {
  if (snapshot.missingFields.length > 0) {
    throw new Error(`Learning 缺 pa_ 字段（${snapshot.missingFields.join('、')}），先跑 learning-custom-fields.mjs --apply`);
  }
  const instructor =
    args.instructor || process.env.LEARNING_INSTRUCTOR || (await frappe.method('frappe.auth.get_logged_user', {}, 'GET'));
  if (!(await frappe.get('LMS Category', TUTORIAL_CATEGORY))) {
    await frappe.create('LMS Category', { category: TUTORIAL_CATEGORY });
    log(`建了分类「${TUTORIAL_CATEGORY}」`);
  }
  const result = { at: new Date().toISOString(), instructor, created: [], rebuilt: [], skipped: [], retired: [], failed: null };
  const save = () => writeFileSync(join(dir, 'apply-result.json'), JSON.stringify(result, null, 2));
  const done = new Set();
  for (const project of plan.projects) {
    if (project.existing && !args.rebuild) {
      result.skipped.push({ project: project.id, name: project.existing.name, complete: project.existingCheck.complete });
      done.add(project.id);
      log(`#${project.id} ${project.name}：已搬过（${project.existing.name}）${project.existingCheck.complete ? '，跳过' : '，不完整，加 --rebuild 原地重建'}`);
      continue;
    }
    log(`#${project.id} ${project.name}：${project.existing ? `原地重建 ${project.existing.name}` : '新建'} …`);
    try {
      const name = await writeProject(frappe, body, project, instructor);
      (project.existing ? result.rebuilt : result.created).push({ project: project.id, name, code: project.targetCode });
      done.add(project.id);
      log(`  √ ${name}`);
    } catch (error) {
      result.failed = { project: project.id, error: error.message };
      save();
      throw error;
    }
  }
  if (!args['keep-old']) {
    for (const { project, course } of coursesToRetire(plan)) {
      if (!done.has(project)) continue;
      await frappe.update('LMS Course', course.name, { published: 0 });
      result.retired.push({ name: course.name, title: course.title, project, publishedBefore: 1 });
      log(`旧课「${course.title}」(${course.name}) 已取消发布（以 NocoBase #${project} 为准；回退用 --restore 恢复）`);
    }
  }
  save();
  return result;
}

/** 真跑完回读一遍，阶段 / 步骤 / 材料 / 闸口数和 NocoBase 对 */
async function verify(frappe, plan) {
  const lessons = await frappe.list('Course Lesson', ['name', 'pa_step_key', 'pa_materials', 'pa_require_review']);
  const byKey = new Map(lessons.filter((lesson) => lesson.pa_step_key).map((lesson) => [lesson.pa_step_key, lesson]));
  const snapshot = await snapshotLearning(frappe);
  let ok = true;
  log('');
  log('核对（NocoBase → Learning）：');
  for (const project of plan.projects) {
    const course = snapshot.courses.find((item) => item.paCode === project.targetCode);
    const keys = course ? course.chapters.flatMap((chapter) => chapter.lessons.map((lesson) => lesson.stepKey).filter(Boolean)) : [];
    let materials = 0;
    let gates = 0;
    for (const key of keys) {
      const lesson = byKey.get(key);
      const parsed = typeof lesson?.pa_materials === 'string' ? JSON.parse(lesson.pa_materials || '[]') : (lesson?.pa_materials ?? []);
      materials += Array.isArray(parsed) ? parsed.length : 0;
      if (Number(lesson?.pa_require_review) === 1) gates += 1;
    }
    const counts = project.tree.counts;
    const same =
      course &&
      course.chapters.length === counts.stages &&
      keys.length === counts.steps &&
      materials === counts.materials &&
      gates === counts.gates;
    ok &&= Boolean(same);
    log(
      `  ${same ? '√' : '×'} #${project.id} ${project.name}：阶段 ${counts.stages}→${course?.chapters.length ?? 0}，步骤 ${counts.steps}→${keys.length}，` +
        `材料 ${counts.materials}→${materials}，闸口 ${counts.gates}→${gates}${course ? `（${course.name}）` : '（没找到课）'}`,
    );
  }
  return ok;
}

async function rollback(frappe) {
  const snapshot = await snapshotLearning(frappe);
  const migrated = snapshot.courses.filter((course) => course.paCode?.startsWith('nocobase-'));
  const restore = args.restore ? (JSON.parse(readFileSync(resolve(ROOT, args.restore), 'utf8')).retired ?? []) : [];
  log(`回退${APPLY ? '' : '（dry-run，加 --apply 才删）'}：迁移建的课 ${migrated.length} 门，要恢复发布的旧课 ${restore.length} 门`);
  for (const course of migrated) log(`  - 删 ${course.name}「${course.title}」（${course.paCode}）`);
  for (const item of restore) log(`  - 恢复发布 ${item.name}「${item.title}」`);
  if (!APPLY) return;
  for (const course of migrated) {
    await frappe.method('lms.lms.api.delete_course', { course: course.name });
  }
  for (const item of restore) {
    await frappe.update('LMS Course', item.name, { published: item.publishedBefore ? 1 : 0 });
  }
  log('回退完成');
}

async function main() {
  const frappe = frappeClient();
  if (args.rollback) {
    await rollback(frappe);
    return;
  }
  const body = await loadLessonBody();
  const dir = outDir();
  const selected = args.projects
    ? String(args.projects).split(',').map((item) => Number(item.trim())).filter((item) => Number.isInteger(item) && item > 0)
    : DEFAULT_PROJECTS;
  const exportData = args['from-export'] ? readExport(args['from-export']) : await exportNocobase(dir);
  log(`读 Learning ${frappe.siteUrl} 现状（课程、大纲、pa_ 字段）…`);
  const snapshot = await snapshotLearning(frappe);
  const plan = buildPlan(exportData, snapshot, selected, body.parseMaterialOptions);
  const meta = {
    at: new Date().toISOString(),
    apply: APPLY,
    nocobase: exportData.source,
    exportedAt: exportData.exportedAt,
    learning: frappe.siteUrl,
    missingFields: snapshot.missingFields,
  };
  writeFileSync(join(dir, 'report.md'), renderMarkdown(plan, meta));
  log('');
  log(renderConsole(plan, meta));
  log('');
  if (!APPLY) {
    const retire = coursesToRetire(plan);
    if (retire.length > 0 && !args['keep-old']) {
      log(`真跑时会取消发布的旧课：${retire.map(({ course }) => `「${course.title}」(${course.name})`).join('、')}`);
    }
    log(`dry-run 完，没写任何东西。报告：${join(dir, 'report.md')}`);
    log(`老板看过没问题后真跑：node server/scripts/migrate/nocobase-to-learning.mjs --apply --from-export ${dir}`);
    return;
  }
  await applyPlan(frappe, body, plan, snapshot, dir);
  const ok = await verify(frappe, plan);
  log('');
  log(`${ok ? '真跑完成，数量全对上' : '真跑完成，但有对不上的（见上面 ×）'}。记录：${join(dir, 'apply-result.json')}`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((error) => {
  console.error(`失败：${error.message}`);
  process.exit(1);
});
