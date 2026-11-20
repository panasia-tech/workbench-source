import { BadRequestException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  McpTools,
  McpTool,
  McpToolError,
  type Infer,
  type McpContext,
  type McpToolResult,
} from '@lark-apaas/fullstack-nestjs-core';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { WorkordersService } from '@server/modules/workorders/workorders.service';
import {
  DispatchInputException,
  WORK_ORDER_PRIORITIES,
  WORK_ORDER_PRIORITY_LABELS,
  shanghaiDateOf,
} from '@server/modules/workorders/dispatch-fields';
import {
  WORK_ORDER_BUSINESS_LINES,
  WORK_ORDER_BUSINESS_LINE_LABELS,
  WORK_ORDER_SUBJECT_KINDS,
  parseBusinessLine,
} from '@server/modules/workorders/workorder-fields';
import {
  minutesToHHmm,
  shanghaiNowMinutes,
} from '@server/modules/tasks/rhythm.util';
import { employeeBindings, workOrderCatalog } from '@server/database/schema';

const CatalogItemSchema = z.object({
  code: z.string().describe('工单种类编码，发单时作为 catalogCode 传入'),
  name: z.string().describe('种类名称'),
  orderType: z
    .string()
    .describe('工单类型：purchase=采购 / sales=销售 / special_delegation=特殊委派 / other=其他'),
  complexity: z.string().describe('复杂度：simple=简单 / medium=中等 / complex=复杂'),
  businessLine: z
    .string()
    .nullable()
    .describe('这类工单默认的业务线：used_goods=二手实物 / virtual_goods=虚拟商品 / tech_service=技术服务；null=没设'),
});

const EmployeeItemSchema = z.object({
  userId: z.string().describe('员工用户 ID，发单时作为 assigneeId 传入'),
  name: z.string().describe('员工姓名'),
});

export const WorkorderDispatchInfoOutput = {
  catalogs: z.array(CatalogItemSchema).describe('可用的工单种类目录'),
  employees: z.array(EmployeeItemSchema).describe('可指派的员工列表'),
  now: z
    .string()
    .describe(
      '当前时间（上海，HH:mm）。老板说「两小时内」这类相对时效时据此换算 deadlineTime；今天的活截止时刻必须晚于它',
    ),
  today: z
    .string()
    .describe('今天的日期（上海，YYYY-MM-DD）。老板说「明天」「周五前」这类跨天时效时据此换算 deadlineDate'),
};

export const WorkorderDispatchCreateInput = {
  title: z.string().min(1).describe('工单标题，一句话说清要做什么'),
  catalogCode: z
    .string()
    .min(1)
    .describe('工单种类编码，必须来自 workorder_dispatch_info 返回的 catalogs[].code'),
  assigneeId: z
    .string()
    .min(1)
    .describe('指派员工的用户 ID，必须来自 workorder_dispatch_info 返回的 employees[].userId'),
  deadlineTime: z
    .string()
    .regex(/^\s*\d{1,2}[:：]\d{2}\s*$/u, '截止时刻格式为 HH:mm（24 小时制，如 18:00）')
    .describe(
      '时效：截止时刻 HH:mm（24 小时制，如「下午 3 点前」传 15:00）。老板没说就先问「几点前要完成？」，不要自己编；系统会按约定拼进标题「HH:mm前」，title 里不要再写时刻',
    ),
  deadlineDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u, '截止日期格式为 YYYY-MM-DD')
    .optional()
    .describe(
      '截止日期 YYYY-MM-DD：跨天的活才传（如「周五下午 6 点前」传周五的日期 + deadlineTime 18:00），不传 = 今天；按 workorder_dispatch_info 返回的 today 换算',
    ),
  businessLine: z
    .enum(WORK_ORDER_BUSINESS_LINES)
    .optional()
    .describe(
      '业务线：used_goods=二手实物 / virtual_goods=虚拟商品 / tech_service=技术服务。不传用种类上设的；种类没设、老板也没说时问一句「算哪条业务线？」',
    ),
  subjects: z
    .array(
      z.object({
        kind: z
          .enum(WORK_ORDER_SUBJECT_KINDS)
          .describe('对象种类：product=商品 / peer=同行 / customer=客户 / study=学习对象 / erp_doc=ERP 单据 / other=其他'),
        name: z.string().min(1).describe('给人看的名字，如「iPhone 15 Pro 256G」「张三的店」'),
        ref: z.string().optional().describe('编号或链接，选填'),
      }),
    )
    .max(10)
    .optional()
    .describe('这单针对的对象（商品、同行、客户、学习对象等），老板提到就带上，最多 10 个'),
  priority: z
    .enum(WORK_ORDER_PRIORITIES)
    .optional()
    .describe(
      '优先级：urgent=紧急 / high=高 / medium=普通 / low=低。老板没提就不传，按普通发',
    ),
  remark: z.string().optional().describe('备注补充说明，选填'),
    saveAsDraft: z
      .boolean()
      .optional()
      .describe(
        'true=存入管理端草稿箱暂不发布（老板明确要求稍后再发时才用）；默认 false 直接发布：进管理端执行队列，并自动在员工任务页生成 Plane 任务卡',
      ),
};

