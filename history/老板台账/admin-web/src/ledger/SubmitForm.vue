<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api, { errText } from './api'
import { useDesktop } from './useDesktop'

const isDesktop = useDesktop()

const EMPTY = {
  legal_person_name: '', legal_person_phone: '', legal_person_email: '',
  entity_name: '', entity_type: 'individual', credit_code: '',
  alipay_account: '', shop_platform: 'xianyu', shop_name: '', note: '',
}
const form = ref({ ...EMPTY })
const opts = ref({ entity_types: {}, platforms: {} })
const saving = ref(false)

onMounted(async () => {
  try {
    opts.value = (await api.get('/ledger/options')).data
  } catch {
    /* 下拉用不了就只剩默认值，不挡填写 */
  }
})

async function save() {
  saving.value = true
  try {
    await api.post('/ledger/submit', form.value)
    ElMessage.success('已提交。提交后你自己也看不到这条')
    form.value = { ...EMPTY }
  } catch (err) {
    ElMessage.error(errText(err, '提交失败'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <!-- 电脑：一张多栏表单，法人 / 主体 / 支付宝 / 店铺 一段一行 -->
  <div v-if="isDesktop" class="lgd-card d-form">
    <div class="lgd-card__head">
      <h3 class="lgd-card__title">填报一条 <small>法人 → 主体 → 支付宝 → 店铺，提交后你自己也看不到这条</small></h3>
    </div>
    <div class="lgd-card__body">
      <el-form label-position="top" @submit.prevent>
        <div class="d-sec">
          <div class="d-sec__name">法人</div>
          <el-row :gutter="20" class="d-sec__fields">
            <el-col :span="8"><el-form-item label="姓名（必填）"><el-input v-model="form.legal_person_name" /></el-form-item></el-col>
            <el-col :span="8"><el-form-item label="主设备手机号"><el-input v-model="form.legal_person_phone" inputmode="tel" /></el-form-item></el-col>
            <el-col :span="8"><el-form-item label="主邮箱"><el-input v-model="form.legal_person_email" inputmode="email" /></el-form-item></el-col>
          </el-row>
        </div>
        <div class="d-sec">
          <div class="d-sec__name">主体</div>
          <el-row :gutter="20" class="d-sec__fields">
            <el-col :span="8"><el-form-item label="名称（营业执照上的）"><el-input v-model="form.entity_name" /></el-form-item></el-col>
            <el-col :span="8">
              <el-form-item label="类型">
                <el-radio-group v-model="form.entity_type">
                  <el-radio v-for="(label, key) in opts.entity_types" :key="key" :value="key">{{ label }}</el-radio>
                </el-radio-group>
              </el-form-item>
            </el-col>
            <el-col :span="8"><el-form-item label="统一社会信用代码"><el-input v-model="form.credit_code" /></el-form-item></el-col>
          </el-row>
        </div>
        <div class="d-sec">
          <div class="d-sec__name">支付宝</div>
          <el-row :gutter="20" class="d-sec__fields">
            <el-col :span="8"><el-form-item label="登录账号（邮箱或手机号）"><el-input v-model="form.alipay_account" /></el-form-item></el-col>
          </el-row>
        </div>
        <div class="d-sec">
          <div class="d-sec__name">店铺</div>
          <el-row :gutter="20" class="d-sec__fields">
            <el-col :span="8">
              <el-form-item label="平台">
                <el-radio-group v-model="form.shop_platform">
                  <el-radio v-for="(label, key) in opts.platforms" :key="key" :value="key">{{ label }}</el-radio>
                </el-radio-group>
              </el-form-item>
            </el-col>
            <el-col :span="8"><el-form-item label="店铺名"><el-input v-model="form.shop_name" /></el-form-item></el-col>
          </el-row>
        </div>
        <div class="d-sec">
          <div class="d-sec__name">备注</div>
          <el-row :gutter="20" class="d-sec__fields">
            <el-col :span="16"><el-form-item><el-input v-model="form.note" type="textarea" :rows="2" /></el-form-item></el-col>
          </el-row>
        </div>
        <div class="d-foot">
          <el-button type="primary" :loading="saving" @click="save">提交</el-button>
        </div>
      </el-form>
    </div>
  </div>

  <!-- 手机：原样 -->
  <template v-else>
    <div class="lg-card">
      <el-form class="lg-form" label-position="top" @submit.prevent>
        <div class="lg-section">法人</div>
        <el-form-item label="姓名（必填）"><el-input v-model="form.legal_person_name" /></el-form-item>
        <el-form-item label="主设备手机号"><el-input v-model="form.legal_person_phone" inputmode="tel" /></el-form-item>
        <el-form-item label="主邮箱"><el-input v-model="form.legal_person_email" inputmode="email" /></el-form-item>

        <div class="lg-section">主体</div>
        <el-form-item label="名称（营业执照上的）"><el-input v-model="form.entity_name" /></el-form-item>
        <el-form-item label="类型">
          <el-radio-group v-model="form.entity_type">
            <el-radio v-for="(label, key) in opts.entity_types" :key="key" :value="key">{{ label }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="统一社会信用代码"><el-input v-model="form.credit_code" /></el-form-item>

        <div class="lg-section">支付宝</div>
        <el-form-item label="登录账号（邮箱或手机号）"><el-input v-model="form.alipay_account" /></el-form-item>

        <div class="lg-section">店铺</div>
        <el-form-item label="平台">
          <el-radio-group v-model="form.shop_platform">
            <el-radio v-for="(label, key) in opts.platforms" :key="key" :value="key">{{ label }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="店铺名"><el-input v-model="form.shop_name" /></el-form-item>

        <el-form-item label="备注"><el-input v-model="form.note" type="textarea" :rows="2" /></el-form-item>
        <el-button type="primary" size="large" style="width: 100%" :loading="saving" @click="save">提交</el-button>
      </el-form>
    </div>
  </template>
</template>

<style scoped>
.d-form { max-width: 1200px; }
.d-sec { display: flex; gap: 24px; padding: 6px 0 2px; border-bottom: 1px dashed var(--lgd-line); }
.d-sec__name { width: 64px; flex-shrink: 0; padding-top: 38px; font-weight: 600; color: var(--lg-ink-2); font-size: 13px; }
.d-sec__fields { flex: 1; min-width: 0; padding-top: 12px; }
.d-sec__fields :deep(.el-form-item) { margin-bottom: 14px; }
.d-foot { display: flex; justify-content: flex-end; padding-top: 16px; }
.d-foot .el-button { min-width: 120px; }
</style>
