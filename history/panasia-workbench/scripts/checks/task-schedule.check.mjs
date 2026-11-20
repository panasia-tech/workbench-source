/**
 * 定时单 MCP 工具（schedule_*）离线自检：真的任务模板服务 + 内存假库，假的员工 / 项目解析。
 * 钉住：建了能查到、改完回读是库里的新值、停用不删、各种错回明确的错误码、只有老板能用。
 *
 *   npm run build:server && node --test scripts/checks/task-schedule.check.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { TaskScheduleMcpTools } = require('../../dist/server/mcp/tools/task-schedule.tools.js');
const { TaskTemplateService } = require('../../dist/server/modules/tasks/task-template.service.js');

/** drizzle eq(col, value) 生成的 SQL 里找出那个参数值（只为这个测试） */
function eqValue(cond) {
  const chunk = (cond?.queryChunks ?? []).find(
    (c) => c && typeof c === 'object' && 'value' in c && 'encoder' in c,
  );
  return chunk?.value;
}

/** 任务模板服务用到的那几种 drizzle 链式写法，按 id 存在内存里 */
function fakeDb() {
  const rows = new Map();
  let seq = 0;
  return {
    rows,
    select: () => ({
      from: () => {
        const all = () => [...rows.values()].map((r) => ({ ...r }));
        const p = Promise.resolve(all());
        p.where = () => Promise.resolve(all());
        return p;
      },
    }),
    insert: () => ({
      values: (v) => ({
        returning: async () => {
          seq += 1;
          const row = { id: `tpl-${seq}`, sort: seq, createdAt: new Date(), updatedAt: new Date(), ...v };
          rows.set(row.id, row);
          return [{ ...row }];
        },
      }),
    }),
    update: () => ({
      set: (patch) => ({
        where: (cond) => ({
          returning: async () => {
            const id = eqValue(cond);
            const row = rows.get(id);
            if (!row) return [];
            Object.assign(row, patch);
            return [{ ...row }];
          },
        }),
      }),
    }),
    delete: () => ({
      where: (cond) => ({
        returning: async () => {
          const id = eqValue(cond);
          return rows.delete(id) ? [{ id }] : [];
        },
      }),
    }),
  };
}

const PROJECTS = [
  { projectId: 'p-routine', name: '日常执行' },
  { projectId: 'p-clean', name: '保洁' },
];
const EMPLOYEES = [{ userId: 'u-1', planeMemberId: 'm-1', planeMemberName: '小王' }];

function fakeDelegate() {
  const { BadRequestException } = require('@nestjs/common');
  return {
    async resolveProject(projectId) {
      if (!projectId) return PROJECTS[0];
      const hit = PROJECTS.find((p) => p.projectId === projectId);
      if (!hit) throw new BadRequestException('所属项目不存在：请从 delegate_info 返回的 projects 里选择');
      return hit;
    },
    async resolveAssignee(userId) {
      const hit = EMPLOYEES.find((e) => e.userId === userId);
      if (!hit) throw new BadRequestException('指派员工不存在：请先调用 delegate_info 获取有效员工列表');
      return hit;
    },
    async memberNames() {
      return new Map(EMPLOYEES.map((e) => [e.planeMemberId, e.planeMemberName]));
    },
  };
}

const BOSS = { user: { userId: 'boss-1', roles: ['boss'] } };
const STAFF = { user: { userId: 'u-1', roles: [] } };

function setup() {
  const db = fakeDb();
  const templates = new TaskTemplateService(db, {}, {});
  const tools = new TaskScheduleMcpTools(templates, fakeDelegate());
  return { db, tools };
}

test('建定时单 → 查得到；周期、项目、指派都按传的来', async () => {
  const { tools } = setup();
  const res = await tools.create(
    { title: '周一周四洗车', schedule: { kind: 'weekly', weekdays: [4, 1] }, assigneeId: 'u-1', projectId: 'p-clean', description: '带洗车卡' },
    BOSS,
  );
  const item = res.structuredContent.item;
  assert.equal(item.title, '周一周四洗车');
  assert.deepEqual(item.schedule, { kind: 'weekly', weekdays: [1, 4] });
  assert.equal(item.scheduleLabel, '每周周一、周四');
  assert.equal(item.projectName, '保洁');
  assert.equal(item.assigneeName, '小王');
  assert.equal(item.enabled, true);
  const list = (await tools.list({}, BOSS)).structuredContent;
  assert.deepEqual(list.items.map((x) => x.id), [item.id]);
  assert.match(list.autoGenerateNote, /自动生成/);
});

test('改定时单：只改传了的字段，回读的是库里的新值；enabled=false 是停用不是删', async () => {
  const { tools, db } = setup();
  const { item } = (await tools.create({ title: '每天保洁', schedule: { kind: 'every_day' } }, BOSS)).structuredContent;
  assert.equal(db.rows.get(item.id).templateType, 'daily');
  const upd = (await tools.update({ id: item.id, schedule: { kind: 'workdays' }, assigneeId: 'u-1' }, BOSS)).structuredContent.item;
  assert.equal(upd.scheduleLabel, '工作日（周一至周五）');
  assert.equal(upd.assigneeName, '小王');
  assert.equal(upd.title, '每天保洁');
  assert.equal(db.rows.get(item.id).templateType, 'scheduled');
  const off = (await tools.update({ id: item.id, enabled: false }, BOSS)).structuredContent.item;
  assert.equal(off.enabled, false);
  assert.ok(db.rows.has(item.id), '停用不删');
  const cleared = (await tools.update({ id: item.id, assigneeId: null }, BOSS)).structuredContent.item;
  assert.equal(cleared.assigneeName, null);
});

test('出错回明确的错误码，不建半截单', async () => {
  const { tools, db } = setup();
  await assert.rejects(
    tools.create({ title: '每周洗车', schedule: { kind: 'weekly' } }, BOSS),
    (e) => e.code === 'SCHEDULE_INVALID_INPUT' && /每周几/.test(e.message),
  );
  await assert.rejects(
    tools.create({ title: 'x', schedule: { kind: 'every_day' }, assigneeId: 'nobody' }, BOSS),
    (e) => e.code === 'SCHEDULE_INVALID_INPUT' && /指派员工不存在/.test(e.message),
  );
  await assert.rejects(
    tools.create({ title: 'x', schedule: { kind: 'every_day' }, projectId: 'p-x' }, BOSS),
    (e) => e.code === 'SCHEDULE_INVALID_INPUT' && /所属项目不存在/.test(e.message),
  );
  assert.equal(db.rows.size, 0);
  await assert.rejects(
    tools.update({ id: 'no-such', enabled: false }, BOSS),
    (e) => e.code === 'SCHEDULE_NOT_FOUND',
  );
});

test('只有老板能用', async () => {
  const { tools } = setup();
  await assert.rejects(tools.list({}, STAFF), (e) => e.code === 'BOSS_ROLE_REQUIRED');
  await assert.rejects(
    tools.create({ title: 'x', schedule: { kind: 'every_day' } }, STAFF),
    (e) => e.code === 'BOSS_ROLE_REQUIRED',
  );
});
