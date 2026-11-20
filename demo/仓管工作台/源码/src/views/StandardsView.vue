<template>
  <div class="dpage">
    <div class="ph">
      <div>
        <div class="eyebrow">外部问卷参考转化 · 按同品类同拆封状态取步骤最多超集 + 独有项并集 · 主管人工审核发布</div>
        <h1>验货标准库 · 爱回收 1,042 路径超集归并与版本管控 <Q k="standards" /></h1>
        <p class="sub">
          已按禅道 <code>WH02</code> 落地：采集 1,000+ 机型完整问卷分支，按「二手已使用 / 全新未拆封」分组选<b>步骤最长的基准超集</b>并补齐跨机型独有项；只用于仓管客观验货，剔除外部估价金额，经主管审核后锁定版本发布。
        </p>
      </div>
      <div class="row">
        <span class="tag acc">生效品类 {{ STANDARD_TEMPLATES.length }} 类</span>
        <span class="tag" :class="pendingDraftCount > 0 ? 'amb' : 'grn'">
          {{ pendingDraftCount > 0 ? `! 待主管审核草稿 ${pendingDraftCount} 条` : '✓ 增量草稿已全部审结' }}
        </span>
      </div>
    </div>

    <!-- 1. 爱回收问卷采集池 → 最长超集选型逻辑看板 -->
    <div class="card" style="margin-bottom:14px">
      <div class="ch">
        <div>
          <h2>爱回收问卷路径采集与「最长超集」基准选定台账</h2>
          <p class="muted" style="font-size:13px">不是选出现频率最高的简版问卷，而是选同品类同状态下检查步骤最多的一条做底座，再并入其他机型的独有高价值检查项</p>
        </div>
        <button class="btn sm pri" @click="go('inspect')">去验货台体验分步问卷 ›</button>
      </div>

      <div class="superset-grid">
        <div
          v-for="tpl in STANDARD_TEMPLATES"
          :key="tpl.id"
          class="sup-card"
          :class="{ on: curId === tpl.id }"
          @click="curId = tpl.id"
        >
          <div style="display:flex;justify-content:space-between;align-items:center">
            <b>{{ tpl.category }}</b>
            <span class="tag acc">{{ treeOf(tpl.id).version }}</span>
          </div>
          <div style="font-size:22px;font-weight:800;margin:6px 0;color:var(--acc)">
            {{ treeOf(tpl.id).baselineStats.crawledModels }} <small style="font-size:12px;color:var(--mute);font-weight:500">条机型路径已归并</small>
          </div>
          <p style="font-size:12px;color:var(--ink2);line-height:1.45">
            <b>最长基准：</b>{{ treeOf(tpl.id).baselineStats.baselineModel }}
          </p>
          <p class="muted" style="font-size:11.5px;margin-top:4px;line-height:1.4">
            <b>独有项并入：</b>{{ treeOf(tpl.id).baselineStats.mergedUniqueItems }}
          </p>
        </div>
      </div>
    </div>

    <!-- 2. 当前选中品类完整步骤与选项定义 -->
    <div class="card">
      <div class="ch">
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <button
            v-for="tpl in STANDARD_TEMPLATES"
            :key="tpl.id"
            class="btn"
            :class="curId === tpl.id ? 'pri' : ''"
            @click="curId = tpl.id"
          >
            {{ tpl.category }} · {{ treeOf(tpl.id).version }}
          </button>
        </div>
        <span class="muted" style="font-size:12px">来源：{{ curStd.source }} · 最近核准：{{ curStd.updatedAt }}</span>
      </div>

      <div class="why-box amb" style="margin-bottom:12px">
        <b>防串版锁死规则（WH02 / G11）：</b>外部采集草稿仅作参考素材，须经仓管主管审核发布后才对新验货单生效；正在检验中的单据继续锁定开单版本，不自动覆盖历史验货记录。
      </div>

      <table class="tbl">
        <thead>
          <tr>
            <th style="width:140px">适用状态分支</th>
            <th style="width:230px">标准检查步骤</th>
            <th>分级选项与瑕疵判定口径（无报价计算）</th>
            <th style="width:110px">防呆要求</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><span class="tag dark">入口分流开关</span></td>
            <td><b>{{ curTree.entryStep.title }}</b></td>
            <td>{{ curTree.entryStep.options.map(o => o.label).join('  /  ') }}</td>
            <td><span class="tag red">严禁未拆混同</span></td>
          </tr>
          <tr v-for="st in curTree.sealedSteps" :key="st.key">
            <td><span class="tag amb">原封未拆封分支</span></td>
            <td><b>{{ st.title }}</b></td>
            <td>{{ st.options.map(o => o.label).join('  /  ') }}</td>
            <td><span class="tag amb">防后封必核</span></td>
          </tr>
          <tr v-for="st in curTree.usedSteps" :key="st.key">
            <td><span class="tag acc">二手已使用主分支</span></td>
            <td><b>{{ st.title }}</b></td>
            <td>{{ st.options.map(o => o.label).join('  /  ') }}</td>
            <td><span class="tag red">坏货仍必测</span></td>
          </tr>
          <tr v-if="curTree.multiFaults?.length">
            <td><span class="tag acc">多选异常汇总</span></td>
            <td><b>{{ curTree.multiFaultsTitle }}</b></td>
            <td>{{ curTree.multiFaults.map(m => m.label).join(' ； ') }}</td>
            <td><span class="tag red">禁留空默认</span></td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 3. 外部采集增量草稿（主管人工审核发布池） -->
    <div class="card" style="margin-top:14px">
      <div class="ch">
        <div>
          <h2>外部采集增量修订提议池（仓管主管审核后发布）</h2>
          <p class="muted" style="font-size:13px">采集到爱回收新机型独有测试项时自动对比差异生成提议，未经主管确认绝不自动覆盖线上标准</p>
        </div>
        <span class="tag amb">演示模拟 · 生产定时采集对比管道待挂接</span>
      </div>

      <div class="draft-list">
        <div v-for="d in drafts" :key="d.id" class="draft-row" :class="{ pub: d.status === 'PUBLISHED' }">
          <div>
            <div class="row" style="gap:8px;margin-bottom:6px">
              <span class="tag" :class="d.status === 'PUBLISHED' ? 'grn' : 'amb'">
                {{ d.status === 'PUBLISHED' ? '✓ 已审核发布' : '! 待主管审核' }}
              </span>
              <span class="mono"><b>{{ d.id }}</b></span>
              <span class="tag acc">{{ stdName(d.targetStdId) }}：{{ d.currentVer }} → {{ d.nextVer }}</span>
              <span class="muted" style="font-size:12px">来源：{{ d.crawlSource }}</span>
            </div>
            <div style="font-size:15px;font-weight:600;margin-bottom:4px">{{ d.changeTitle }}</div>
            <p class="muted" style="font-size:13px">
              影响评估：当前在库同品类商品共 <b>{{ d.impactedInStock }} 件</b>（发布后仅新单启用新版本，在办单不串版）。
              <span v-if="d.publishedBy"> · 审核发布人：{{ d.publishedBy }}</span>
            </p>
          </div>

          <div style="flex-shrink:0">
            <Lock
              v-if="d.status !== 'PUBLISHED'"
              :ok="isSupervisor && !locked"
              :reason="locked ? '新同事未完成 3 项练习前禁止操作' : '外部采集草稿须由「仓管主管」人工审核后发布（右上角可切换周卫东体验）'"
              @go="publishStandardDraft(d)"
            >审核通过并升版至 {{ d.nextVer }}</Lock>
            <span v-else class="tag grn">已升版生效</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import Q from '../components/Q.vue'
