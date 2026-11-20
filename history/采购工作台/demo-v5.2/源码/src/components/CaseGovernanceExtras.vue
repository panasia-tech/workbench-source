<template>
  <div class="gov-grid">
    <!-- 左：五阶段治理提交与职责分离二审（对标 04-五阶段与交付条件.png） -->
    <section class="card">
      <h3>
        五阶段治理与异岗二审
        <small>每次重交版本号 +1；提交人本人禁自审；历次批注永久保留</small>
        <Q k="pe-stages" />
      </h3>

      <div class="st-rail">
        <button
          v-for="s in stages"
          :key="s.stage_no"
          type="button"
          class="st-pill"
          :class="[s.state, { sel: activeStageNo === s.stage_no }]"
          @click="activeStageNo = s.stage_no"
        >
          <span class="st-num">{{ s.state === 'done' ? '✓' : s.stage_no }}</span>
          <div class="st-txt">
            <b>{{ s.name }}</b>
            <small>
              v{{ s.version_no }} ·
              {{
                s.state === 'done'
                  ? '已通过'
                  : s.state === 'submitted'
                    ? '待二审'
                    : s.state === 'doing'
                      ? '整理中'
                      : '未开始'
              }}
            </small>
          </div>
        </button>
      </div>

      <div v-if="curStage" class="st-work">
        <div class="st-meta">
          <span>
            当前查看：<b>阶段 {{ curStage.stage_no }} · {{ curStage.name }}</b>（当前版本
            <span class="mono">v{{ curStage.version_no }}</span>）
          </span>
          <span v-if="curStage.submitted_by" class="tag">
            最近提交：{{ roleName(curStage.submitted_by) }}
          </span>
        </div>

        <div v-if="curStage.note" class="cur-note">
          <span class="muted">当前提交材料说明：</span>{{ curStage.note }}
        </div>

        <!-- 提交材料（升版 +1） -->
        <div class="sub-box">
          <label class="field">
            <span>提交/补充阶段材料依据（至少 4 字，重交自动升为 v{{ curStage.version_no + 1 }}）</span>
            <input
              v-model="submitNote"
              class="input"
              placeholder="例如：已核验闲鱼同型号近 7 天 12 单成交均价与四路验机底图"
            />
          </label>
          <Lock
            :ok="submitGate.ok"
            :busy="busy"
            :reason="submitGate.reason"
            :penalty="submitGate.penalty"
            :fix-text="submitGate.fixText"
            @go="doSubmitStage"
            @fix="onFix(submitGate.fixAct)"
          >
            提交阶段材料（升版 v{{ curStage.version_no + 1 }}）
          </Lock>
        </div>

        <!-- 二审把关（职责分离：自己交的材料不能自己审！） -->
        <div v-if="curStage.state === 'submitted'" class="rev-box">
          <label class="field">
            <span>二审复核意见（退回必填原因 ≥4 字）</span>
            <input
              v-model="reviewComment"
              class="input"
              placeholder="核验材料齐全准予通过，或写清缺哪张图退回重补…"
            />
          </label>
          <div class="rev-acts">
            <Lock
              :ok="reviewGate.ok"
              :busy="busy"
              kind="ok"
              :reason="reviewGate.reason"
              :penalty="reviewGate.penalty"
              :fix-text="reviewGate.fixText"
              @go="doReview('通过')"
              @fix="onFix(reviewGate.fixAct)"
            >
              ✓ 二审通过
            </Lock>
            <Lock
              :ok="rejectGate.ok"
              :busy="busy"
              kind="bad"
              :reason="rejectGate.reason"
              @go="doReview('退回')"
              @fix="onFix(rejectGate.fixAct)"
            >
              ✕ 退回补材料
            </Lock>
          </div>
        </div>

        <div v-if="err" class="errbox">{{ err }}</div>

        <!-- 历史审批记录表（只增不改，绝不覆盖旧意见） -->
        <div class="rev-hist">
          <div class="muted" style="font-size: 12.5px; font-weight: 700; margin-bottom: 6px">
            历史二审留痕记录（共 {{ reviews.length }} 条 · 重交升版不覆盖历史意见）
          </div>
          <div v-if="reviews.length" class="tblwrap">
            <table class="tbl">
              <thead>
                <tr>
                  <th>阶段/版本</th>
                  <th>评审人</th>
                  <th>结论</th>
                  <th>评审意见</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in reviews" :key="r.review_id">
                  <td class="mono">S{{ r.stage_no }} · v{{ r.version_no }}</td>
                  <td>{{ r.reviewer_name }}</td>
                  <td>
                    <span class="tag" :class="r.verdict === '通过' ? 'grn' : 'amb'">{{ r.verdict }}</span>
                  </td>
                  <td>{{ r.comment }}</td>
                  <td class="muted mono" style="font-size: 12px">{{ (r.created_at || '').slice(5, 16) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="muted" style="font-size: 13px">本卡暂无二审记录；上方提交阶段材料后即可体验异岗复核留痕。</p>
        </div>
      </div>
    </section>

    <!-- 右：关联价格表版本冻结（G11）与周复盘结论 -->
    <section class="card">
      <h3>
        参考价格版本（G11）与周复盘结论
        <small>发新版不冲乱在途老会话</small>
      </h3>

      <div v-if="c.pricebook_item" class="pb-box">
        <div class="pb-row">
          <div>
            <span class="muted" style="font-size: 12.5px">关联价格表条目</span>
            <div style="font-weight: 800; font-size: 15.5px">
              {{ c.pricebook_item.spec_label }} · {{ c.pricebook_item.condition_grade }}
            </div>
          </div>
          <span class="tag" :class="c.pricebook_item.status === 'published' ? '' : 'amb'">
            v{{ c.pricebook_item.version_no }} · {{ c.pricebook_item.status === 'published' ? '当前生效' : '草稿待主管发布' }}
          </span>
        </div>

        <div class="pb-nums">
          <div><span>参考价</span><b class="num">{{ fmtYuan(c.pricebook_item.ref_price_cents) }}</b></div>
          <div><span>首轮报</span><b class="num">{{ fmtYuan(c.pricebook_item.first_offer_cents) }}</b></div>
          <div><span>目标价</span><b class="num">{{ fmtYuan(c.pricebook_item.target_cents) }}</b></div>
          <div><span>授权上限</span><b class="num">{{ fmtYuan(c.pricebook_item.ceiling_cents) }}</b></div>
        </div>

        <div v-if="c.pricebook_item.status !== 'published'" style="margin-top: 10px">
          <Lock
            :ok="pubGate.ok"
            :busy="busy"
            :reason="pubGate.reason"
            :penalty="pubGate.penalty"
            :fix-text="pubGate.fixText"
            @go="publishPb"
            @fix="onFix(pubGate.fixAct)"
          >
            主管发布此价格版本并输出 G11 影响清单
          </Lock>
        </div>
        <div style="margin-top: 8px">
          <a href="#/pricebook" class="btn sm">去参考价格表管理全部机型 ›</a>
        </div>
      </div>
      <div v-else class="pb-box muted" style="font-size: 13.5px">
        当前机型暂未绑定独立价格表条目，按系统基准比例保护上限；可前往 <a href="#/pricebook">参考价格表</a> 新建。
      </div>

      <hr class="sep" />

      <div class="wk-box">
        <div style="font-weight: 800; font-size: 15px; margin-bottom: 8px">
          周会复盘决定（当前结论：<span class="tag acc">{{ c.review_decision }}</span>）
        </div>
        <div class="wk-pills">
          <button
            v-for="d in ['继续', '扩大', '调整', '暂停', '退出']"
            :key="d"
            type="button"
            class="btn sm"
            :class="{ pri: dec === d }"
            @click="dec = d"
          >
            {{ d }}
          </button>
        </div>
        <label class="field" style="margin-top: 10px">
          <span>复盘判断依据（写清净节省率、退货率或卖家渠道特征）</span>
          <input v-model="decNote" class="input" placeholder="例如：近两周一次验机合格率 100%，单台净省 400 元，继续收" />
        </label>
        <div style="margin-top: 10px">
          <Lock
            :ok="decGate.ok"
            :busy="busy"
            :reason="decGate.reason"
            :fix-text="decGate.fixText"
            @go="saveDecision"
            @fix="onFix(decGate.fixAct)"
          >
            保存周复盘结论
          </Lock>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { store, callAction, currentRole, isPracticeUnlocked, practiceDoneCount, setActor, notify } from '../store.js';
import { fmtYuan } from '../api.js';
import Q from './Q.vue';
import Lock from './Lock.vue';

const props = defineProps({
  c: { type: Object, required: true },
});

const activeStageNo = ref(1);
const submitNote = ref('');
const reviewComment = ref('');
const dec = ref(props.c.review_decision || '继续');
const decNote = ref(props.c.review_note || '');
const err = ref('');
const busy = ref(false);

const stages = computed(() => props.c.governance_stages || []);
const reviews = computed(() => props.c.governance_reviews || []);
const curStage = computed(() => stages.value.find((s) => s.stage_no === activeStageNo.value) || stages.value[0] || null);

watch(
  () => props.c.case_id,
  () => {
    const sub = stages.value.find((s) => s.state === 'submitted') || stages.value.find((s) => s.state === 'doing') || stages.value[0];
    activeStageNo.value = sub ? sub.stage_no : 1;
    dec.value = props.c.review_decision || '继续';
    decNote.value = props.c.review_note || '';
    err.value = '';
  },
  { immediate: true },
);

function roleName(id) {
  return store.dashboard.roles.find((r) => r.id === id)?.name || id;
}

const submitGate = computed(() => {
  if (!isPracticeUnlocked()) {
    return {
      ok: false,
      reason: `新员工需先完成「学」里的 3 关防呆练习（当前 ${practiceDoneCount()}/3）`,
      penalty: '未熟悉规则直接提交会导致无效审批返工',
      fixText: '去做防呆练习',
      fixAct: 'practice',
    };
  }
  if (submitNote.value.trim().length < 4) {
    return {
      ok: false,
      reason: '请先在上方填写至少 4 个字的阶段材料说明（禁填 0 或无）',
      penalty: '空白材料会让二审人无法核验真实性',
      fixText: '',
      fixAct: '',
    };
  }
  return { ok: true };
});

const reviewGate = computed(() => {
  if (!isPracticeUnlocked()) {
    return { ok: false, reason: '请先完成 3 关新手练习', fixText: '去做练习', fixAct: 'practice' };
  }
  const role = currentRole();
  if (curStage.value?.submitted_by === store.actorId && role.role !== 'supervisor') {
    return {
      ok: false,
      reason: `职责分离硬门禁：本阶段材料是你本人（${role.name}）提交的，不能自己点二审通过！`,
      penalty: '自交自审会失去第二双眼睛纠错，造成错价或漏证带病过关',
      fixText: '一键切王主管二审演示',
      fixAct: 'switch_wangzg',
    };
  }
  return { ok: true };
});

const rejectGate = computed(() => {
  if (!reviewGate.value.ok) return reviewGate.value;
  if (reviewComment.value.trim().length < 4) {
    return {
      ok: false,
      reason: '退回补材料必须写清至少 4 个字的原因（缺哪项证据、怎么改）',
      fixText: '',
      fixAct: '',
    };
  }
  return { ok: true };
});

const pubGate = computed(() => {
  if (currentRole().role !== 'supervisor') {
    return {
      ok: false,
      reason: '仅【采购主管（王主管）】可正式发布生效参考价格表',
      penalty: '一线采购自行调高上限会导致全组收货亏损',
      fixText: '一键切王主管发布',
      fixAct: 'switch_wangzg',
    };
  }
  return { ok: true };
});

const decGate = computed(() => {
  if (!isPracticeUnlocked()) {
    return { ok: false, reason: '请先完成 3 关新手练习', fixText: '去做练习', fixAct: 'practice' };
  }
  if (decNote.value.trim().length < 2) {
    return { ok: false, reason: '请填写至少 2 个字的复盘判断依据' };
  }
  return { ok: true };
});

function onFix(act) {
  if (act === 'practice') {
    store.ui.practice = 'chat_guard';
  } else if (act === 'switch_wangzg') {
    setActor('wangzg');
    notify('已切换为【王主管（采购主管）】，现在可执行异岗二审或发布价格表');
  }
}

async function doSubmitStage() {
  err.value = '';
  busy.value = true;
  try {
    await callAction(
      `/api/cases/${props.c.case_id}/governance/submit`,
      { stage_no: curStage.value.stage_no, note: submitNote.value },
      `阶段 ${curStage.value.stage_no} 材料已升版提交送审！`,
    );
    submitNote.value = '';
  } catch (e) {
    err.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function doReview(verdict) {
  err.value = '';
  busy.value = true;
  try {
    await callAction(
      `/api/cases/${props.c.case_id}/governance/review`,
      { stage_no: curStage.value.stage_no, verdict, comment: reviewComment.value },
      `阶段 ${curStage.value.stage_no} 二审「${verdict}」已写入历史记录表！`,
    );
    reviewComment.value = '';
  } catch (e) {
    err.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function publishPb() {
  err.value = '';
  busy.value = true;
  try {
    await callAction(
      `/api/pricebook/${props.c.pricebook_item.item_id}/publish`,
      {},
      '价格表新版本已发布生效！已存续会话按 G11 规则保持原版本冻结',
    );
  } catch (e) {
    err.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function saveDecision() {
  err.value = '';
  busy.value = true;
  try {
    await callAction(
      `/api/cases/${props.c.case_id}/governance/weekly-decision`,
      { decision: dec.value, note: decNote.value },
      `周复盘结论「${dec.value}」已保存`,
    );
  } catch (e) {
    err.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.gov-grid {
  display: grid;
  grid-template-columns: 1.2fr 1fr;
  gap: 16px;
}
.st-rail {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 14px;
}
.st-pill {
  min-height: 58px;
  padding: 8px 10px;
  border-radius: 14px;
  background: var(--panel);
  border: 1.5px solid var(--line);
  display: flex;
  align-items: center;
  gap: 8px;
  text-align: left;
}
.st-pill.sel {
  border-color: var(--acc);
  background: var(--acc-soft);
}
.st-num {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--soft);
  font-weight: 800;
  font-size: 13px;
  display: grid;
  place-items: center;
  flex: none;
}
.st-pill.done .st-num {
  background: var(--grn);
  color: #fff;
}
.st-pill.submitted .st-num {
  background: var(--amb);
  color: #261900;
}
.st-txt {
  min-width: 0;
}
.st-txt b {
  display: block;
  font-size: 13px;
}
.st-txt small {
  display: block;
  font-size: 11.5px;
  color: var(--mute);
}
.st-work {
  display: grid;
  gap: 12px;
}
.st-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13.5px;
}
.cur-note {
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--panel);
  border: 1px solid var(--line);
  font-size: 13.5px;
}
.sub-box,
.rev-box {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 12px 14px;
  display: grid;
  gap: 10px;
}
.rev-acts {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.pb-box {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 14px;
}
.pb-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.pb-nums {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.pb-nums > div {
  background: var(--soft);
  padding: 8px 10px;
  border-radius: 10px;
}
.pb-nums span {
  display: block;
  font-size: 11.5px;
  color: var(--mute);
}
.pb-nums b {
  font-size: 15px;
}
.sep {
  border: 0;
  border-top: 1px solid var(--line);
  margin: 16px 0;
}
.wk-pills {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
@media (max-width: 1100px) {
  .gov-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .st-rail {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .pb-nums {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
