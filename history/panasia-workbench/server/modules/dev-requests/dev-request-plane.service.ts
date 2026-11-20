import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AxiosError } from 'axios';
import { PlaneService } from '../integration/plane.service';
import { isDevProjectStates, type PlaneStateLike } from './dev-request-stage';

export interface PlaneProjectRaw {
  id: string;
  name: string;
  identifier: string;
}

export interface PlaneStateRaw extends PlaneStateLike {
  slug: string;
  sequence: number;
}

export interface PlaneIssueRaw {
  id: string;
  name: string;
  project?: string;
  state: string;
  assignees?: string[];
  description_html: string | null;
  sequence_id: number | null;
  updated_at?: string;
}

interface PlaneUserRaw {
  id: string;
}

interface PlaneIssuePage {
  results?: PlaneIssueRaw[];
  next_page_results?: boolean;
  next_cursor?: string | null;
}

/** Plane 的项目、任务 ID 都是 UUID：拼进路径前先校验（防 ?、#、../ 改写请求路径） */
export const PLANE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 一个项目最多翻几页任务（每页 Plane 默认 100 条），防异常数据死循环 */
const MAX_ISSUE_PAGES = 20;

/**
 * Plane 出错翻成人话：Plane 拒了（4xx）→ 400 带原因；连不上、5xx → 503。
 * 已经是 HTTP 异常的（如 PlaneService 的限流 503）原样抛
 */
export function toPlaneHttpError(error: unknown): HttpException {
  if (error instanceof HttpException) return error;
  if (error instanceof AxiosError) {
    const status = error.response?.status ?? 0;
    if (status >= 400 && status < 500) {
      const data = error.response?.data as Record<string, unknown> | string | undefined;
      const detail =
        typeof data === 'string'
          ? data
          : data && typeof data === 'object'
            ? String(data.error ?? data.detail ?? JSON.stringify(data))
            : '';
      return new BadRequestException(
        `Plane 拒绝了这次操作（${status}）${detail ? `：${detail.slice(0, 200)}` : ''}`,
      );
    }
  }
  return new ServiceUnavailableException('Plane 暂时连不上，请稍后再试');
}

/**
 * 开发需求读写 Plane 的唯一入口：开发类项目（五步状态都在）、项目成员、任务实读 / 建 / 改 / 删、评论。
 * 状态走 PlaneService 的 5 分钟缓存；判环节的任务一律实读（不走缓存），列表用 15 秒缓存的整项目任务。
 * 出错一律翻成 400 / 503（toPlaneHttpError），不抛 500。
 */
@Injectable()
export class DevRequestPlaneService {
  private readonly logger = new Logger(DevRequestPlaneService.name);

  constructor(private readonly plane: PlaneService) {}

  private projectPath(projectId: string): string {
    return `${this.plane.workspacePath}/projects/${projectId}`;
  }

  issuePath(projectId: string, issueId: string): string {
    return `${this.projectPath(projectId)}/issues/${issueId}/`;
  }

  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw toPlaneHttpError(error);
    }
  }

  async listProjects(): Promise<PlaneProjectRaw[]> {
    return this.guard(() => this.plane.listProjects<PlaneProjectRaw>());
  }

  async loadStates(projectId: string): Promise<PlaneStateRaw[]> {
    return this.guard(async () => {
      const res = await this.plane.cachedGet<{ results?: PlaneStateRaw[] }>(
        `${this.projectPath(projectId)}/states/`,
      );
      return res.results ?? [];
    });
  }

  /** 开发类项目：五步状态名都在的项目（动态判断，不写死名单） */
  async devProjects(): Promise<PlaneProjectRaw[]> {
    const projects = await this.listProjects();
    // 并发由 PlaneService 自己限流（同时最多 3 个请求）
    const checked = await Promise.all(
      projects.map(async (project: PlaneProjectRaw): Promise<boolean> => {
        try {
          return isDevProjectStates(await this.loadStates(project.id));
        } catch (error) {
          this.logger.warn(
            `读项目「${project.name}」的状态失败，先不列入开发类项目：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return false;
        }
      }),
    );
    return projects.filter((_: PlaneProjectRaw, index: number) => checked[index]);
  }

  /**
   * 项目成员（Plane 成员 ID）。Plane 没有这个接口（老版本 404 / 405）时返回 null，
   * 调用方退回「绑定了员工的人都能选」，建任务后再核对负责人有没有被 Plane 去掉
   */
  async projectMemberIds(projectId: string): Promise<Set<string> | null> {
    try {
      const res = await this.plane.cachedGet<
        PlaneUserRaw[] | { results?: PlaneUserRaw[] }
      >(`${this.projectPath(projectId)}/members/`, 60_000);
      const list = Array.isArray(res) ? res : (res.results ?? []);
      return new Set(list.map((user: PlaneUserRaw) => user.id));
    } catch (error) {
      const status =
        error instanceof AxiosError ? error.response?.status : undefined;
      if (status === 404 || status === 405) return null;
      throw toPlaneHttpError(error);
    }
  }

  /** 实读一条任务（判环节用，不走缓存）；不存在返回 null */
  async getIssueFresh(
    projectId: string,
    issueId: string,
  ): Promise<PlaneIssueRaw | null> {
    if (!PLANE_ID_RE.test(projectId) || !PLANE_ID_RE.test(issueId)) return null;
    return this.guard(() =>
      this.plane.getOptional<PlaneIssueRaw>(this.issuePath(projectId, issueId)),
    );
  }

  /** 整项目任务（15 秒缓存，写过 Plane 会清缓存），列表页一次拿全各条的状态 */
  async listIssues(projectId: string): Promise<PlaneIssueRaw[]> {
    return this.guard(async () => {
      const base = `${this.projectPath(projectId)}/issues/`;
      const all: PlaneIssueRaw[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_ISSUE_PAGES; page += 1) {
        const res: PlaneIssuePage = await this.plane.cachedGet<PlaneIssuePage>(
          cursor ? `${base}?cursor=${encodeURIComponent(cursor)}` : base,
          15_000,
        );
        all.push(...(res.results ?? []));
        if (res.next_page_results !== true || !res.next_cursor) break;
        cursor = res.next_cursor;
      }
      return all;
    });
  }

  /** 列表里没有的（超出翻页、刚建）单取一次，15 秒缓存 */
  async getIssueCached(
    projectId: string,
    issueId: string,
  ): Promise<PlaneIssueRaw | null> {
    if (!PLANE_ID_RE.test(projectId) || !PLANE_ID_RE.test(issueId)) return null;
    return this.guard(() =>
      this.plane.getOptionalCached<PlaneIssueRaw>(this.issuePath(projectId, issueId)),
    );
  }

  async createIssue(
    projectId: string,
    payload: Record<string, unknown>,
  ): Promise<PlaneIssueRaw> {
    return this.guard(() =>
      this.plane.post<PlaneIssueRaw>(`${this.projectPath(projectId)}/issues/`, payload),
    );
  }

  async patchIssue(
    projectId: string,
    issueId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.guard(() => this.plane.patch(this.issuePath(projectId, issueId), payload));
  }

  async deleteIssue(projectId: string, issueId: string): Promise<void> {
    await this.guard(() => this.plane.delete(this.issuePath(projectId, issueId)));
  }

  async postComment(
    projectId: string,
    issueId: string,
    commentHtml: string,
  ): Promise<void> {
    await this.guard(() =>
      this.plane.post(`${this.issuePath(projectId, issueId)}comments/`, {
        comment_html: commentHtml,
      }),
    );
  }
}
