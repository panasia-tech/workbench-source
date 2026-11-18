<template>
  <div class="dpage">
    <div class="ph">
      <div>
        <h1>学 · 首日 3 项防呆沙盒演练与视频微课 <Q k="learn-practice" /></h1>
        <p class="sub">先在隔离假数据沙盒里亲手走完 3 个高频防呆判断，再碰真实库存与工单；故意点错也能看到系统怎么拦你</p>
      </div>
      <div class="row">
        <button class="btn" @click="resetPracticeProgress">一键从头再学（只重置学习进度）</button>
      </div>
    </div>

    <!-- 新人通关提示条 -->
    <div v-if="!currentUser.practiceDone" class="why-box amb" style="margin-bottom:14px">
      <b>! 当前账号「{{ currentUser.name }}」还有未完成的沙盒练习：</b>真实工作台的写入按钮已自动上锁保护。在下方依次点开 3 张卡片做完（每张 3 步，共约 2 分钟），真实任务与库存操作立即解锁！
    </div>
    <div v-else class="why-box grn" style="margin-bottom:14px">
      <b>✓ 当前账号「{{ currentUser.name }}」已完成全部 3 项上岗沙盒演练！</b>真实库存与工单操作已开放；随时可点「再练一遍」或右上角切换「陈新宇 · 新同事」演示新员工门禁。
    </div>

    <!-- 3张交互沙盒练习卡（与销售工作台 Learn.vue 同构） -->
    <div class="p-grid">
      <div v-for="c in cases" :key="c.key" class="card p-card" :class="{ done: stepOf(c.key) >= 3 }">
        <div class="row" style="justify-content:space-between">
          <span class="tag" :class="stepOf(c.key) >= 3 ? 'grn' : 'acc'">
            {{ stepOf(c.key) >= 3 ? '✓ 做完了（3/3）' : `演练进度 ${stepOf(c.key)}/3` }}
          </span>
          <span class="muted" style="font-size:12px">隔离沙盒 · 不动真账</span>
        </div>

        <h2 style="margin-top:10px">{{ c.title }}</h2>
        <p class="muted" style="font-size:13px;margin:6px 0 12px;flex:1">{{ c.desc }}</p>

        <div class="pbar">
          <i :style="{ width: Math.round((stepOf(c.key) / 3) * 100) + '%' }"></i>
        </div>

        <ul class="pts">
          <li v-for="(pt, idx) in c.points" :key="idx">
            <span>{{ stepOf(c.key) > idx ? '✓' : (idx + 1) + '.' }}</span> {{ pt }}
          </li>
        </ul>

        <button class="btn" :class="stepOf(c.key) >= 3 ? '' : 'pri'" style="width:100%;margin-top:12px" @click="openPractice(c.key)">
          {{ stepOf(c.key) >= 3 ? '再练一遍' : (stepOf(c.key) > 0 ? `继续第 ${stepOf(c.key) + 1} 步` : '开始练习') }}
        </button>
      </div>
    </div>

    <!-- 分段实操视频微课库 -->
    <div class="card" style="margin-top:16px">
      <div class="ch">
        <div>
          <h2>仓内标准动作分段视频库（按岗位动作拆条）</h2>
          <p class="muted" style="font-size:13px">不放几十分钟长培训录像，每段 1–3 分钟对准一个具体工位动作</p>
        </div>
      </div>

      <div class="v-grid">
        <div v-for="v in videos" :key="v.title" class="v-card" @click="playVideo(v)">
          <div class="v-icon"><Icon name="play" /></div>
          <div style="flex:1">
            <b>{{ v.title }}</b>
            <p class="muted" style="font-size:12px;margin-top:2px">{{ v.note }}</p>
          </div>
          <span class="tag">{{ v.dur }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import Q from '../components/Q.vue'
import Icon from '../components/Icon.vue'
import { store, currentUser, openPractice, resetPracticeProgress } from '../store/warehouseStore.js'

const cases = [
  {
    key: 'case1',
    title: '练习 1：拆封录像与碎屏手机「坏货全检」',
    desc: '演练包裹到台先开顶拍连续录像、检出右上角碎屏后不准停手省测其余项目、回放确认可读后分流入隔离区。',
    points: ['拆封前先开高拍仪连续录制', '碎屏仍把面容/相机/ID锁一次测完', '回放确认非坏片并入异常隔离区']
  },
  {
    key: 'case2',
    title: '练习 2：10分钟货不对版与货钱双轨结案',
    desc: '演练发现 27 寸错发成 24 寸后的 10 分钟三路并发首报、全检完才交快递退回、运费差额 ¥35 核清才结案。',
    points: ['10分钟内拒签+通知采购（催办不重置）', '全量验货完成前禁止把货退走', '网点签收+运费差额核清双清结案']
  },
  {
    key: 'case3',
    title: '练习 3：出库齐套双复核与扫码防串件',
    desc: '演练主机+专用编号附件袋+原盒三件齐套核对、现场模拟扫错同型号串件码被硬拦、买家改址立即暂停退回销售。',
    points: ['核实主机 + 编号附件袋 + 原盒齐套', '机身条码防串件强校验', '发现新增瑕疵或改址立即暂停出库']
  }
]

const videos = [
  { title: '1. 高拍仪拆封前起录与六面封口留证规范', dur: '02:10', note: '演示运单号对焦、封口特写与录制中断如实登记流程。' },
  { title: '2. 为什么碎屏手机也必须做完「坏货全检」', dur: '03:40', note: '真实案例复盘：避免只退碎屏差价却漏检主板暗病造成二次亏损。' },
  { title: '3. 显示器专用编号附件袋与 10 秒轮播视频切图', dur: '02:30', note: '演示 BAG 编号袋绑定电源适配器，以及通电拍 10 秒壁纸轮播自动分图。' },
  { title: '4. 10分钟异常三路首报与议价留货 4 项反悔锁', dur: '03:10', note: '演示快递拒签、采购首轮凭证核验与主管解除隔离全流程。' },
  { title: '5. 17:00 前锁单扫码防串件与买家退回三代比对', dur: '03:25', note: '演示同型号防拿错扫码拦截，以及退回件原入库/原发货/本次拆封同屏核查。' },
  { title: '6. UHF 手持机批次盘点与抗金属标签漏读兜底', dur: '02:40', note: '演示开盘样签试读、在途待验单列与金属背板屏蔽微距留证。' }
]

function stepOf(key) {
  return (currentUser.value.steps && currentUser.value.steps[key]) || 0
}

function playVideo(v) {
  store.videoModal = { title: v.title, note: v.note }
}
</script>

<style scoped>
.p-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
}
.p-card {
  display: flex;
  flex-direction: column;
  border-top: 3px solid var(--acc);
}
.p-card.done {
  border-top-color: var(--grn);
}
.pbar {
  height: 8px;
  background: #e2e8f0;
  border-radius: 999px;
  overflow: hidden;
  margin-bottom: 10px;
}
.pbar i {
  display: block;
  height: 100%;
  background: var(--grn);
  transition: width 0.25s ease;
}
.pts {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 13px;
  color: var(--ink-2);
}
.pts span {
  font-weight: 700;
  color: var(--acc);
  margin-right: 4px;
}
.p-card.done .pts span { color: var(--grn); }
.v-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
}
.v-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  cursor: pointer;
  background: #fff;
  transition: border-color 0.15s, background 0.15s;
}
.v-card:hover {
  border-color: var(--acc);
  background: var(--acc-soft);
}
.v-icon {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--acc-soft);
  color: var(--acc);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
</style>
