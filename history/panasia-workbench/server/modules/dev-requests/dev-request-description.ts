/**
 * 开发需求写进 Plane 描述的那几行（「键=值」一行一段，照「验收条件=」「工时=」的写法），
 * 让只看 Plane 的人也知道发布人、报价这些要紧事。纯函数，离线自检见 scripts/checks/dev-request.check.mjs。
 *
 * 只动这几行：报价、验收时按行替换 / 追加，描述正文（含在 Plane 里直接改的）原样保留；
 * 只有发布人「已补充」时按他填的内容重写正文。价格绝不写进标题（标题里的「+N元」会被当成委派奖励）。
 */
import { stripHtml } from '../integration/plane-mapping';

export const MANAGED_KEYS = [
  '验收条件',
  '发布人',
  '开发',
  '工时',
  '报价',
  '承诺交付',
  '验收金额',
] as const;

export type ManagedKey = (typeof MANAGED_KEYS)[number];

const MANAGED_LINE_RE = new RegExp(
  `^(${MANAGED_KEYS.join('|')})\\s*[=＝]\\s*(.*)$`,
  'u',
);

/** 行内标签（加粗、高亮等）：去掉再拆行，免得「工时=<strong>6h</strong>」被拆成两行（同 parseWorkHours） */
const INLINE_TAG_RE =
  /<\/?(?:strong|b|em|i|u|s|span|code|mark|a)(?:\s[^>]*)?>/giu;

const PARAGRAPH_RE = /<p\b[^>]*>([\s\S]*?)<\/p>/giu;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

function paragraphText(innerHtml: string): string {
  return decodeEntities(
    stripHtml(innerHtml.replace(INLINE_TAG_RE, '')).replace(/\n+/g, ' '),
  ).trim();
}

function managedKeyOf(text: string): ManagedKey | null {
  const match = MANAGED_LINE_RE.exec(text);
  return match ? (match[1] as ManagedKey) : null;
}

/** 多行文本压成一行（「验收条件=」这类必须在同一段里） */
export function singleLine(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line: string) => line.trim())
    .filter((line: string) => line !== '')
    .join('；');
}

function lineHtml(key: ManagedKey, value: string): string {
  return `<p>${key}=${escapeHtml(singleLine(value))}</p>`;
}

/** 发布 / 已补充：正文按行成段，后面跟这几行 */
export function buildDescriptionHtml(
  body: string,
  lines: Array<[ManagedKey, string]>,
): string {
  const bodyHtml = body
    .split(/\r?\n/u)
    .map((line: string) => line.trim())
    .filter((line: string) => line !== '')
    .map((line: string) => `<p>${escapeHtml(line)}</p>`)
    .join('');
  return (
    bodyHtml +
    lines.map(([key, value]: [ManagedKey, string]) => lineHtml(key, value)).join('')
  );
}

/**
 * 按行替换 / 追加 / 删掉这几行：值为 null 删掉那一段，没有的追加在最后；
 * 同一个键出现多次只留第一段。其余内容原样保留
 */
export function upsertManagedLines(
  html: string | null,
  updates: Partial<Record<ManagedKey, string | null>>,
): string {
  const keys = new Set(Object.keys(updates) as ManagedKey[]);
  const seen = new Set<ManagedKey>();
  const replaced = (html ?? '').replace(
    PARAGRAPH_RE,
    (whole: string, inner: string): string => {
      const key = managedKeyOf(paragraphText(inner));
      if (key === null || !keys.has(key)) return whole;
      if (seen.has(key)) return '';
      seen.add(key);
      const value = updates[key];
      return value === null || value === undefined ? '' : lineHtml(key, value);
    },
  );
  let appended = replaced;
  for (const key of MANAGED_KEYS) {
    if (!keys.has(key) || seen.has(key)) continue;
    const value = updates[key];
    if (value !== null && value !== undefined) appended += lineHtml(key, value);
  }
  return appended;
}

/** 描述拆成正文（去掉这几行）和验收条件，给详情页显示、给「已补充」表单预填 */
export function splitDescription(html: string | null): {
  body: string;
  acceptance: string | null;
} {
  const text = decodeEntities(stripHtml((html ?? '').replace(INLINE_TAG_RE, '')));
  const bodyLines: string[] = [];
  let acceptance: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const match = MANAGED_LINE_RE.exec(line);
    if (!match) {
      bodyLines.push(line);
      continue;
    }
    if (match[1] === '验收条件' && acceptance === null) {
      acceptance = match[2].trim() || null;
    }
  }
  return { body: bodyLines.join('\n'), acceptance };
}
