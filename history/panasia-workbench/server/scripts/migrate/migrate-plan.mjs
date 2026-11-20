// server/scripts/migrate/migrate-plan.mjs — 教程搬迁的「搬什么、和 Learning 现有课怎么对」：
// 由 nocobase-to-learning.mjs 调用，只做计算和出报告，不发请求。
import { bySortId, normTitle, titlesMatch } from './lib.mjs';

/** 10-19 老板定的 4 套：协助客户开设网店(2)、闲鱼矩阵开店(3)、教程制作工作法(5)、二手电脑上架(7) */
export const DEFAULT_PROJECTS = [2, 3, 5, 7];

/** 演示脚本 server/scripts/demo/lms-learning.mjs 在 hr 站点建的 5 门 + Learning 自带示例课 */
export const DEMO_TITLES = [
  '采购岗位入门',
  '商品验货基础',
  '扫地机器人验货教程',
  '采购议价进阶',
  '商品图片验收规范',
  'A guide to Frappe Learning',
];

const MATERIAL_TYPES = ['text', 'textarea', 'number', 'select', 'date', 'image', 'video', 'file'];

/** 迁移课的 pa_code：nocobase-<id>-<code>（重跑按它认，回退按 nocobase- 前缀删） */
export function courseCode(project) {
  const code = String(project.code ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `nocobase-${project.id}${code ? `-${code}` : ''}`;
}

/** 迁移课时的 pa_step_key：nb-<NocoBase 步骤 id>，全局唯一、重跑稳定 */
export function stepKey(step) {
  return `nb-${step.id}`;
}

function text(raw) {
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

/** Learning 章节 / 课时的文档名是「{####} {标题}」：Frappe 不许 < >（换成全角），name 列 140 字（超长只提醒） */
function safeTitle(raw, fallback, warnings, what) {
  const title = text(raw)?.trim() ?? fallback;
  const fixed = title.replace(/</g, '＜').replace(/>/g, '＞');
  if (fixed !== title) warnings.push(`${what}「${title}」里的 < > 换成了全角（Learning 文档名不允许）`);
  if (fixed.length > 120) warnings.push(`${what}「${fixed.slice(0, 20)}…」超过 120 字，真跑会失败，先在 NocoBase 里改短`);
  return fixed;
}

function isWbFiles(url) {
  return /^https:\/\/[^/]*panasia\.fun\/wb-files\//.test(url);
}

/** NocoBase 材料 → pa_materials 项；键名缺 / 重复、类型不认识的记一条提醒 */
export function toMaterialDefs(rows, parseOptions, warnings, stepTitle) {
  const seen = new Set();
  return [...rows].sort(bySortId).map((row, index) => {
    let key = text(row.material_key)?.trim() ?? `m${index + 1}`;
    if (!text(row.material_key)) warnings.push(`「${stepTitle}」第 ${index + 1} 项材料没有键名，用 ${key}`);
    while (seen.has(key)) {
      key = `${key}_${index + 1}`;
      warnings.push(`「${stepTitle}」材料键名重复，第 ${index + 1} 项改成 ${key}`);
    }
    seen.add(key);
    const inputType = MATERIAL_TYPES.includes(row.input_type) ? row.input_type : 'text';
    if (row.input_type && inputType !== row.input_type) {
      warnings.push(`「${stepTitle}」材料「${row.label}」类型 ${row.input_type} 不认识，按 text`);
    }
    return {
      key,
      label: text(row.label)?.trim() ?? key,
      inputType,
      required: row.required === true,
      options: parseOptions(row.options),
      helpText: text(row.help_text),
    };
  });
}

/** 一套 NocoBase 教程的树：阶段 → 步骤 → 材料，都按 sort、id 排 */
export function buildTree(tables, project, parseOptions) {
  const warnings = [];
  const stages = tables.tutorial_stages.filter((s) => s.project_id === project.id).sort(bySortId);
  const counts = { stages: stages.length, steps: 0, materials: 0, gates: 0, confirms: 0, videos: 0 };
  const videosOffWbFiles = [];
  const tree = stages.map((stage) => {
    const steps = tables.tutorial_steps.filter((s) => s.stage_id === stage.id).sort(bySortId);
    return {
      id: stage.id,
      title: safeTitle(stage.title, `阶段 ${stage.id}`, warnings, '阶段'),
      description: text(stage.description),
      durationNote: text(stage.duration_note),
      steps: steps.map((step) => {
        const title = safeTitle(step.title, `步骤 ${step.id}`, warnings, '步骤');
        const materials = toMaterialDefs(
          tables.tutorial_step_materials.filter((m) => m.step_id === step.id),
          parseOptions,
          warnings,
          title,
        );
        const videoUrl = text(step.video_url)?.trim() ?? null;
        counts.steps += 1;
        counts.materials += materials.length;
        if (step.require_review === true) counts.gates += 1;
        if (step.require_confirm === true) counts.confirms += 1;
        if (videoUrl) {
          counts.videos += 1;
          if (!isWbFiles(videoUrl)) videosOffWbFiles.push({ step: title, url: videoUrl });
        }
        return {
          id: step.id,
          key: stepKey(step),
          title,
          fields: {
            guide: text(step.guide),
            warnText: text(step.warn_text),
            deliverNote: text(step.deliver_note),
            videoUrl,
            requireReview: step.require_review === true,
            requireConfirm: step.require_confirm === true,
            materials,
          },
        };
      }),
    };
  });
  return { stages: tree, counts, warnings, videosOffWbFiles };
}

/** 两边标题对一遍：哪些步骤 Learning 没有、哪些课时 NocoBase 没有、重合率（按少的一边算） */
function diffTitles(stepTitles, lessonTitles) {
  const matchedLessons = new Set();
  const onlyNocobase = [];
  let common = 0;
  for (const title of stepTitles) {
    const hit = lessonTitles.findIndex((lesson, index) => !matchedLessons.has(index) && titlesMatch(title, lesson));
    if (hit >= 0) {
      matchedLessons.add(hit);
      common += 1;
    } else {
      onlyNocobase.push(title);
    }
  }
  const onlyLearning = lessonTitles.filter((_, index) => !matchedLessons.has(index));
  const base = Math.min(stepTitles.length, lessonTitles.length);
  return { common, ratio: base > 0 ? common / base : 0, onlyNocobase, onlyLearning };
}

function lessonTitlesOf(course) {
  return course.chapters.flatMap((chapter) => chapter.lessons.map((lesson) => lesson.title));
}

/** 已搬过的课和 NocoBase 对数：阶段、带步骤编号的课时都对上才算完整 */
function completeness(course, tree) {
  const lessons = course.chapters.flatMap((chapter) => chapter.lessons.filter((lesson) => lesson.stepKey));
  const keys = new Set(lessons.map((lesson) => lesson.stepKey));
  const expected = tree.stages.flatMap((stage) => stage.steps.map((step) => step.key));
  const missing = expected.filter((key) => !keys.has(key));
  return {
    complete: course.chapters.length === tree.stages.length && missing.length === 0 && lessons.length === expected.length,
    chapters: course.chapters.length,
    lessons: lessons.length,
    missing,
  };
}

export function buildPlan(exportData, snapshot, selectedIds, parseOptions) {
  const tables = exportData.tables;
  const tutorialCourses = snapshot.courses.filter((course) => course.paCode);
  const plainCourses = snapshot.courses.filter((course) => !course.paCode);
  const projects = [];
  const missingProjects = [];
  for (const id of selectedIds) {
    const project = tables.tutorial_projects.find((row) => row.id === id);
    if (!project) {
      missingProjects.push(id);
      continue;
    }
    const tree = buildTree(tables, project, parseOptions);
    const targetCode = courseCode(project);
    const existing = tutorialCourses.find((course) => course.paCode === targetCode) ?? null;
    const stepTitles = tree.stages.flatMap((stage) => stage.steps.map((step) => step.title));
    const candidates = plainCourses
      .map((course) => {
        const byTitle = titlesMatch(project.name, course.title);
        const diff = diffTitles(stepTitles, lessonTitlesOf(course));
        return { course, byTitle, diff };
      })
      .filter((item) => item.byTitle || item.diff.ratio > 0.5);
    projects.push({
      id: project.id,
      name: safeTitle(project.name, `教程 ${project.id}`, tree.warnings, '教程'),
      code: project.code ?? '',
      description: text(project.description),
      targetCode,
      tree,
      existing,
      existingCheck: existing ? completeness(existing, tree) : null,
      candidates,
    });
  }
  const selected = new Set(selectedIds);
  const otherProjects = tables.tutorial_projects
    .filter((project) => !selected.has(project.id))
    .map((project) => ({ project, counts: buildTree(tables, project, parseOptions).counts }));
  const demo = new Set(DEMO_TITLES.map(normTitle));
  const learningCourses = snapshot.courses.map((course) => {
    const hits = projects.filter((plan) => plan.candidates.some((item) => item.course.name === course.name && item.byTitle));
    let mark = '其他';
    let suggestion = '不动';
    if (course.paCode) {
      mark = '岗位教程';
      suggestion = course.paCode.startsWith('nocobase-') ? '迁移建的，重跑跳过' : '工作台建的，不动';
    } else if (hits.length > 0) {
      mark = `撞名（NocoBase #${hits.map((plan) => plan.id).join('、#')}）`;
      suggestion = course.published ? '以 NocoBase 为准：真跑时取消发布（不删）' : '以 NocoBase 为准：本来就没发布，不动';
    } else if (demo.has(normTitle(course.title))) {
      mark = '演示';
      suggestion = '建议取消发布（本脚本不动，老板定）';
    }
    return { course, mark, suggestion };
  });
  return {
    projects,
    missingProjects,
    otherProjects,
    learningCourses,
    testData: {
      cases: tables.tutorial_cases?.length ?? 0,
      submissions: tables.tutorial_step_submissions?.length ?? 0,
      admins: tables.tutorial_admins?.length ?? 0,
    },
  };
}

/** 真跑时要取消发布的旧课：标题撞名、不是教程课、现在是发布的 */
export function coursesToRetire(plan) {
  const seen = new Set();
  const result = [];
  for (const project of plan.projects) {
    for (const item of project.candidates) {
      if (!item.byTitle || !item.course.published || seen.has(item.course.name)) continue;
      seen.add(item.course.name);
      result.push({ project: project.id, course: item.course });
    }
  }
  return result;
}

function countsText(counts) {
  return `${counts.stages} 阶段 / ${counts.steps} 步 / ${counts.materials} 项材料 / ${counts.gates} 个审核闸口 / ${counts.confirms} 个确认勾选 / ${counts.videos} 个视频`;
}

function bullet(list, empty = '（无）') {
  return list.length > 0 ? list.map((item) => `  - ${item}`).join('\n') : `  - ${empty}`;
}

/** Markdown 报告（给老板看、留档） */
export function renderMarkdown(plan, meta) {
  const lines = [];
  const total = plan.projects.reduce(
    (sum, project) => {
      for (const key of Object.keys(sum)) sum[key] += project.tree.counts[key];
      return sum;
    },
    { stages: 0, steps: 0, materials: 0, gates: 0, confirms: 0, videos: 0 },
  );
  lines.push(`# 教程搬到 Learning · ${meta.apply ? '真跑记录' : 'dry-run 对照'}`);
  lines.push('');
  lines.push(`- 时间：${meta.at}`);
  lines.push(`- NocoBase：${meta.nocobase}（导出于 ${meta.exportedAt}）`);
  lines.push(`- Learning：${meta.learning}`);
  lines.push(`- pa_ 字段：${meta.missingFields.length === 0 ? '11 个都在' : `缺 ${meta.missingFields.join('、')}（先跑 learning-custom-fields.mjs --apply）`}`);
  lines.push('');
  lines.push('## 一、搬什么');
  lines.push('');
  lines.push(`共 ${plan.projects.length} 套：${countsText(total)}。撞名的「以 NocoBase 为准」：新建岗位教程课（分类「岗位教程」、不发布、关自助报名），Learning 里旧的同名课取消发布、不删。`);
  lines.push('');
  lines.push('| NocoBase | 教程 | 规模 | Learning 里 | 真跑会做 |');
  lines.push('|---|---|---|---|---|');
  for (const project of plan.projects) {
    const same = project.candidates.filter((item) => item.byTitle);
    let status;
    let action;
    if (project.existing) {
      status = `已搬过（${project.existing.name}）${project.existingCheck.complete ? '' : '，**不完整**'}`;
      action = project.existingCheck.complete ? '跳过' : '跳过；加 --rebuild 原地重建';
    } else {
      status = same.length > 0 ? `撞名：${same.map((item) => `「${item.course.title}」`).join('、')}` : '没有同名课';
      action = `新建（pa_code=${project.targetCode}）`;
    }
    lines.push(`| #${project.id} · ${project.code} | ${project.name} | ${countsText(project.tree.counts)} | ${status} | ${action} |`);
  }
  if (plan.missingProjects.length > 0) {
    lines.push('');
    lines.push(`**NocoBase 里找不到的项目：#${plan.missingProjects.join('、#')}**（核对 --projects）`);
  }
  for (const project of plan.projects) {
    lines.push('');
    lines.push(`## #${project.id} ${project.name}`);
    lines.push('');
    lines.push(`- 规模：${countsText(project.tree.counts)}`);
    for (const stage of project.tree.stages) {
      lines.push(`- 阶段「${stage.title}」${stage.durationNote ? `（${stage.durationNote}）` : ''}`);
      for (const step of stage.steps) {
        const flags = [
          step.fields.requireReview ? '审核' : null,
          step.fields.requireConfirm ? '确认' : null,
          step.fields.videoUrl ? '视频' : null,
          step.fields.materials.length > 0 ? `${step.fields.materials.length} 项材料` : null,
        ].filter(Boolean);
        lines.push(`  - ${step.title}${flags.length > 0 ? `（${flags.join('、')}）` : ''}`);
      }
    }
    if (project.tree.videosOffWbFiles.length > 0) {
      lines.push('- 视频不在 wb-files 上（原样照搬，要人工看一眼）：');
      lines.push(bullet(project.tree.videosOffWbFiles.map((item) => `${item.step}：${item.url}`)));
    }
    if (project.tree.warnings.length > 0) {
      lines.push('- 提醒（材料键名、标题）：');
      lines.push(bullet(project.tree.warnings));
    }
    for (const item of project.candidates) {
      const course = item.course;
      const lessonCount = course.chapters.reduce((sum, chapter) => sum + chapter.lessons.length, 0);
      lines.push('');
      lines.push(`### 对照：Learning「${course.title}」（${course.name}）`);
      lines.push('');
      lines.push(`- 为什么挑出来：${item.byTitle ? '疑似同名' : ''}${item.byTitle && item.diff.ratio > 0.5 ? '、' : ''}${item.diff.ratio > 0.5 ? `疑似同内容（标题重合 ${Math.round(item.diff.ratio * 100)}%）` : ''}`);
      lines.push(`- Learning：${course.published ? '已发布' : '未发布'}，${course.chapters.length} 章 ${lessonCount} 课时，讲师 ${course.instructors.join('、') || '—'}，${course.creation?.slice(0, 10) ?? '—'} 建，分类 ${course.category ?? '—'}`);
      lines.push(`- NocoBase：${project.tree.counts.stages} 阶段 ${project.tree.counts.steps} 步`);
      lines.push(`- 标题对上的 ${item.diff.common} 个；NocoBase 有、Learning 没有的 ${item.diff.onlyNocobase.length} 个：`);
      lines.push(bullet(item.diff.onlyNocobase));
      lines.push(`- Learning 有、NocoBase 没有的 ${item.diff.onlyLearning.length} 个（不会自动并入；要的话到工作台对应步骤补正文）：`);
      lines.push(bullet(item.diff.onlyLearning));
      lines.push('- 两边章节 / 阶段：');
      lines.push(`  - Learning：${course.chapters.map((chapter) => `${chapter.title}（${chapter.lessons.length}）`).join(' → ') || '（空）'}`);
      lines.push(`  - NocoBase：${project.tree.stages.map((stage) => `${stage.title}（${stage.steps.length}）`).join(' → ')}`);
      lines.push(`- 建议：${item.byTitle ? (course.published ? '以 NocoBase 为准新建岗位教程课；这门旧课取消发布（不删，随时能恢复）' : '以 NocoBase 为准新建岗位教程课；这门旧课本来没发布，不动') : '只是内容像，不动（要下线的话人工处理）'}`);
    }
  }
  lines.push('');
  lines.push('## 二、Learning 现有课程');
  lines.push('');
  lines.push('| name | 标题 | 分类 | 发布 | 章节/课时 | 讲师 | 创建 | 标记 | 建议 |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const { course, mark, suggestion } of plan.learningCourses) {
    const lessonCount = course.chapters.reduce((sum, chapter) => sum + chapter.lessons.length, 0);
    lines.push(`| ${course.name} | ${course.title} | ${course.category ?? '—'} | ${course.published ? '是' : '否'} | ${course.chapters.length}/${lessonCount} | ${course.instructors.join('、') || '—'} | ${course.creation?.slice(0, 10) ?? '—'} | ${mark} | ${suggestion} |`);
  }
  lines.push('');
  lines.push('## 三、不搬的');
  lines.push('');
  lines.push(`- NocoBase 案例 ${plan.testData.cases} 个、提交 ${plan.testData.submissions} 条、tutorial_admins ${plan.testData.admins} 条：测试数据，导出留档、不导入`);
  if (plan.otherProjects.length > 0) {
    lines.push('- NocoBase 里不在名单的教程（要搬加 --projects）：');
    lines.push(bullet(plan.otherProjects.map(({ project, counts }) => `#${project.id} ${project.name}（${project.code ?? '—'}）：${countsText(counts)}`)));
  }
  return `${lines.join('\n')}\n`;
}

/** 终端上的精简版 */
export function renderConsole(plan, meta) {
  const out = [];
  out.push(`NocoBase ${meta.nocobase} → Learning ${meta.learning}${meta.apply ? '（真跑）' : '（dry-run，只看不写）'}`);
  if (meta.missingFields.length > 0) out.push(`！ Learning 缺 pa_ 字段：${meta.missingFields.join('、')}`);
  out.push('');
  for (const project of plan.projects) {
    const head = project.existing
      ? `已搬过 → ${project.existing.name}${project.existingCheck.complete ? '，跳过' : `，不完整（缺 ${project.existingCheck.missing.length} 步），加 --rebuild 原地重建`}`
      : `新建 pa_code=${project.targetCode}`;
    out.push(`#${project.id} ${project.name}：${countsText(project.tree.counts)}；${head}`);
    for (const item of project.candidates) {
      const course = item.course;
      const lessonCount = course.chapters.reduce((sum, chapter) => sum + chapter.lessons.length, 0);
      out.push(`  对照 Learning「${course.title}」(${course.name}，${course.published ? '已发布' : '未发布'}，${course.chapters.length} 章 ${lessonCount} 课时)${item.byTitle ? ' 撞名' : ''}${item.diff.ratio > 0.5 ? ` 内容重合 ${Math.round(item.diff.ratio * 100)}%` : ''}`);
      out.push(`    标题对上 ${item.diff.common}；NocoBase 有 Learning 没有 ${item.diff.onlyNocobase.length}：${item.diff.onlyNocobase.slice(0, 6).join('｜') || '—'}${item.diff.onlyNocobase.length > 6 ? '…' : ''}`);
      out.push(`    Learning 有 NocoBase 没有 ${item.diff.onlyLearning.length}：${item.diff.onlyLearning.slice(0, 6).join('｜') || '—'}${item.diff.onlyLearning.length > 6 ? '…' : ''}`);
      out.push(`    处理：${item.byTitle ? (course.published ? '新建岗位教程课，这门取消发布（不删）' : '新建岗位教程课，这门本来没发布') : '只是内容像，不动'}`);
    }
    if (project.tree.videosOffWbFiles.length > 0) out.push(`  视频不在 wb-files：${project.tree.videosOffWbFiles.length} 个（见报告）`);
    if (project.tree.warnings.length > 0) out.push(`  提醒 ${project.tree.warnings.length} 条（材料键名、标题，见报告）`);
  }
  if (plan.missingProjects.length > 0) out.push(`！ NocoBase 里找不到 #${plan.missingProjects.join('、#')}`);
  const marks = plan.learningCourses.reduce((acc, { mark }) => {
    const key = mark.startsWith('撞名') ? '撞名' : mark;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  out.push('');
  out.push(`Learning 现有 ${plan.learningCourses.length} 门：${Object.entries(marks).map(([key, value]) => `${key} ${value}`).join('，')}`);
  out.push(`不搬：案例 ${plan.testData.cases}、提交 ${plan.testData.submissions}（测试数据，只留档）${plan.otherProjects.length > 0 ? `；名单外的 NocoBase 教程 ${plan.otherProjects.length} 套：${plan.otherProjects.map(({ project }) => `#${project.id} ${project.name}`).join('、')}` : ''}`);
  return out.join('\n');
}
