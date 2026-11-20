<template>
  <div class="login-wrap">
    <div class="login-card">
      <h2 class="title">闲鱼行情爬虫</h2>
      <p class="sub">CRAWLER 账号登录</p>
      <el-form label-position="top" @submit.prevent>
        <el-form-item label="账号">
          <el-input v-model="form.username" placeholder="crawler01" @keyup.enter="submit" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="form.password" type="password" show-password @keyup.enter="submit" />
        </el-form-item>
        <el-button type="primary" :loading="loading" style="width: 100%" @click="submit">登 录</el-button>
      </el-form>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'

const router = useRouter()
const loading = ref(false)
const form = reactive({ username: '', password: '' }) // 服务器地址写死在主进程，用户不可见

onMounted(async () => {
  const state = await window.erp.getAuthState()
  if (state.hasToken) router.replace('/accounts') // 已登录直接进控制台
})

async function submit() {
  if (!form.username || !form.password) {
    ElMessage.warning('请填写账号和密码')
    return
  }
  loading.value = true
  try {
    const res = await window.erp.login({ ...form })
    if (res.ok) {
      ElMessage.success('登录成功')
      router.replace('/accounts')
    } else {
      ElMessage.error(res.reason || '登录失败')
    }
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-wrap {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #1d2b64 0%, #2b5876 100%);
}
.login-card {
  width: 360px;
  padding: 32px 32px 28px;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
}
.title { margin: 0 0 4px; text-align: center; color: #1f2d3d; }
.sub { margin: 0 0 20px; text-align: center; color: #909399; font-size: 13px; }
</style>
