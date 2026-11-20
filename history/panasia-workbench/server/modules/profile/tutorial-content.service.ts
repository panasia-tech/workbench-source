import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  FrappeService,
  frappeErrorMessage,
  frappeErrorType,
} from '../integration/frappe.service';
import { getLearningUrl } from '../integration/integration.config';
import {
  courseIntro,
  generateStepKey,
  readStepFields,
  stepFieldsToLesson,
  type TutorialStepFields,
} from './tutorial-lesson-body';

/**
 * 教程内容在 Learning（hr.panasia.fun 同站的 Frappe LMS）里的唯一读写入口（10-19 起，替代 NocoBase）。
 *
 * 对应关系：教程 = 课程 LMS Course（pa_code 有值才算工作台教程）→ 阶段 = 章节 Course Chapter →
 * 步骤 = 课时 Course Lesson（pa_step_key 是步骤编号，pa_* 存操作指引、闸口、要交的材料）。
 * 顺序按 Learning 大纲（get_course_outline）；章节、课时的 pa_ 字段不带条件整表拉下来在内存里对
 * （LMS 的表 list 带 filters 会失败，老坑），缓存 60 秒，工作台自己写过就清缓存。
 * 工作台服务账号要有 Moderator，否则课时读出来是空的而且不报错（Course Lesson 的读权限按报名 / 讲师过滤）。
 */

const CACHE_TTL_MS = 60_000;

/** 迁移和新建的教程课都放这个分类（只给人看；判断是不是教程只看 pa_code） */
export const TUTORIAL_CATEGORY = '岗位教程';

const COURSE_FIELDS = [
  'name',
  'title',
  'short_introduction',
  'published',
  'category',
  'modified',
  'pa_code',
];
const CHAPTER_FIELDS = ['name', 'title', 'course', 'pa_description', 'pa_duration_note'];
const LESSON_FIELDS = [
  'name',
  'title',
  'chapter',
  'course',
  'modified',
  'pa_step_key',
  'pa_guide',
  'pa_warn_text',
  'pa_deliver_note',
  'pa_video_url',
  'pa_require_review',
  'pa_require_confirm',
  'pa_materials',
];

interface CourseRow {
  name: string;
  title: string | null;
  short_introduction: string | null;
  published: number | null;
  category: string | null;
  modified: string | null;
  pa_code: string | null;
}

interface ChapterRow {
  name: string;
  title: string | null;
  course: string | null;
  pa_description: string | null;
  pa_duration_note: string | null;
}

interface LessonRow extends Record<string, unknown> {
  name: string;
  title: string | null;
  chapter: string | null;
  course: string | null;
  modified: string | null;
  pa_step_key: string | null;
}

/** get_course_outline 返回的章节（只取用到的） */
interface OutlineChapterRaw {
  name: string;
  title: string | null;
  lessons?: { name: string; title: string | null }[];
}

export interface TutorialCourse {
  name: string;
  title: string;
  code: string;
  intro: string | null;
  published: boolean;
  category: string | null;
  learningUrl: string;
}

export interface TutorialStep extends TutorialStepFields {
  /** pa_step_key */
  key: string;
  /** 课时 name */
  lesson: string;
  title: string;
  chapter: string;
  course: string;
  /** 章节内顺序，从 1 开始 */
  sort: number;
}

export interface TutorialStage {
  /** 章节 name */
  name: string;
  title: string;
  description: string | null;
  durationNote: string | null;
  /** 大纲顺序，从 1 开始 */
  sort: number;
  steps: TutorialStep[];
}

export interface TutorialOutline {
  course: TutorialCourse;
  stages: TutorialStage[];
  /** 按大纲顺序摊平的全部步骤 */
  steps: TutorialStep[];
}

export interface CreateStepInput extends TutorialStepFields {
  title: string;
}

/** Learning 连不上 / 读写失败：员工端提示「教程内容暂时读不到」，任务等其他功能照常；写失败带上 Frappe 的原话 */
export class TutorialContentUnavailableError extends ServiceUnavailableException {
  constructor(
    readonly detail: string,
    message = '教程内容暂时读不到（Learning 连不上），请稍后再试',
  ) {
    super(message);
  }
}

