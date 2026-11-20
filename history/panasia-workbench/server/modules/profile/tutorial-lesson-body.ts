/**
 * 教程课时：pa_ 字段 ↔ 工作台步骤，以及按 pa_ 字段生成 Learning 课时正文（纯函数，没有依赖）。
 *
 * 工作台员工端只读 pa_ 字段；课时正文 content 是给在 Learning 里看的人用的，工作台每次保存课时都按
 * pa_ 字段重新生成（Learning 编辑器自己的 EditorJS 块：小标题、段落、列表、视频）。
 * 迁移脚本 server/scripts/migrate/nocobase-to-learning.mjs 也直接 import 这个文件生成正文，
 * 所以这里只用「类型可擦除」的写法（不能有 enum / namespace / 参数属性 / 运行时 import），Node 22.18+ 能直接跑。
 */

/** 材料输入类型（与 NocoBase 时期同 8 种；Learning 自带作业只有 5 种，所以材料定义存 pa_materials 不用作业） */
export const TUTORIAL_MATERIAL_INPUT_TYPES = [
  'text',
  'textarea',
  'number',
  'select',
  'date',
  'image',
  'video',
  'file',
] as const;

export type TutorialMaterialInputTypeName =
  (typeof TUTORIAL_MATERIAL_INPUT_TYPES)[number];

/** pa_materials 里的一项；数组顺序就是排序 */
export interface TutorialMaterialDef {
  key: string;
  label: string;
  inputType: TutorialMaterialInputTypeName;
  required: boolean;
  options: string[];
  helpText: string | null;
}

/** 课时上和步骤有关的 pa_ 字段（工作台读写的全部内容） */
export interface TutorialStepFields {
  guide: string | null;
  warnText: string | null;
  deliverNote: string | null;
  videoUrl: string | null;
  requireReview: boolean;
  requireConfirm: boolean;
  materials: TutorialMaterialDef[];
}

/** 步骤编号（pa_step_key）：短串，能直接放进网址和页面元素 id */
export const STEP_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** 豆包新增字段时的键名规矩（NocoBase 时期同款） */
export const MATERIAL_KEY_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm', 'mkv', 'avi'];

/** 新步骤编号：s + 36 进制毫秒 + 4 位随机，按时间大致有序、不会撞 */
export function generateStepKey(
  now: number = Date.now(),
  random: () => number = Math.random,
): string {
  const suffix = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0');
  return `s${now.toString(36)}${suffix}`;
}

function toInputType(raw: unknown): TutorialMaterialInputTypeName {
  const found = TUTORIAL_MATERIAL_INPUT_TYPES.find(
    (type: TutorialMaterialInputTypeName) => type === raw,
  );
  return found ?? 'text';
}

function optionalText(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

/** 下拉选项：数组原样，JSON 串解开，其余当一项 */
export function parseMaterialOptions(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((option: unknown) => String(option));
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((option: unknown) => String(option));
      }
    } catch {
      return [raw];
    }
  }
  return [];
}

/**
 * 解析课时的 pa_materials（Frappe 的 JSON 字段读出来可能是串也可能是数组）。
 * 不认识的项、空键名、重复键名直接丢掉；类型不认识的按 text。
 */
export function parseMaterials(raw: unknown): TutorialMaterialDef[] {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.trim() === '') return [];
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: TutorialMaterialDef[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const key = typeof record.key === 'string' ? record.key.trim() : '';
    if (key === '' || key.length > 64 || seen.has(key)) continue;
    seen.add(key);
    result.push({
      key,
      label: optionalText(record.label)?.trim() ?? key,
      inputType: toInputType(record.inputType),
      required: record.required === true,
      options: parseMaterialOptions(record.options),
      helpText: optionalText(record.helpText),
    });
  }
  return result;
}

/** 写回 pa_materials 用的 JSON 串（只留约定的六个键） */
export function serializeMaterials(materials: TutorialMaterialDef[]): string {
  return JSON.stringify(
    materials.map((material: TutorialMaterialDef) => ({
      key: material.key,
      label: material.label,
      inputType: material.inputType,
      required: material.required,
      options: material.options,
      helpText: material.helpText,
    })),
  );
}

/** Frappe Check 字段读出来是 0 / 1 */
export function readCheck(raw: unknown): boolean {
  return raw === 1 || raw === true || raw === '1';
}

/** 课时 pa_ 字段 → 步骤字段（缺的按空） */
export function readStepFields(lesson: Record<string, unknown>): TutorialStepFields {
  return {
    guide: optionalText(lesson.pa_guide),
    warnText: optionalText(lesson.pa_warn_text),
    deliverNote: optionalText(lesson.pa_deliver_note),
    videoUrl: optionalText(lesson.pa_video_url)?.trim() ?? null,
    requireReview: readCheck(lesson.pa_require_review),
    requireConfirm: readCheck(lesson.pa_require_confirm),
    materials: parseMaterials(lesson.pa_materials),
  };
}

