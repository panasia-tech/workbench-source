<template>
  <div class="ue">
    <section class="card">
      <h4>单件整机资料<Q k="ue-unit" /> <small class="muted">一台一个 SPU / SKU / 链接，不共用一条链接卖多台</small></h4>
      <div class="tf">
        <label>真实标题<input v-model="u.title" :placeholder="sku.product_name" /></label>
        <label>配置<input v-model="u.config" placeholder="CPU / 内存 / 存储 / 显卡，按本机实际写" /></label>
        <label>成色与瑕疵<input v-model="u.defects" placeholder="划痕、缺件、换过什么；没有写「无」" /></label>
        <label>已测 / 未测<input v-model="u.testScope" placeholder="例如：已测接口、屏幕、电池；未测独显" /></label>
      </div>
      <p class="muted sm">不编品牌型号、不 AI 补造接口/配件；内部成本和账号口令不进客户描述。此件：{{ sku.sku_code }} · {{ sku.condition_grade || '成色没录' }} · 库位 {{ sku.location_code || '—' }}。</p>
    </section>

    <section class="card">
      <h4>AI 图工具留痕<Q k="ue-ai" /> <small class="muted">客户图只用指定工具，原件和处理版分开</small></h4>
      <div class="tf"><label>用的工具<select v-model="u.aiTool"><option value="">还没用</option><option>Nano Banana 2</option><option>ChatGPT Images 2.6</option><option>其它（要说明）</option></select></label><label>生成 / 编辑证据<input v-model="u.aiEvidence" placeholder="文件名 / 订单号 / 截图名" /></label></div>
      <p class="muted sm">原图、处理版、WMS 关联要能回查；不能用漂亮图掩盖瑕疵。</p>
    </section>

    <section class="card">
      <h4>样板闸门<Q k="ue-sample" /> <small class="muted">先做一台完整样板，主管核定后再全批</small></h4>
      <label class="ck"><input type="checkbox" v-model="u.sample" />这一台样板已完成（标题 / 详情 / 图 / 链接）</label>
      <input v-model="u.sampleNote" class="widein" placeholder="样板链接或截图名、核定意见" />
      <div class="row"><button class="btn sm" :disabled="!u.sample" @click="submitSample">提交主管核定</button><span v-if="u.sampleBy" class="tag grn">主管已核定：{{ u.sampleBy }} · {{ u.sampleAt }}</span><span v-else class="tag amb">还没核定</span></div>
      <p class="muted sm">没核定前，其他台只能准备材料，不能批量发布。每一步都要能对账：台数、标题、配置、瑕疵、图、链接。</p>
    </section>

    <section class="card wide">
      <h4>图片素材池 · 去水印 / 视觉筛选<Q k="ue-img" /> <small class="muted">原图不覆盖；改文件名 / 换链接不算不同图</small></h4>
      <div class="tblwrap"><table class="tbl"><thead><tr><th>素材</th><th>类型</th><th>状态</th><th>处理前后</th><th></th></tr></thead><tbody>
        <tr v-for="j in jobs" :key="j.id"><td><img :src="j.url" class="thumb" alt="" /></td><td>{{ j.kind }}</td><td><span class="tag" :class="JS[j.state]">{{ j.state }}</span></td><td class="muted">{{ j.before }}<template v-if="j.after"> → {{ j.after }}</template><template v-if="j.note"><br />{{ j.note }}</template></td>
          <td class="ac"><button v-if="j.state === '待处理'" class="btn sm pri" @click="clean(j)">去水印（演示）</button><button v-if="j.state !== '可用' && j.state !== '已淘汰'" class="btn sm" @click="j.state = '可用'">入可用池</button><button v-if="j.state !== '已淘汰'" class="btn sm" @click="j.state = '已淘汰'">淘汰</button></td></tr>
      </tbody></table></div>
      <p class="muted sm">同一商品不同账号各选一组；查重按图片内容（不是文件名 / URL）；整组观感要人看，Agent 只给候选。当前这件货的图池是演示，真图从 WMS / 图片服务来。</p>
    </section>

    <section class="card wide">
      <h4>价格类型 · 采购衔接<Q k="ue-price" /> <small class="muted">挂牌 / 新品 / 回收 / 拍卖 / 成交分开；采购报价回原型号</small></h4>
      <div class="chips"><span class="tag">挂牌价</span><span class="tag">新品价</span><span class="tag">回收价</span><span class="tag">拍卖价</span><span class="tag">成交价</span></div>
      <p class="muted sm">这张卡现在显示的是「清洗平均挂牌价」；其余四种类型和原始页回看要 ERP / 爬虫接（E04）。采购参考价、授权上限、验货差异在「采购价格表」里。</p>
      <button class="btn sm" @click="goPrice">打开采购价格表 ›</button>
    </section>
  </div>
</template>

<script setup>
import { computed, reactive } from 'vue'
import Q from './Q.vue'
import { finalDb as db, unitOf } from './demoFinal.js'
import { toast } from './ui.js'

const props = defineProps({ sku: Object })
const u = computed(() => unitOf(props.sku.sku_code))
const jobs = computed(() => db.imageJobs)
const JS = { 待处理: 'amb', 已处理: 'acc', 可用: 'grn', 已淘汰: 'red' }
const name = () => localStorage.getItem('erp_user') || 'chenxm'
function submitSample() { u.value.sampleBy = name(); u.value.sampleAt = new Date().toISOString().slice(5, 10); toast('已提交主管核定（演示）') }
function clean(j) { j.state = '已处理'; j.after = '去水印版（演示）'; j.note = '原图保留；残留 / 画质待复核' ; toast('已处理，原图保留') }
function goPrice() { location.hash = '#/pricebook' }
void reactive
</script>

<style scoped>
.ue { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; } .wide { grid-column: 1 / -1; }
.card h4 { margin: 0 0 10px; font-size: 16px; } .card h4 small { font-weight: 400; }
.tf { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; } .tf label { display: grid; gap: 3px; font-size: 12px; color: var(--mute); } .tf input, .tf select { height: 34px; border: 1px solid var(--line); border-radius: 9px; padding: 0 9px; background: var(--soft); color: var(--ink); }
.widein { width: 100%; height: 36px; border: 1px solid var(--line); border-radius: 9px; padding: 0 10px; background: var(--soft); color: var(--ink); margin: 8px 0; } .ck { display: flex; gap: 8px; align-items: center; font-size: 13.5px; margin: 6px 0; } .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.thumb { width: 64px; height: 64px; border-radius: 10px; object-fit: cover; background: var(--soft); } .chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; } .ac { white-space: nowrap; } .sm { font-size: 12px; }
</style>
