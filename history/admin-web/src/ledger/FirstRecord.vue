<script setup>
// 台账一个法人都没有时，管理员进来先走这里建第一条：法人 → 主体 →（收款）→（店铺），一次提交、要么都建要么都不建。
// 建完能直接点「授权对账」拿链接；点「进台账」回到平常的页面。
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api, { errText } from './api'
import AuthLinkDialog from './AuthLinkDialog.vue'

const emit = defineEmits(['done'])

const opts = ref({ entity_types: {}, platforms: {}, tax_payers: {}, tax_levies: {}, channels: {}, role_channels: {} })
const step = ref(0)
const saving = ref(false)
const lp = ref({ name: '', phone: '' })
const ent = ref({ name: '', entity_type: 'individual', tax_payer: 'small', tax_levy: 'audit' })
const pay = ref('alipay') // alipay 企业支付宝收款号 / other 不走支付宝 / later 先不填
const alipay = ref({ account: '' })
const withShop = ref(true)
const shop = ref({ platform: 'xianyu', name: '', channel: 'wechat', merchant_no: '' })
const made = ref(null)

const otherChannels = computed(() => (opts.value.role_channels.sales || []).filter((c) => c !== 'alipay'))
const isPerson = computed(() => ent.value.entity_type === 'person')

onMounted(async () => {
  try {
    opts.value = { ...opts.value, ...(await api.get('/ledger/options')).data }
  } catch (err) {
    ElMessage.error(errText(err, '加载失败'))
  }
})

function next() {
  if (step.value === 0 && (!lp.value.name.trim() || !lp.value.phone.trim())) {
    return ElMessage.warning('法人姓名和手机号都要填')
  }
  if (step.value === 1 && !ent.value.name.trim()) return ElMessage.warning('主体名称要填')
  if (step.value === 2 && pay.value === 'alipay' && !alipay.value.account.trim()) return ElMessage.warning('支付宝账号要填')
  step.value++
}

async function save() {
  if (withShop.value && pay.value !== 'later' && !shop.value.name.trim()) return ElMessage.warning('店铺名要填')
  const e = { ...ent.value }
  if (e.entity_type === 'company') e.tax_levy = 'audit'
  const body = { legal_person: lp.value, entity: e, alipay: pay.value === 'alipay' ? alipay.value : null, shop: null }
  if (withShop.value && pay.value !== 'later') {
    body.shop = { platform: shop.value.platform, name: shop.value.name }
    if (pay.value === 'other') Object.assign(body.shop, { channel: shop.value.channel, merchant_no: shop.value.merchant_no || null })
  }
  saving.value = true
  try {
    made.value = (await api.post('/ledger/first', body)).data
    step.value = 4
  } catch (err) {
    ElMessage.error(errText(err, '没建成'))
  } finally {
    saving.value = false
  }
}

const authDlg = ref(null)
const startAuth = () => authDlg.value.open(made.value.alipay_id, alipay.value.account)
</script>