/** 步骤字段 → 写课时用的 pa_ 字段 + 重新生成的正文 */
export function stepFieldsToLesson(
  fields: TutorialStepFields,
  now: number = Date.now(),
): Record<string, unknown> {
  return {
    pa_guide: fields.guide ?? '',
    pa_warn_text: fields.warnText ?? '',
    pa_deliver_note: fields.deliverNote ?? '',
    pa_video_url: fields.videoUrl ?? '',
    pa_require_review: fields.requireReview ? 1 : 0,
    pa_require_confirm: fields.requireConfirm ? 1 : 0,
    pa_materials: serializeMaterials(fields.materials),
    content: buildLessonContent(fields, now),
  };
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 转义后把 [文字](https://…) 和裸 https 链接变成 <a>（Learning 的段落允许 a 标签） */
export function linkify(text: string): string {
  const pattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()（）]+)/g;
  let out = '';
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    out += escapeHtml(text.slice(last, index));
    const label = match[1] ?? match[3] ?? '';
    const href = match[2] ?? match[3] ?? '';
    out += `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`;
    last = index + match[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

const MATERIAL_TYPE_LABELS: Record<TutorialMaterialInputTypeName, string> = {
  text: '文字',
  textarea: '多行文字',
  number: '数字',
  select: '选项',
  date: '日期',
  image: '图片',
  video: '视频',
  file: '文件',
};

interface EditorBlock {
  type: string;
  data: Record<string, unknown>;
}

/** 视频块：直链视频用 Learning 的 upload 块（自带播放器），别的地址给一个链接 */
export function videoBlock(url: string): EditorBlock {
  const path = url.split(/[?#]/)[0] ?? '';
  const ext = (path.split('.').pop() ?? '').toLowerCase();
  if (VIDEO_EXTENSIONS.includes(ext)) {
    return { type: 'upload', data: { file_url: url, file_type: ext } };
  }
  return { type: 'paragraph', data: { text: linkify(url) } };
}

/** 按 pa_ 字段生成课时正文（EditorJS JSON 串） */
export function buildLessonContent(
  fields: TutorialStepFields,
  now: number = Date.now(),
): string {
  const blocks: EditorBlock[] = [];
  const heading = (text: string): void => {
    blocks.push({ type: 'header', data: { text: escapeHtml(text), level: 4 } });
  };
  const paragraphs = (text: string): void => {
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      blocks.push({ type: 'paragraph', data: { text: linkify(line.trim()) } });
    }
  };
  if (fields.warnText) {
    heading('易错提醒');
    paragraphs(fields.warnText);
  }
  if (fields.guide) {
    heading('操作步骤');
    paragraphs(fields.guide);
  }
  if (fields.videoUrl) {
    heading('实操视频');
    blocks.push(videoBlock(fields.videoUrl));
  }
  if (fields.deliverNote) {
    heading('交付标准');
    paragraphs(fields.deliverNote);
  }
  if (fields.materials.length > 0) {
    heading('要提交的材料');
    blocks.push({
      type: 'list',
      data: {
        style: 'unordered',
        items: fields.materials.map((material: TutorialMaterialDef) => ({
          content: escapeHtml(
            `${material.label}（${MATERIAL_TYPE_LABELS[material.inputType]}${
              material.required ? '，必填' : ''
            }）${material.helpText ? `：${material.helpText}` : ''}`,
          ),
          items: [],
        })),
      },
    });
  }
  const gates: string[] = [];
  if (fields.requireReview) gates.push('这一步交了材料要等老板审核通过，才能进入下一步');
  if (fields.requireConfirm) gates.push('提交时要勾选「确认已完成」');
  if (gates.length > 0) {
    heading('闸口');
    paragraphs(gates.join('\n'));
  }
  return JSON.stringify({ time: now, blocks, version: '2.29.0' });
}

/** 课程简介（LMS Course 的 short_introduction / description 都必填，空着用标题兜底） */
export function courseIntro(title: string, description: string | null): {
  short_introduction: string;
  description: string;
} {
  const text = description && description.trim() !== '' ? description.trim() : title;
  return {
    short_introduction: text,
    description:
      `<p>${linkify(text)}</p>` +
      '<p>本课由泛亚工作台维护：交材料、审核都在工作台里做，正文也请到工作台后台或豆包里改，' +
      '在 Learning 里改的不会同步回工作台，下次保存还会被覆盖。</p>',
  };
}