function writeFailed(detail: string): TutorialContentUnavailableError {
  return new TutorialContentUnavailableError(detail, `写 Learning 失败：${detail}，请稍后再试`);
}

/**
 * 章节、课时的文档名是「{####} {标题}」：Frappe 不许文档名里有 < >，name 列 140 字，
 * 所以标题先挡一道，给人话提示（不然报 Frappe 的 NameError / 字段太长）
 */
const MAX_TITLE_LENGTH = 120;
function assertTitle(title: string): void {
  if (/[<>]/.test(title)) {
    throw new BadRequestException('标题里不能有 < 或 >（Learning 的章节、课时名不允许），换成「＜」「＞」');
  }
  if (title.length > MAX_TITLE_LENGTH) {
    throw new BadRequestException(`标题太长了（最多 ${MAX_TITLE_LENGTH} 个字）`);
  }
}

function text(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

@Injectable()
export class TutorialContentService {
  private readonly logger = new Logger(TutorialContentService.name);
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private categoryReady = false;
  private warnedEmptyLessons = false;

  constructor(private readonly frappe: FrappeService) {}

  // ───────── 读 ─────────

  /** 全部教程课（pa_code 有值的课程）；读不到抛 TutorialContentUnavailableError */
  async listCourses(): Promise<TutorialCourse[]> {
    const rows = await this.loadCourses();
    return rows
      .filter((row: CourseRow) => text(row.pa_code) !== null)
      .map((row: CourseRow) => this.toCourse(row));
  }

  /** 教程课的 name 集合；读不到给空集合（「我的」页排除教程课用，不能因为它挡页面） */
  async tutorialCourseNames(): Promise<Set<string>> {
    try {
      const courses = await this.listCourses();
      return new Set(courses.map((course: TutorialCourse) => course.name));
    } catch {
      return new Set<string>();
    }
  }

  /** 读一门教程课的大纲；不是教程课（没有 pa_code / 不存在）返回 null，读不到抛错 */
  async getOutline(courseName: string): Promise<TutorialOutline | null> {
    const courses = await this.loadCourses();
    const row = courses.find((course: CourseRow) => course.name === courseName);
    if (!row || text(row.pa_code) === null) return null;
    const [rawChapters, chapters, lessons] = await Promise.all([
      this.loadCourseOutline(courseName),
      this.loadChapters(),
      this.loadLessons(),
    ]);
    const chapterByName = new Map<string, ChapterRow>(
      chapters.map((chapter: ChapterRow) => [chapter.name, chapter]),
    );
    const lessonByName = new Map<string, LessonRow>(
      lessons.map((lesson: LessonRow) => [lesson.name, lesson]),
    );
    const outlineLessonCount = rawChapters.reduce(
      (sum: number, chapter: OutlineChapterRaw) => sum + (chapter.lessons?.length ?? 0),
      0,
    );
    if (outlineLessonCount > 0 && lessons.length === 0 && !this.warnedEmptyLessons) {
      this.warnedEmptyLessons = true;
      this.logger.warn(
        `教程课 ${courseName} 大纲里有 ${outlineLessonCount} 节课时，课时表却一条都读不到：` +
          '工作台的 Frappe 服务账号多半没有 Moderator 角色',
      );
    }
    const stages: TutorialStage[] = rawChapters.map(
      (raw: OutlineChapterRaw, index: number): TutorialStage => {
        const chapter = chapterByName.get(raw.name);
        const steps: TutorialStep[] = [];
        for (const item of raw.lessons ?? []) {
          const lesson = lessonByName.get(item.name);
          const key = text(lesson?.pa_step_key);
          // 在 Learning 里另加的课时没有步骤编号，不算工作台的步骤
          if (!lesson || key === null) continue;
          steps.push({
            ...readStepFields(lesson),
            key,
            lesson: lesson.name,
            title: text(lesson.title) ?? text(item.title) ?? lesson.name,
            chapter: raw.name,
            course: courseName,
            sort: steps.length + 1,
          });
        }
        return {
          name: raw.name,
          title: text(raw.title) ?? text(chapter?.title) ?? raw.name,
          description: text(chapter?.pa_description),
          durationNote: text(chapter?.pa_duration_note),
          sort: index + 1,
          steps,
        };
      },
    );
    return {
      course: this.toCourse(row),
      stages,
      steps: stages.flatMap((stage: TutorialStage) => stage.steps),
    };
  }

  /** 读不到记一条警告、返回 null（列表页降级用） */
  async getOutlineSafe(courseName: string): Promise<TutorialOutline | null> {
    try {
      return await this.getOutline(courseName);
    } catch (error) {
      this.logger.warn(
        `读教程课 ${courseName} 失败，按读不到处理：${
          error instanceof TutorialContentUnavailableError ? error.detail : String(error)
        }`,
      );
      return null;
    }
  }

  /** 批量读大纲，单门失败只少那一门 */
  async getOutlines(courseNames: string[]): Promise<Map<string, TutorialOutline>> {
    const result = new Map<string, TutorialOutline>();
    const unique = [...new Set(courseNames)];
    const outlines = await Promise.all(
      unique.map((name: string) => this.getOutlineSafe(name)),
    );
    unique.forEach((name: string, index: number) => {
      const outline = outlines[index];
      if (outline) result.set(name, outline);
    });
    return result;
  }

  /** 按步骤编号找步骤（连同它所在的大纲）；不在任何教程课的大纲里返回 null */
  async findStep(
    stepKey: string,
  ): Promise<{ step: TutorialStep; outline: TutorialOutline } | null> {
    const lessons = await this.loadLessons();
    const lesson = lessons.find((row: LessonRow) => row.pa_step_key === stepKey);
    const course = text(lesson?.course);
    if (!course) return null;
    const outline = await this.getOutline(course);
    const step = outline?.steps.find((item: TutorialStep) => item.key === stepKey);
    return outline && step ? { step, outline } : null;
  }

  /** 按章节 name 找阶段；章节不属于教程课返回 null */
  async findStage(
    chapterName: string,
  ): Promise<{ stage: TutorialStage; outline: TutorialOutline } | null> {
    const chapters = await this.loadChapters();
    const course = text(
      chapters.find((row: ChapterRow) => row.name === chapterName)?.course,
    );
    if (!course) return null;
    const outline = await this.getOutline(course);
    const stage = outline?.stages.find((item: TutorialStage) => item.name === chapterName);
    return outline && stage ? { stage, outline } : null;
  }

  // ───────── 写 ─────────

  /** 建教程课：讲师 = 服务账号（必填，老坑）、分类岗位教程、不发布、关掉自助报名、写 pa_code */
  async createCourse(input: {
    title: string;
    description: string | null;
    code: string;
  }): Promise<TutorialCourse> {
    assertTitle(input.title);
    const [instructor, category] = await Promise.all([
      this.instructor(),
      this.ensureCategory(),
    ]);
    const created = await this.write('建课程', () =>
      this.frappe.create<CourseRow>('LMS Course', {
        title: input.title,
        ...courseIntro(input.title, input.description),
        instructors: [{ instructor }],
        ...(category ? { category } : {}),
        published: 0,
        disable_self_learning: 1,
        pa_code: input.code,
      }),
    );
    return this.toCourse({ ...created, pa_code: input.code });
  }

  /** 建章节（upsert_chapter 会自动挂进大纲）；position 是从 0 开始的插入位置，不传追加到末尾 */
  async createStage(
    courseName: string,
    input: { title: string; description: string | null; durationNote: string | null },
    position?: number,
  ): Promise<{ name: string; title: string }> {
    assertTitle(input.title);
    const chapter = await this.write('建章节', () =>
      this.frappe.callMethod<{ name: string; title: string }>(
        'lms.lms.api.upsert_chapter',
        { title: input.title, course: courseName, is_scorm_package: false },
      ),
    );
    if (input.description || input.durationNote) {
      await this.write('写章节说明', () =>
        this.frappe.update('Course Chapter', chapter.name, {
          pa_description: input.description ?? '',
          pa_duration_note: input.durationNote ?? '',
        }),
      );
    }
    if (position !== undefined) {
      await this.write('调整章节顺序', () =>
        this.frappe.callMethod('lms.lms.api.update_chapter_index', {
          chapter: chapter.name,
          course: courseName,
          idx: position,
        }),
      );
    }
    return { name: chapter.name, title: chapter.title ?? input.title };
  }

  /**
   * 建课时并挂进章节。带真标题直接建（不用 Learning 的 create_lesson，它先建「Untitled lesson」），
   * 写 pa_ 字段并生成正文；position 是从 0 开始的章节内位置，不传追加到末尾
   */
  async createStep(
    courseName: string,
    chapterName: string,
    input: CreateStepInput,
    options: { position?: number; stepKey?: string } = {},
  ): Promise<{ key: string; lesson: string }> {
    const key = options.stepKey ?? generateStepKey();
    const { title, ...fields } = input;
    assertTitle(title);
    const lesson = await this.write('建课时', () =>
      this.frappe.create<{ name: string }>('Course Lesson', {
        title,
        chapter: chapterName,
        course: courseName,
        pa_step_key: key,
        ...stepFieldsToLesson(fields),
      }),
    );
    try {
      const chapter = await this.frappe.getDoc<{ lessons?: unknown[] }>(
        'Course Chapter',
        chapterName,
      );
      const count = chapter?.lessons?.length ?? 0;
      // 同 Learning 前台：子表行经 frappe.client.insert 挂到章节上
      await this.frappe.callMethod('frappe.client.insert', {
        doc: {
          doctype: 'Lesson Reference',
          parent: chapterName,
          parenttype: 'Course Chapter',
          parentfield: 'lessons',
          lesson: lesson.name,
          idx: count + 1,
        },
      });
      if (options.position !== undefined && options.position < count) {
        await this.frappe.callMethod('lms.lms.api.update_lesson_index', {
          lesson: lesson.name,
          sourceChapter: chapterName,
          targetChapter: chapterName,
          idx: options.position,
        });
      }
    } catch (error) {
      // 没挂上大纲的课时删掉，免得留个孤儿占着步骤编号
      await this.frappe
        .callMethod('frappe.client.delete', { doctype: 'Course Lesson', name: lesson.name })
        .catch(() => undefined);
      throw writeFailed(`课时挂进章节失败：${frappeErrorMessage(error)}`);
    } finally {
      this.invalidate();
    }
    return { key, lesson: lesson.name };
  }

  /**
   * 改步骤：现读课时（拿最新的 pa_ 字段和 modified）→ mutate 算出要改的 → 带着 modified 写回并重新生成正文。
   * 别人在这中间改过，Frappe 拒绝写入，这里转成 409；mutate 返回 null 表示不用改
   */
  async updateStep(
    stepKey: string,
    mutate: (current: TutorialStep) => Partial<TutorialStepFields> | null,
  ): Promise<TutorialStep> {
    const found = await this.findStep(stepKey);
    if (!found) throw new NotFoundException('步骤不存在');
    const doc = await this.read(() =>
      this.frappe.getDoc<LessonRow>('Course Lesson', found.step.lesson),
    );
    if (!doc) throw new NotFoundException('步骤不存在');
    const current: TutorialStep = { ...found.step, ...readStepFields(doc) };
    const patch = mutate(current);
    if (patch === null) return current;
    const next: TutorialStep = { ...current, ...patch };
    try {
      await this.frappe.update('Course Lesson', found.step.lesson, {
        ...stepFieldsToLesson(next),
        modified: doc.modified,
      });
    } catch (error) {
      if (frappeErrorType(error) === 'TimestampMismatchError') {
        throw new ConflictException('这一步刚被别人改过，请重新读一遍再改');
      }
      throw writeFailed(`改课时失败：${frappeErrorMessage(error)}`);
    } finally {
      this.invalidate();
    }
    return next;
  }

  /** 整门课删掉（新建中途失败时回滚用） */
  async deleteCourse(courseName: string): Promise<void> {
    try {
      await this.frappe.callMethod('lms.lms.api.delete_course', { course: courseName });
    } finally {
      this.invalidate();
    }
  }

  invalidate(): void {
    this.cache.clear();
  }

  // ───────── 内部 ─────────

  private toCourse(row: CourseRow): TutorialCourse {
    return {
      name: row.name,
      title: text(row.title) ?? row.name,
      code: text(row.pa_code) ?? '',
      intro: text(row.short_introduction),
      published: row.published === 1,
      category: text(row.category),
      learningUrl: getLearningUrl(row.name),
    };
  }

  private loadCourses(): Promise<CourseRow[]> {
    return this.cached('courses', () =>
      this.frappe.list<CourseRow>('LMS Course', { fields: COURSE_FIELDS }),
    );
  }

  private loadChapters(): Promise<ChapterRow[]> {
    return this.cached('chapters', () =>
      this.frappe.list<ChapterRow>('Course Chapter', { fields: CHAPTER_FIELDS }),
    );
  }

  private loadLessons(): Promise<LessonRow[]> {
    return this.cached('lessons', () =>
      this.frappe.list<LessonRow>('Course Lesson', { fields: LESSON_FIELDS }),
    );
  }

  private loadCourseOutline(courseName: string): Promise<OutlineChapterRaw[]> {
    return this.cached(`outline:${courseName}`, async () => {
      const outline = await this.frappe.callMethod<OutlineChapterRaw[] | null>(
        'lms.lms.utils.get_course_outline',
        { course: courseName },
        'get',
      );
      return Array.isArray(outline) ? outline : [];
    });
  }

  /** 60 秒缓存 + 同一时刻同一份数据只发一个请求；失败不缓存，抛 TutorialContentUnavailableError */
  private async cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;
    const task = this.read(loader)
      .then((value: T) => {
        this.cache.set(key, { at: Date.now(), value });
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, task);
    return task;
  }

  private async read<T>(loader: () => Promise<T>): Promise<T> {
    try {
      return await loader();
    } catch (error) {
      const detail = frappeErrorMessage(error);
      this.logger.warn(
        `读 Learning 失败：${detail}（pa_ 字段没建的话先跑 server/scripts/migrate/learning-custom-fields.mjs）`,
      );
      throw new TutorialContentUnavailableError(detail);
    }
  }

  /** 写 Learning：失败转成 503（带 Frappe 的原话），成功失败都清缓存 */
  private async write<T>(action: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const detail = `${action}失败：${frappeErrorMessage(error)}`;
      this.logger.warn(`写 Learning ${detail}`);
      throw writeFailed(detail);
    } finally {
      this.invalidate();
    }
  }

  /** 讲师：LEARNING_INSTRUCTOR 优先，否则就是工作台服务账号自己（frappe.auth.get_logged_user） */
  private async instructor(): Promise<string> {
    const configured = process.env.LEARNING_INSTRUCTOR?.trim();
    if (configured) return configured;
    return this.cached('instructor', () =>
      this.frappe.callMethod<string>('frappe.auth.get_logged_user', {}, 'get'),
    );
  }

  /** 「岗位教程」分类没有就建；建不了就不填分类（分类只是给人看的） */
  private async ensureCategory(): Promise<string | null> {
    if (this.categoryReady) return TUTORIAL_CATEGORY;
    try {
      const existing = await this.frappe.getDoc('LMS Category', TUTORIAL_CATEGORY);
      if (!existing) {
        await this.frappe.create('LMS Category', { category: TUTORIAL_CATEGORY });
      }
      this.categoryReady = true;
      return TUTORIAL_CATEGORY;
    } catch (error) {
      this.logger.warn(`建「${TUTORIAL_CATEGORY}」分类失败，先不填分类：${frappeErrorMessage(error)}`);
      return null;
    }
  }
}