export const WorkorderDispatchCreateOutput = {
  code: z.string().describe('工单编号，如 WO-0001'),
  title: z.string().describe('工单标题（已拼上截止时刻「HH:mm前」）'),
  priority: z.string().describe('优先级：紧急 / 高 / 普通 / 低'),
  dueAt: z.string().nullable().describe('截止（ISO 时间）；没给时效为 null'),
  businessLine: z.string().nullable().describe('业务线：二手实物 / 虚拟商品 / 技术服务；没设为 null'),
  status: z
    .string()
    .describe(
      '发放结果：pending=已发布进管理端执行队列，并自动在员工任务页生成 Plane 任务卡 / draft=已存入管理端草稿箱暂不发布',
    ),
};

function assertBoss(ctx: McpContext): string {
  const userId: string | undefined = ctx.user.userId;
  const roles: string[] = ctx.user.roles ?? [];
  if (!userId || !roles.includes('boss')) {
    throw new McpToolError(
      '发单仅限老板账号（boss 角色）操作。请让老板在豆包工作伙伴里以 boss 角色账号发起发单。',
      { code: 'BOSS_ROLE_REQUIRED' },
    );
  }
  return userId;
}

@McpTools({ prefix: 'workorder_' })
export class WorkorderDispatchMcpTools {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly workorders: WorkordersService,
  ) {}

  @McpTool({
    title: '查发单目录与员工',
    description:
      '老板发单前先调用：返回可用工单种类目录（catalogs[].code 发单时作 catalogCode，带默认业务线）、可指派员工列表（employees[].userId 发单时作 assigneeId）、当前时间 now 与今天日期 today。发单要素：标题、种类、负责人（指派员工）、时效（几点前；跨天的再加哪天）必填，业务线（二手实物/虚拟商品/技术服务，种类上设了就不用问）、关联对象、优先级（紧急/高/普通/低，默认普通）、备注选填。负责人或时效缺了要先问老板补上，不要自己编，例如「把 520 号停车位上的车送去途虎养车洗一下」没说几点前，就先问「几点前要完成？」。要素齐了再用 workorder_dispatch_create 提交。',
    inputSchema: {},
    outputSchema: WorkorderDispatchInfoOutput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  })
  async dispatch_info(
    _input: Record<string, never>,
    ctx: McpContext,
  ): Promise<McpToolResult<typeof WorkorderDispatchInfoOutput>> {
    assertBoss(ctx);
    const catalogs = await this.db
      .select({
        code: workOrderCatalog.code,
        name: workOrderCatalog.name,
        orderType: workOrderCatalog.orderType,
        complexity: workOrderCatalog.complexity,
        businessLine: workOrderCatalog.businessLine,
      })
      .from(workOrderCatalog)
      .where(eq(workOrderCatalog.enabled, true))
      .orderBy(asc(workOrderCatalog.sort), asc(workOrderCatalog.code));
    const employees = await this.db
      .select({
        userId: employeeBindings.miaodaUserId,
        name: employeeBindings.planeMemberName,
      })
      .from(employeeBindings)
      .orderBy(asc(employeeBindings.planeMemberName));
    return {
      structuredContent: {
        catalogs: catalogs.map((row) => ({
          ...row,
          businessLine: parseBusinessLine(row.businessLine),
        })),
        employees: employees.map((row: { userId: string; name: string | null }) => ({
          userId: row.userId,
          name: row.name ?? row.userId,
        })),
        now: minutesToHHmm(shanghaiNowMinutes(new Date())),
        today: shanghaiDateOf(new Date()),
      },
    };
  }

  @McpTool({
    title: '创建工单（发单）',
    description:
      '要素齐全、老板确认后提交发单：标题 title、种类 catalogCode、负责人 assigneeId、时效 deadlineTime（HH:mm）必填（种类与负责人取值先经 workorder_dispatch_info 校验）；跨天的活加截止日期 deadlineDate（YYYY-MM-DD，任务卡日期跟着它走）；业务线 businessLine、关联对象 subjects、优先级 priority（不传按普通）、备注 remark 选填。负责人或时效缺了不要调用、也不要自己编，先问老板补上（如「几点前要完成？」「哪天？」）。截止时刻会拼进标题「HH:mm前」，标题里不要再写时刻；直接发布时截止不能已经过了。saveAsDraft=true 存入管理端草稿箱暂不发布（老板明确要求稍后再发时才用），默认 false 直接发布：进管理端执行队列，并自动在员工任务页生成 Plane 任务卡（带优先级）。重复调用会重复建单，确认无误后再提交。',
    inputSchema: WorkorderDispatchCreateInput,
    outputSchema: WorkorderDispatchCreateOutput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  })
  async dispatch_create(
    input: Infer<typeof WorkorderDispatchCreateInput>,
    ctx: McpContext,
  ): Promise<McpToolResult<typeof WorkorderDispatchCreateOutput>> {
    const operatorId = assertBoss(ctx);
    const found = await this.db
      .select({ userId: employeeBindings.miaodaUserId })
      .from(employeeBindings)
      .where(eq(employeeBindings.miaodaUserId, input.assigneeId))
      .limit(1);
    if (found.length === 0) {
      throw new McpToolError(
        `指派员工不存在（assigneeId=${input.assigneeId}），请先调用 workorder_dispatch_info 获取有效员工列表`,
        { code: 'ASSIGNEE_NOT_FOUND' },
      );
    }
    try {
      const priority = input.priority ?? 'medium';
      const result = await this.workorders.createFromBoss(operatorId, {
        title: input.title,
        catalogCode: input.catalogCode,
        assigneeId: input.assigneeId,
        remark: input.remark,
        saveAsDraft: input.saveAsDraft ?? false,
        source: 'mcp',
        priority,
        deadlineTime: input.deadlineTime,
        deadlineDate: input.deadlineDate,
        businessLine: input.businessLine,
        subjects: input.subjects,
      });
      const line = result.workOrder.businessLine;
      return {
        structuredContent: {
          code: result.workOrder.code,
          title: result.workOrder.title,
          priority: WORK_ORDER_PRIORITY_LABELS[priority],
          dueAt: result.workOrder.dueAt,
          businessLine: line ? WORK_ORDER_BUSINESS_LINE_LABELS[line] : null,
          status: result.workOrder.status,
        },
      };
    } catch (error) {
      // 标题 / 时效不对：原样带 code 回去，豆包照提示问老板（DEADLINE_PASSED、TITLE_HAS_TIME 等）
      if (error instanceof DispatchInputException) {
        throw new McpToolError(error.message, { code: error.code });
      }
      if (error instanceof BadRequestException) {
        const message =
          typeof error.message === 'string' ? error.message : '工单种类或参数无效';
        throw new McpToolError(
          `${message}。请先调用 workorder_dispatch_info 确认种类编码有效`,
          { code: 'CATALOG_NOT_FOUND' },
        );
      }
      throw error;
    }
  }
}