<template>
  <div class="fr lg-card">
    <h2 class="fr-title">先建第一条台账</h2>
    <p class="lg-muted">台账还是空的。建好第一条才能用别的页面；别的法人、主体、店铺以后在「台账」里加。</p>
    <el-steps :active="step" finish-status="success" simple class="fr-steps">
      <el-step title="法人" />
      <el-step title="主体" />
      <el-step title="收款" />
      <el-step title="店铺" />
    </el-steps>

    <el-form label-position="top" class="fr-form" @submit.prevent>
      <template v-if="step === 0">
        <el-form-item label="法人姓名"><el-input v-model="lp.name" /></el-form-item>
        <el-form-item label="法人手机号"><el-input v-model="lp.phone" placeholder="姓名和手机号一起才认得出是同一个人" /></el-form-item>
      </template>

      <template v-else-if="step === 1">
        <el-form-item label="主体名称"><el-input v-model="ent.name" placeholder="营业执照上的名称；没执照的写这个人的名字" /></el-form-item>
        <el-form-item label="类型">
          <el-radio-group v-model="ent.entity_type">
            <el-radio v-for="(label, key) in opts.entity_types" :key="key" :value="key">{{ label }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <template v-if="!isPerson">
          <el-form-item label="纳税人">
            <el-radio-group v-model="ent.tax_payer">
              <el-radio v-for="(label, key) in opts.tax_payers" :key="key" :value="key">{{ label }}</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="征收方式">
            <el-radio-group v-model="ent.tax_levy">
              <el-radio v-for="(label, key) in opts.tax_levies" :key="key" :value="key" :disabled="key === 'assessed' && ent.entity_type === 'company'">{{ label }}</el-radio>
            </el-radio-group>
          </el-form-item>
        </template>
      </template>

      <template v-else-if="step === 2">
        <el-form-item label="卖货的钱收到哪">
          <el-radio-group v-model="pay" class="fr-col">
            <el-radio value="alipay">企业支付宝（收款号）</el-radio>
            <el-radio value="other">不走支付宝（微信小店、抖店……）</el-radio>
            <el-radio value="later">先不填</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="pay === 'alipay'" label="支付宝登录账号"><el-input v-model="alipay.account" /></el-form-item>
      </template>

      <template v-else-if="step === 3">
        <p v-if="pay === 'later'" class="lg-muted">没填收款，店铺以后挂到收款号或主体下面再加。</p>
        <template v-else>
          <el-form-item><el-checkbox v-model="withShop">现在加一家店</el-checkbox></el-form-item>
          <template v-if="withShop">
            <el-form-item label="平台">
              <el-select v-model="shop.platform" style="width: 100%">
                <el-option v-for="(label, key) in opts.platforms" :key="key" :label="label" :value="key" />
              </el-select>
            </el-form-item>
            <el-form-item label="店铺名"><el-input v-model="shop.name" /></el-form-item>
            <template v-if="pay === 'other'">
              <el-form-item label="结算方式">
                <el-select v-model="shop.channel" style="width: 100%">
                  <el-option v-for="c in otherChannels" :key="c" :label="opts.channels[c]" :value="c" />
                </el-select>
              </el-form-item>
              <el-form-item label="商户号"><el-input v-model="shop.merchant_no" placeholder="可以以后再填" /></el-form-item>
            </template>
          </template>
        </template>
      </template>

      <div v-else class="fr-done">
        <el-result icon="success" title="第一条建好了">
          <template #sub-title>
            <span v-if="made?.alipay_id">要对这个支付宝的账，点「授权对账」拿链接发给它的管理员。</span>
          </template>
          <template #extra>
            <el-button v-if="made?.alipay_id" @click="startAuth">授权对账</el-button>
            <el-button type="primary" @click="emit('done', made.legal_person_id)">进台账</el-button>
          </template>
        </el-result>
      </div>
    </el-form>

    <div v-if="step < 4" class="fr-foot">
      <el-button v-if="step > 0" @click="step--">上一步</el-button>
      <el-button v-if="step < 3" type="primary" @click="next">下一步</el-button>
      <el-button v-else type="primary" :loading="saving" @click="save">建好</el-button>
    </div>

    <AuthLinkDialog ref="authDlg" />
  </div>
</template>

<style scoped>
.fr { max-width: 560px; margin: 0 auto; }
.fr-title { margin: 0 0 4px; font-size: 20px; }
.fr-steps { margin: 14px 0; }
/* 手机上四步挤在一行，两个字的标题别被拆成两行 */
.fr-steps :deep(.el-step.is-simple .el-step__title) { max-width: none; word-break: keep-all; white-space: nowrap; }
.fr-form { margin-top: 8px; }
.fr-col { display: flex; flex-direction: column; align-items: flex-start; }
.fr-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
</style>
