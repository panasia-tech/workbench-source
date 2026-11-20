<template>
  <div class="page-scroll">
    <div class="page-wrap">
      <header class="card" style="display: flex; justify-content: space-between; align-items: center">
        <div>
          <span class="tag acc">培训是 UI 的债务 · 2分钟零基础自主通关</span>
          <h1 style="font-size: 21px; margin-top: 6px">外包新人 3 关防踩坑练兵场 & 极窄职责边界墙</h1>
          <p class="muted" style="font-size: 13px; margin-top: 3px">
            当前账号：<b>{{ currentRole.name }}</b> · 已通关 <b>{{ practiceProgress.doneCount }} / 3</b> 关（切到右上角「周小萌」可体验未通关时真实按钮自动上锁）
          </p>
        </div>
        <div style="display: flex; gap: 8px">
          <button type="button" class="btn sm" @click="resetPracticeForCurrentActor">
            重置本账号练习重测一遍
          </button>
          <Q k="learn" label="练兵规则" />
        </div>
      </header>

      <!-- 3 关实战卡片 -->
      <div class="prac-grid">
        <div
          v-for="p in PRACTICES"
          :key="p.key"
          class="card prac-card"
          :class="{ done: practiceProgress.map[p.key] }"
        >
          <div style="display: flex; justify-content: space-between; align-items: center">
            <span class="tag" :class="practiceProgress.map[p.key] ? 'grn' : 'amb'">
              {{ practiceProgress.map[p.key] ? '✓ 已通关' : `待闯关 · 第 ${p.stepNo} 关` }}
            </span>
            <span class="muted" style="font-size: 12px">约 40 秒</span>
          </div>
          <h3 style="font-size: 16px">{{ p.title }}</h3>
          <p style="font-size: 13px; color: var(--ink2); flex: 1">{{ p.scenario }}</p>
          <button
            type="button"
            class="btn"
            :class="practiceProgress.map[p.key] ? '' : 'pri'"
            @click="store.ui.practiceOpenKey = p.key"
          >
            {{ practiceProgress.map[p.key] ? '再练一次' : '开始闯关 ›' }}
          </button>
        </div>
      </div>

      <!-- 外包客服极窄边界：三做 · 六不做 · 四看不见 -->
      <div class="boundary-grid">
        <section class="card bd-col grn">
          <h3>✅ 外包客服只做这 3 件事（极窄聚焦）</h3>
          <ul>
            <li><b>1. 多平台秒级首响促单：</b>30 秒内接起闲鱼/拼多多/千牛/抖店/京东咨询，用标准话术守一口价促成交。</li>
            <li><b>2. 发货前置挑货发实拍：</b>照右侧小卡片从 WMS 挑定唯一绿灯单品，一键把仓管拍的【实拍照片+通电视频+瑕疵清单】发给买家。</li>
            <li><b>3. 疑问熔断跟进与异常转交：</b>自动发货期买家发问时解答或换绑同款机器；超出权限一键点右侧按钮 60 秒转内部销售或仓管。</li>
          </ul>
        </section>

        <section class="card bd-col red">
          <h3>🚫 物理阉割严禁做的 6 件事（防事故红线）</h3>
          <ul>
            <li><b>1. 严禁主动关闭买家订单：</b>避免重演闲鱼鱼力值跌至 165 全店限流惨剧（按钮已物理移除）。</li>
            <li><b>2. 严禁留微信/手机号引流：</b>外发守卫实时拦截一切站外联系方式与非白名单外链。</li>
            <li><b>3. 严禁拿网图或别台视频冒充本机：</b>售前关卡缺视频时强制锁死，只能点催仓管补拍。</li>
            <li><b>4. 严禁口头乱承诺无划痕/包退：</b>一切成色严格按爱回收客观检测单披露，乱承诺退货倒扣绩效。</li>
            <li><b>5. 严禁越权大刀改价或出入库：</b>无法修改 WMS 库存，破底线砍价一律转内部销售。</li>
            <li><b>6. 严禁擅自拍板已签收售后退款：</b>如在保显示器黑屏统一走官方联保，收齐图片后一键转内部专员。</li>
          </ul>
        </section>

        <section class="card bd-col acc">
          <h3>🔒 系统 API 硬隔离的 4 类机密（零泄密）</h3>
          <ul>
            <li><b>1. 采购进价与单笔毛利：</b>服务端对外包角色直接剥离 `cost_price`，仅给一口价与最大让利券额。</li>
            <li><b>2. 上游卖家与同行供货渠道：</b>采购订单截图、上游议价聊天与供货群白名单彻底不可见。</li>
            <li><b>3. 仓库内部排架与库位照：</b>自动过滤 `_PRIVATE_MARKERS`（库位照/订单图/改派单），防止暴露仓内布局。</li>
            <li><b>4. 店铺明文密码与非授权店：</b>外包直接登录聚合工作台，零接触平台账号密码、支付宝与 2FA 种子。</li>
          </ul>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup>
import { store, currentRole, practiceProgress, resetPracticeForCurrentActor } from '../store.js';
import { PRACTICES } from '../data/helpAndRules.js';
import Q from '../components/Q.vue';
</script>

<style scoped>
.prac-grid,
.boundary-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}
.prac-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.prac-card.done {
  border-color: rgba(13, 148, 88, 0.4);
}
.bd-col h3 {
  font-size: 15.5px;
  margin-bottom: 10px;
}
.bd-col ul {
  margin: 0;
  padding-left: 18px;
  display: grid;
  gap: 8px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink2);
}
.bd-col.grn {
  border-top: 4px solid var(--grn);
}
.bd-col.red {
  border-top: 4px solid var(--red);
}
.bd-col.acc {
  border-top: 4px solid var(--acc);
}
</style>