import Lock from '../components/Lock.vue'
import { AIHUISHOU_TREES } from '../data/aihuishouTrees.js'
import {
  store, currentUser, isSupervisor, go, STANDARD_TEMPLATES, publishStandardDraft
} from '../store/warehouseStore.js'

const curId = ref(STANDARD_TEMPLATES[0].id)
const curStd = computed(() => STANDARD_TEMPLATES.find(s => s.id === curId.value) || STANDARD_TEMPLATES[0])
const curTree = computed(() => AIHUISHOU_TREES[curId.value] || AIHUISHOU_TREES['STD-PHONE'])
const drafts = computed(() => store.data.standardDrafts || [])
const pendingDraftCount = computed(() => drafts.value.filter(d => d.status !== 'PUBLISHED').length)
const locked = computed(() => !currentUser.value.practiceDone)

function treeOf(id) {
  return AIHUISHOU_TREES[id] || AIHUISHOU_TREES['STD-PHONE']
}

function stdName(id) {
  const s = STANDARD_TEMPLATES.find(x => x.id === id)
  return s ? s.category : id
}
</script>

<style scoped>
.superset-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.sup-card {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--bg);
  cursor: pointer;
  transition: border-color .15s, background .15s;
}
.sup-card.on {
  border-color: var(--acc);
  background: var(--acc-soft);
  box-shadow: 0 0 0 1px var(--acc);
}
.draft-list { display: flex; flex-direction: column; gap: 12px; }
.draft-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 18px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-left: 4px solid var(--amb);
  border-radius: 10px;
  background: #fff;
}
.draft-row.pub {
  border-left-color: var(--grn);
  background: #fcfefd;
}
</style>
