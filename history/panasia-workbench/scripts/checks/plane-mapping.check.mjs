/**
 * Plane 状态映射、「工时=」解析、发单时效/优先级的离线自检（不进构建、不连任何外部服务）。
 * 仓库里没有单测框架，用 Node 自带的 node:test 跑编译后的产物：
 *
 *   npm run build:server && node --test scripts/checks/plane-mapping.check.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const mapping = require('../../dist/server/modules/integration/plane-mapping.js');
const dispatch = require('../../dist/server/modules/workorders/dispatch-fields.js');

const { mapStatusByState, parseWorkHours, parseEvidenceSummary, parseDeadlineTime } = mapping;
const { normalizeClockTime, withInlineDeadline } = mapping;
const { resolveDispatchFields, priorityNote, priorityFromNote, DispatchInputException } = dispatch;

const state = (name, group, slug, sequence = 0) => ({ id: name, name, group, slug, sequence });

test('mapStatusByState：10-18 新加的五步状态（中文名，slug 为空）', () => {
  assert.equal(mapStatusByState(state('需求提交', 'backlog', '')), 'TODO');
  assert.equal(mapStatusByState(state('需求评审', 'unstarted', '')), 'TODO');
  assert.equal(mapStatusByState(state('工时报价', 'unstarted', '')), 'TODO');
  assert.equal(mapStatusByState(state('开发交付', 'started', '')), 'IN_PROGRESS');
  assert.equal(mapStatusByState(state('结果验收', 'started', '')), 'READY_FOR_REVIEW');
});

test('mapStatusByState：原有英文状态行为不变', () => {
  assert.equal(mapStatusByState(state('Backlog', 'backlog', 'backlog')), 'TODO');
  assert.equal(mapStatusByState(state('Todo', 'unstarted', 'todo')), 'TODO');
  assert.equal(mapStatusByState(state('In Progress', 'started', 'in-progress')), 'IN_PROGRESS');
  assert.equal(mapStatusByState(state('Done', 'completed', 'done')), 'DONE');
  assert.equal(mapStatusByState(state('Cancelled', 'cancelled', 'cancelled')), 'CANCELLED');
  assert.equal(mapStatusByState(state('Blocked', 'started', 'blocked')), 'BLOCKED');
  assert.equal(mapStatusByState(state('In Review', 'started', 'in-review')), 'READY_FOR_REVIEW');
  assert.equal(mapStatusByState(state('Waiting', 'started', 'waiting')), 'WAITING');
  assert.equal(mapStatusByState(state('Rejected', 'started', 'rejected')), 'REJECTED');
  // 调用方没带 name（老代码路径）照旧按 slug + 分组
  assert.equal(mapStatusByState({ group: 'started', slug: '' }), 'IN_PROGRESS');
  assert.equal(mapStatusByState({ group: 'started', slug: null }), 'IN_PROGRESS');
});

test('mapStatusByState：中文关键词与先后顺序', () => {
  assert.equal(mapStatusByState(state('阻塞', 'started', '')), 'BLOCKED');
  assert.equal(mapStatusByState(state('等待他人', 'started', '')), 'WAITING');
  assert.equal(mapStatusByState(state('待审核', 'started', '')), 'READY_FOR_REVIEW');
  assert.equal(mapStatusByState(state('驳回', 'started', '')), 'REJECTED');
  assert.equal(mapStatusByState(state('验收打回', 'started', '')), 'REJECTED');
  assert.equal(mapStatusByState(state('验收失败', 'started', '')), 'REJECTED');
  assert.equal(mapStatusByState(state('等待验收', 'started', '')), 'READY_FOR_REVIEW');
  // 英文 slug 优先于中文名
  assert.equal(mapStatusByState(state('阻塞', 'started', 'in-review')), 'READY_FOR_REVIEW');
  // completed / cancelled 组不看名字
  assert.equal(mapStatusByState(state('已验收', 'completed', '')), 'DONE');
  assert.equal(mapStatusByState(state('已驳回', 'cancelled', '')), 'CANCELLED');
});

test('moveToStatus 口径：同类取 sequence 最小，开发类项目「开始」「交凭证」的落点', () => {
  const devStates = [
    state('Backlog', 'backlog', 'backlog', 15000),
    state('需求提交', 'backlog', '', 17000),
    state('需求评审', 'unstarted', '', 20000),
    state('工时报价', 'unstarted', '', 22000),
    state('Todo', 'unstarted', 'todo', 25000),
    state('开发交付', 'started', '', 30000),
    state('结果验收', 'started', '', 32000),
    state('In Progress', 'started', 'in-progress', 35000),
    state('Done', 'completed', 'done', 45000),
    state('Cancelled', 'cancelled', 'cancelled', 55000),
  ];
  // 采购工作台、行情价另有的四个英文状态（只知道 In Review 是 85000，其余序号随便给）
  const purchaseStates = [
    ...devStates,
    state('Blocked', 'started', 'blocked', 65000),
    state('Waiting', 'started', 'waiting', 75000),
    state('In Review', 'started', 'in-review', 85000),
    state('Rejected', 'started', 'rejected', 95000),
  ];
  const pick = (states, status) =>
    states
      .filter((s) => mapStatusByState(s) === status)
      .sort((a, b) => a.sequence - b.sequence)[0]?.name ?? null;
  assert.equal(pick(devStates, 'IN_PROGRESS'), '开发交付');
  assert.equal(pick(devStates, 'READY_FOR_REVIEW'), '结果验收');
  assert.equal(pick(devStates, 'TODO'), 'Backlog');
  assert.equal(pick(devStates, 'DONE'), 'Done');
  assert.equal(pick(devStates, 'BLOCKED'), null);
  assert.equal(pick(purchaseStates, 'READY_FOR_REVIEW'), '结果验收');
  assert.equal(pick(purchaseStates, 'BLOCKED'), 'Blocked');
  assert.equal(pick(purchaseStates, 'WAITING'), 'Waiting');
  assert.equal(pick(purchaseStates, 'REJECTED'), 'Rejected');
});

test('parseWorkHours：描述里的「工时=」', () => {
  const cases = [
    ['<p>改发单工具</p><p>工时=6h</p>', 6, '6h'],
    ['<p>工时=1.5天</p>', 12, '1.5天'],
    ['<p>工时=90分钟</p>', 1.5, '90分钟'],
    ['<p>工时=100分钟</p>', 1.67, '100分钟'],
    ['<p>工时=2h30m</p>', 2.5, '2h30m'],
    ['<p>工时=1天4小时</p>', 12, '1天4小时'],
    ['<p>工时 = 6 小时</p>', 6, '6 小时'],
    ['<p>工时＝3H</p>', 3, '3H'],
    ['<p>工时=6</p>', 6, '6'],
    ['<p>工时=0.5d</p>', 4, '0.5d'],
    ['<p>工时=约6h</p>', 6, '约6h'],
    ['<p>工时=6h（含联调）</p>', 6, '6h（含联调）'],
    ['<p>&nbsp;工时=8小时</p>', 8, '8小时'],
    ['<p>工时=<strong>6h</strong></p>', 6, '6h'],
    ['<p>工时=两天</p>', null, '两天'],
    ['<p>工时=4-6h</p>', null, '4-6h'],
    ['<p>工时=4h-6h</p>', null, '4h-6h'],
    ['<p>工时=</p>', null, null],
    ['<p>没有工时这一行</p>', null, null],
    [null, null, null],
  ];
  for (const [html, hours, text] of cases) {
    assert.deepEqual(
      parseWorkHours(html),
      { workHours: hours, workHoursText: text },
      `输入 ${html}`,
    );
  }
  // 与「验收条件=」并存互不影响
  const both = '<p>验收条件=截图+录音</p><p>工时=0.5d</p>';
  assert.equal(parseEvidenceSummary(both), '截图、录音');
  assert.deepEqual(parseWorkHours(both), { workHours: 4, workHoursText: '0.5d' });
});

test('时效拼进标题：HH:mm前 约定与 parseDeadlineTime 互认', () => {
  assert.equal(normalizeClockTime('9:30'), '09:30');
  assert.equal(normalizeClockTime(' 18：00 '), '18:00');
  assert.equal(normalizeClockTime('24:00'), null);
  assert.equal(normalizeClockTime('7:5'), null);
  const car = withInlineDeadline('把 520 号停车位上的车送去途虎养车洗一下', '18:00');
  assert.deepEqual(car, { kind: 'ok', title: '把 520 号停车位上的车送去途虎养车洗一下 18:00前' });
  assert.equal(parseDeadlineTime(car.title), '18:00');
  assert.deepEqual(withInlineDeadline('确认报价 15:00前', '18:00'), { kind: 'ok', title: '确认报价 18:00前' });
  assert.deepEqual(withInlineDeadline('接 9:30 到站的客户', '18:00'), { kind: 'time_in_title', clash: '9:30' });
  assert.deepEqual(withInlineDeadline('18:00前', '18:00'), { kind: 'empty_title' });
});

test('resolveDispatchFields：优先级默认普通，时效校验', () => {
  const now = new Date('2026-10-18T06:00:00Z'); // 上海 14:00
  assert.deepEqual(
    resolveDispatchFields({ title: '把车送去洗', deadlineTime: '18:00' }, { checkPassed: true, now }),
    {
      title: '把车送去洗 18:00前',
      deadlineTime: '18:00',
      deadlineDate: '2026-10-18',
      dueAt: new Date('2026-10-18T10:00:00Z'),
      priority: 'medium',
    },
  );
  assert.deepEqual(
    resolveDispatchFields({ title: '把车送去洗', priority: 'urgent' }, { checkPassed: true, now }),
    { title: '把车送去洗', deadlineTime: null, deadlineDate: null, dueAt: null, priority: 'urgent' },
  );
  // 存草稿不判「已过」，发布时也不再判（草稿没地方改）
  assert.equal(
    resolveDispatchFields({ title: '对账', deadlineTime: '9:00' }, { checkPassed: false, now }).title,
    '对账 09:00前',
  );
  const codeOf = (fn) => {
    try {
      fn();
    } catch (error) {
      assert.ok(error instanceof DispatchInputException);
      assert.equal(error.getStatus(), 400);
      return error.code;
    }
    return null;
  };
  const make = (input) => () => resolveDispatchFields(input, { checkPassed: true, now });
  assert.equal(codeOf(make({ title: '对账', deadlineTime: '13:00' })), 'DEADLINE_PASSED');
  assert.equal(codeOf(make({ title: '对账', deadlineTime: '14:00' })), 'DEADLINE_PASSED');
  assert.equal(codeOf(make({ title: '对账', deadlineTime: '25:00' })), 'DEADLINE_INVALID');
  assert.equal(codeOf(make({ title: '接 9:30 的客户', deadlineTime: '18:00' })), 'TITLE_HAS_TIME');
  assert.equal(codeOf(make({ title: '   ', deadlineTime: '18:00' })), 'TITLE_INVALID');
  assert.equal(codeOf(make({ title: '长'.repeat(250), deadlineTime: '18:00' })), 'TITLE_INVALID');
});

test('草稿优先级记在事件备注里，发布时读回', () => {
  for (const priority of ['urgent', 'high', 'medium', 'low']) {
    assert.equal(priorityFromNote(`存入草稿箱（员工暂不可见） · ${priorityNote(priority)}`), priority);
  }
  assert.equal(priorityFromNote('存入草稿箱（员工暂不可见）'), null);
  assert.equal(priorityFromNote(null), null);
});
