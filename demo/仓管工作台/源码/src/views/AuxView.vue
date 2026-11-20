<template>
  <div class="page">
    <header class="head">
      <div>
        <h1>附属与原盒<Q k="aux" /></h1>
        <p class="sub">完好显示器/音响原装彩盒独立建账（单独售出只扣原盒库存并自动改写主机包装说明）；0元随单赠品出入留痕；老系统遗留实物强制转新复检现场重拍。</p>
      </div>
      <div class="acts">
        <button class="btn" @click="go('gallery', 'all')">‹ 返回库存实物</button>
        <button class="btn" @click="openHelp('aux')"><Icon name="help" />怎么用</button>
      </div>
    </header>

    <section class="card" style="margin-top:16px">
      <h3>独立原盒 · 0元赠品 · 仓内资产台账</h3>
      <div class="tblwrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>编号</th>
              <th>类别</th>
              <th>名称与规格</th>
              <th>关联主机 / 归属</th>
              <th>存放库位</th>
              <th>独立售价</th>
              <th>在库数</th>
              <th>状态</th>
              <th>动作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="a in store.data.auxiliaryLedger" :key="a.id">
              <td><code>{{ a.id }}</code></td>
              <td><span class="tag" :class="a.type === '独立原盒' ? 'acc' : ''">{{ a.type }}</span></td>
              <td><b>{{ a.name }}</b></td>
              <td>
                <a v-if="hasHost(a.hostSku)" @click="openItemDetail(a.hostSku)">#{{ a.hostSku }} ›</a>
                <span v-else class="muted">{{ a.hostSku }}</span>
              </td>
              <td>{{ a.loc }}</td>
              <td class="num">{{ a.price > 0 ? `¥${a.price}` : '¥0（随单赠品）' }}</td>
              <td class="num"><b>{{ a.qty }}</b></td>
              <td><span class="tag" :class="a.qty === 0 ? 'amb' : 'grn'">{{ a.status }}</span></td>
              <td>
                <Lock
                  v-if="a.type === '独立原盒'"
                  :ok="a.qty > 0 && !locked"
                  :reason="locked ? '先做完 3 个练习' : '该原盒已独立售出，库存为 0'"
                  kind="sm pri"
                  @go="sellAuxiliaryBox(a)"
                >独立售出原盒</Lock>
                <span v-else class="muted" style="font-size:12px">随订单领用留痕</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="card" style="margin-top:16px">
      <h3>老系统快照核对兜底 <small>历史记录只用于核对货号与原进价，转入新库存强制现场重拍实拍图，绝不继承老图</small></h3>
      <div v-for="leg in store.data.legacySnapshots" :key="leg.goodsNo" class="leg-row">
        <div>
          <span class="tag amb">老系统历史快照</span>
          <b style="margin-left:8px">{{ leg.model }}</b>
          <p class="muted" style="font-size:13px;margin-top:4px">
            老货号 <code>{{ leg.goodsNo }}</code> · SN {{ leg.sn }} · 老库位 {{ leg.oldLoc }} · 历史进价 ¥{{ leg.cost }}
          </p>
        </div>
        <span v-if="leg.converted" class="tag grn">✓ 已生成新复检单（去收货验货现场重拍）</span>
        <Lock
          v-else
          :ok="!locked"
          reason="先去「学」完成 3 个练习"
          @go="convertLegacyToInbound(leg)"
        >转入收货验货台现场重拍复检</Lock>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import Icon from '../components/Icon.vue'
import Q from '../components/Q.vue'
import Lock from '../components/Lock.vue'
import {
  store,
  currentUser,
  go,
  openItemDetail,
  openHelp,
  sellAuxiliaryBox,
  convertLegacyToInbound
} from '../store/warehouseStore.js'

const locked = computed(() => !currentUser.value.practiceDone)
const hasHost = (code) => store.data.skus.some(s => s.code === code)
</script>

<style scoped>
.leg-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  padding: 12px 14px;
  background: var(--soft);
  border: 1px solid var(--line);
  border-radius: 9px;
}
</style>
