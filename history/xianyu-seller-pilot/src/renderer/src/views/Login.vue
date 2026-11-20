<template>
  <div class="login-wrap">
    <div class="login-card">
      <img class="logo" :src="logoUrl" alt="" width="64" height="64" />
      <h2 class="title">卖家工作台</h2>
      <!-- 服务器地址不放在登录页（2026-10-06 用户要求）：员工不该看见、也不该去改它。
           真要换部署，在「库存商品」页的连接设置里改，本机模式也进得去。 -->
      <el-form label-position="top" @submit.prevent>
        <el-form-item label="账号">
          <el-input v-model="form.username" placeholder="你的员工账号" @keyup.enter="submit" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="form.password" type="password" show-password @keyup.enter="submit" />
        </el-form-item>
        <el-checkbox v-if="!isWeb" v-model="form.remember" class="remember">记住账号密码</el-checkbox>
        <el-button type="primary" :loading="loading" style="width: 100%" @click="submit">登 录</el-button>
        <el-button v-if="!isWeb" class="local-btn" :loading="localLoading" style="width: 100%" @click="enterLocal">直接使用本机 Excel</el-button>
      </el-form>
      <p class="tip">本机模式首次采集仍需在「账号绑定」登录闲鱼</p>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { landingPath } from '../menu.js'
import logoUrl from '../assets/logo.png'

const router = useRouter()
const loading = ref(false)
const localLoading = ref(false)
const isWeb = window.erp?.mode === 'web'
const form = reactive({ username: '', password: '', remember: true })

onMounted(async () => {
  const state = await window.erp.getAuthState()
  if (state.hasToken || state.localMode) return go(state)   // 已登录直接进控制台
  // 记住过就填好；从没选过默认勾上——工位机上每次重输密码，正是要省掉的事。
  // 人上次特意取消了勾选，就尊重那一次的选择，不每回又替他勾上。
  let saved = null
  if (!isWeb && window.erp.rememberedLogin) {
    try {
      saved = await window.erp.rememberedLogin()
    } catch {
      saved = null
    }
  }
  if (saved?.off) form.remember = false
  if (saved?.username) {
    form.username = saved.username
    form.password = saved.password || ''
  }
})

/**
 * 登录后去哪：**按角色算**，不能硬写死一个路径。
 *
 * 这里原本把 /tasks 写死在跳转里，而它在菜单中是管理员专属，
 * 于是非管理员账号登录成功 → 被路由守卫弹走 → 落地页算不出来就弹回登录页，
 * 看起来就是「登录成功了但没跳转」。2026-09-16 起登的是员工账号（销售/采购/
 * 管理员各一套菜单），非管理员是常态而不是例外，所以这条路每天都会踩。
 */
async function go(state = null) {
  const auth = state || (await window.erp.getAuthState())
  const target = landingPath(auth)
  if (!target) {
    // 不能静默停在登录页：那和「密码错了」在界面上长得一模一样。
    ElMessage.error(`当前账号（${auth?.staff?.role || '未知角色'}）没有可用页面，请联系管理员调整权限`)
    return
  }
  router.replace(target)
}

async function submit() {
  if (!form.username || !form.password) {
    ElMessage.warning('请填写账号和密码')
    return
  }
  loading.value = true
  try {
    // 不送服务器地址：主进程用保存着的那个（默认 http://127.0.0.1:8000）。
    const payload = { username: form.username, password: form.password }
    if (!isWeb) payload.remember = form.remember
    const res = await window.erp.login(payload)
    if (res.ok) {
      if (form.remember && !isWeb && !res.passwordSaved) {
        ElMessage.info('这台电脑没法加密保存密码，只记住了账号')
      } else {
        ElMessage.success('登录成功')
      }
      await go()
    } else {
      ElMessage.error(res.reason || '登录失败')
    }
  } finally {
    loading.value = false
  }
}

async function enterLocal() {
  localLoading.value = true
  try {
    await window.erp.enterLocalMode()
    await go()
  } catch (error) {
    ElMessage.error(error?.message || '进入本机模式失败：本地配置写入失败')
  } finally {
    localLoading.value = false
  }
}
</script>

<style scoped>
.logo { display: block; width: 64px; height: 64px; margin: 0 auto 10px; object-fit: contain; }
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
/* margin-left: Element 给相邻按钮自动加 12px 左距，这颗按钮因此一直往右偏 */
.local-btn { margin-top: 10px; margin-left: 0; }
.remember { margin: -4px 0 12px; }
.tip { margin: 16px 0 0; color: #a8abb2; font-size: 12px; line-height: 1.6; text-align: center; }
</style>
