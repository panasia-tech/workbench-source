/**
 * 开发需求的纯逻辑离线自检（不进构建、不连任何外部服务）：环节判断、身份 / 环节 / 流程数据三道闸、
 * 和 Plane 对不上时的提示、描述里那几行的增删改、金额换算。跑编译后的产物：
 *
 *   npm run build:server && node --test scripts/checks/dev-request.check.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const stage = require('../../dist/server/modules/dev-requests/dev-request-stage.js');
const desc = require('../../dist/server/modules/dev-requests/dev-request-description.js');

const {
  isDevProjectStates,
  stageOfState,
  allowedActionsOf,
  rolePermits,
  flowWarningOf,
  preconditionError,
  findGroupState,
  toCents,
  centsToNumeric,
} = stage;
const { buildDescriptionHtml, upsertManagedLines, splitDescription, singleLine } = desc;

const st = (name, group, slug = '', sequence = 0) => ({ id: name, name, group, slug, sequence });
const DEV_STATES = [
  st('Backlog', 'backlog', 'backlog', 15000),
  st('需求提交', 'backlog', '', 17000),
  st('需求评审', 'unstarted', '', 20000),
  st('工时报价', 'unstarted', '', 22000),
  st('Todo', 'unstarted', 'todo', 25000),
  st('开发交付', 'started', '', 30000),
  st('结果验收', 'started', '', 32000),
  st('In Progress', 'started', 'in-progress', 35000),
  st('Done', 'completed', 'done', 45000),
  st('Cancelled', 'cancelled', 'cancelled', 55000),
];

const PUB = 'u-pub';
const DEV = 'u-dev';
const BOSS = 'u-boss';
const record = (over = {}) => ({
  publisherId: PUB,
  developerId: DEV,
  expectedStage: 'submitted',
  quotedAt: null,
  quoteConfirmedAt: null,
  deliveredAt: null,
  acceptedAt: null,
  cancelledAt: null,
  ...over,
});
const now = new Date();

test('开发类项目按五步状态名动态认，缺一步就不算', () => {
  assert.equal(isDevProjectStates(DEV_STATES), true);
  assert.equal(isDevProjectStates(DEV_STATES.filter((s) => s.name !== '工时报价')), false);
  assert.equal(isDevProjectStates([st('Todo', 'unstarted', 'todo'), st('Done', 'completed', 'done')]), false);
  // 名字前后有空格也认
  assert.equal(isDevProjectStates(DEV_STATES.map((s) => ({ ...s, name: ` ${s.name} ` }))), true);
});

test('stageOfState：五步按名字，完成 / 取消按分组，阻塞按 slug / 中文名，其余算流程外', () => {
  assert.equal(stageOfState(st('需求提交', 'backlog')), 'submitted');
  assert.equal(stageOfState(st('需求评审', 'unstarted')), 'clarifying');
  assert.equal(stageOfState(st('工时报价', 'unstarted')), 'quoted');
  assert.equal(stageOfState(st('开发交付', 'started')), 'developing');
  assert.equal(stageOfState(st('结果验收', 'started')), 'reviewing');
  assert.equal(stageOfState(st('Done', 'completed', 'done')), 'done');
  assert.equal(stageOfState(st('已验收', 'completed')), 'done');
  assert.equal(stageOfState(st('Cancelled', 'cancelled', 'cancelled')), 'cancelled');
  assert.equal(stageOfState(st('Blocked', 'started', 'blocked')), 'blocked');
  assert.equal(stageOfState(st('阻塞', 'started')), 'blocked');
  assert.equal(stageOfState(st('Backlog', 'backlog', 'backlog')), 'other');
  assert.equal(stageOfState(st('In Progress', 'started', 'in-progress')), 'other');
  assert.equal(stageOfState(undefined), 'missing');
  assert.equal(findGroupState(DEV_STATES, 'completed').name, 'Done');
  assert.equal(findGroupState(DEV_STATES, 'cancelled').name, 'Cancelled');
});

test('身份：开发者报价、发布人确认验收；老板能替任一边，但不能自己报、自己确认', () => {
  const r = record();
  const dev = { userId: DEV, isBoss: false };
  const pub = { userId: PUB, isBoss: false };
  const boss = { userId: BOSS, isBoss: true };
  assert.equal(rolePermits('quote', dev, r), true);
  assert.equal(rolePermits('quote', pub, r), false);
  assert.equal(rolePermits('quote', boss, r), true);
  assert.equal(rolePermits('confirm_quote', dev, r), false);
  assert.equal(rolePermits('confirm_quote', pub, r), true);
  assert.equal(rolePermits('confirm_quote', boss, r), true);
  assert.equal(rolePermits('accept', dev, r), false);
  assert.equal(rolePermits('accept', boss, r), true);
  assert.equal(rolePermits('deliver', pub, r), false);
  assert.equal(rolePermits('deliver', boss, r), false);
  assert.equal(rolePermits('return', boss, r), false);
  assert.equal(rolePermits('clarify', dev, r), false);
  assert.equal(rolePermits('cancel', dev, r), false);
  assert.equal(rolePermits('cancel', boss, r), true);
  // 老板是发布人：不能给自己的需求报价；老板是开发者：不能确认自己的报价、验收自己的交付
  assert.equal(rolePermits('quote', { userId: PUB, isBoss: true }, r), false);
  assert.equal(rolePermits('confirm_quote', { userId: DEV, isBoss: true }, r), false);
  assert.equal(rolePermits('accept', { userId: DEV, isBoss: true }, r), false);
  // 路人什么都不能做
  for (const action of ['quote', 'return', 'clarify', 'confirm_quote', 'deliver', 'accept', 'cancel']) {
    assert.equal(rolePermits(action, { userId: 'u-x', isBoss: false }, r), false, action);
  }
});

test('当前能做的动作：环节 + 身份 + 流程数据', () => {
  const dev = { userId: DEV, isBoss: false };
  const pub = { userId: PUB, isBoss: false };
  assert.deepEqual(allowedActionsOf(dev, record(), 'submitted'), ['quote', 'return']);
  assert.deepEqual(allowedActionsOf(pub, record(), 'submitted'), ['cancel']);
  assert.deepEqual(allowedActionsOf(pub, record({ expectedStage: 'clarifying' }), 'clarifying'), ['clarify', 'cancel']);
  assert.deepEqual(allowedActionsOf(pub, record({ quotedAt: now }), 'quoted'), ['confirm_quote', 'reject_quote', 'cancel']);
  // 在 Plane 里直接拖到工时报价、没报价：不能确认
  assert.deepEqual(allowedActionsOf(pub, record(), 'quoted'), ['cancel']);
  const confirmed = record({ quotedAt: now, quoteConfirmedAt: now });
  assert.deepEqual(allowedActionsOf(dev, confirmed, 'developing'), ['deliver', 'block']);
  // 在 Plane 里直接拖到开发交付、报价没确认：交付不了
  assert.deepEqual(allowedActionsOf(dev, record(), 'developing'), []);
  assert.deepEqual(allowedActionsOf(dev, confirmed, 'blocked'), ['unblock']);
  const delivered = record({ quotedAt: now, quoteConfirmedAt: now, deliveredAt: now });
  assert.deepEqual(allowedActionsOf(pub, delivered, 'reviewing'), ['accept', 'reject_delivery', 'cancel']);
  // 没交付就在 Plane 里拖到结果验收：只能打回
  assert.deepEqual(allowedActionsOf(pub, confirmed, 'reviewing'), ['reject_delivery', 'cancel']);
  // 完成 / 撤销后什么都不能做
  assert.deepEqual(allowedActionsOf(pub, record({ acceptedAt: now }), 'done'), []);
  assert.deepEqual(allowedActionsOf(pub, record({ cancelledAt: now }), 'cancelled'), []);
  assert.deepEqual(allowedActionsOf(pub, record(), 'done'), []);
  // 流程外的状态只能撤销
  assert.deepEqual(allowedActionsOf(pub, record(), 'other'), ['cancel']);
  assert.equal(preconditionError('accept', confirmed), '开发者还没交付，不能验收');
  assert.equal(preconditionError('deliver', record()), '报价还没确认，不能开工');
});

test('和 Plane 对不上的提示', () => {
  assert.equal(flowWarningOf('submitted', '需求提交', record()), null);
  assert.equal(flowWarningOf('done', 'Done', record()), '在 Plane 里直接改成完成，未经验收，没有记账');
  assert.equal(flowWarningOf('done', 'Done', record({ acceptedAt: now, expectedStage: 'done' })), null);
  assert.match(flowWarningOf('developing', '开发交付', record({ acceptedAt: now })), /已验收记账/);
  assert.equal(flowWarningOf('cancelled', 'Cancelled', record()), '在 Plane 里直接取消了，没走撤销');
  assert.match(flowWarningOf('developing', '开发交付', record()), /报价还没确认/);
  assert.match(flowWarningOf('other', 'Backlog', record()), /不在开发需求流程里/);
  assert.match(flowWarningOf('missing', null, record()), /找不到/);
  // 工作台报的阻塞、阻塞后在 Plane 里改回开发交付：都不算问题
  const confirmed = { quotedAt: now, quoteConfirmedAt: now };
  assert.equal(flowWarningOf('blocked', 'Blocked', record({ ...confirmed, expectedStage: 'blocked' })), null);
  assert.equal(flowWarningOf('developing', '开发交付', record({ ...confirmed, expectedStage: 'blocked' })), null);
  assert.match(flowWarningOf('reviewing', '结果验收', record({ ...confirmed, expectedStage: 'developing' })), /还没有交付/);
});

test('描述里的「键=值」行：生成、按行改、删、拆', () => {
  const html = buildDescriptionHtml('做个筛选\n要能导出', [
    ['验收条件', '能筛选\n能导出'],
    ['发布人', '张三'],
    ['开发', '李四'],
  ]);
  assert.equal(
    html,
    '<p>做个筛选</p><p>要能导出</p><p>验收条件=能筛选；能导出</p><p>发布人=张三</p><p>开发=李四</p>',
  );
  const quoted = upsertManagedLines(html, { 工时: '6h', 报价: '¥1200（只记账）', 承诺交付: null });
  assert.match(quoted, /<p>工时=6h<\/p><p>报价=¥1200（只记账）<\/p>$/u);
  assert.doesNotMatch(quoted, /承诺交付/u);
  // Plane 编辑器带 class 的段落、行内加粗也能认出来并替换
  const edited = quoted.replace('<p>工时=6h</p>', '<p class="editor-paragraph-block">工时=<strong>6h</strong></p>');
  const requoted = upsertManagedLines(edited, { 工时: '8h' });
  assert.match(requoted, /<p>工时=8h<\/p>/u);
  assert.doesNotMatch(requoted, /6h/u);
  const cleared = upsertManagedLines(requoted, { 工时: null, 报价: null });
  assert.doesNotMatch(cleared, /工时=|报价=/u);
  assert.match(cleared, /<p>做个筛选<\/p>/u);
  const parts = splitDescription(quoted);
  assert.equal(parts.body, '做个筛选\n要能导出');
  assert.equal(parts.acceptance, '能筛选；能导出');
  // 转义：尖括号、引号原样回来
  const escaped = buildDescriptionHtml('a<b> & "c"', [['验收条件', 'x']]);
  assert.equal(splitDescription(escaped).body, 'a<b> & "c"');
  assert.equal(singleLine(' a \n\n b '), 'a；b');
});

test('金额按分算，最多两位小数', () => {
  assert.equal(toCents(1200), 120000);
  assert.equal(toCents(1200.5), 120050);
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.equal(toCents(1.005), null);
  assert.equal(toCents(-1), null);
  assert.equal(toCents('12'), null);
  assert.equal(toCents(Number.NaN), null);
  assert.equal(centsToNumeric(120050), '1200.50');
});
