<!--
  运维：浏览器环境、账号绑定、机器现状、爬虫开关，合成一页四个标签。

  # 为什么合并

  这四页原来在侧栏各占一行，而且名字互相重叠——「设备与账号：哪台机器在跑哪个号」
  「账号绑定：哪个闲鱼号用哪个浏览器」「浏览器环境：每个号一个独立浏览器」，
  三句话对管理员来说几乎是同一句。侧栏九项里四项是运维管道，日常干活的反而
  被挤到下半截。

  合并之后侧栏少四行，而且这四件事本来就是一条链：建环境 → 定用途 → 登号 →
  绑到店铺 → 看它在哪台机器上跑。做完一步接着做下一步，切标签比回侧栏近。

  # 为什么是标签不是长页

  堆成一页会更长，而「页面太长、找东西费劲」正是要治的毛病。标签让每一屏只装
  一件事，进来看到的就是完整的一件事，不用滚。
-->
<template>
  <div class="ops page">
    <el-tabs v-model="tab" class="ops-tabs page-tabs">
      <el-tab-pane label="浏览器环境" name="envs">
        <p class="lead">建环境、定用途、配代理、登闲鱼号。一个号一个独立浏览器。</p>
        <Envs v-if="loaded.envs" />
      </el-tab-pane>
      <el-tab-pane label="账号绑定" name="accounts">
        <p class="lead">哪个闲鱼号用哪个浏览器环境。</p>
        <Accounts v-if="loaded.accounts" />
      </el-tab-pane>
      <el-tab-pane label="机器现状" name="units">
        <p class="lead">每个账号当前挂在哪台机器上、今天的配额用了多少、有没有在跑任务。冻住的号在这里解冻。</p>
        <Units v-if="loaded.units" />
      </el-tab-pane>
      <el-tab-pane label="爬虫开关" name="crawlers">
        <p class="lead">行情爬虫和图片爬虫分别在哪台电脑上跑。同一个爬虫同时只能有一台。</p>
        <Crawlers v-if="loaded.crawlers" />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup>
import { reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Envs from './Envs.vue'
import Accounts from './Accounts.vue'
import Units from './Units.vue'
import Crawlers from './Crawlers.vue'

const TABS = ['envs', 'accounts', 'units', 'crawlers']
const route = useRoute()
const router = useRouter()

const tab = ref(TABS.includes(route.query.tab) ? route.query.tab : 'envs')

// 每个标签只在第一次点开时挂载，之后留着不卸。
// 不预挂：这几页各自都要轮询（机器现状 10 秒一拍、爬虫开关跟着心跳），
// 一进来就把四份轮询全开起来，等于为看一眼环境列表付了四倍的请求。
// 挂过不卸：来回切标签时不该重新加载一遍，那会让人以为点错了。
const loaded = reactive({ envs: tab.value === 'envs', accounts: false, units: false, crawlers: false })
watch(tab, (v) => {
  loaded[v] = true
  // 把当前标签写进地址：刷新、或者从别处跳「去配一下环境」时能直接落到那一屏
  router.replace({ query: { ...route.query, tab: v } })
}, { immediate: true })
</script>

<style scoped>
.ops { --muted: #7c8983; }
/* 每个标签内部自己滚，整页不滚——四个标签里装的都是会长的列表 */
.ops-tabs :deep(.el-tab-pane) { display: flex; flex-direction: column; min-height: 0; height: 100%; overflow-y: auto; }
.ops-tabs :deep(.el-tabs__header) { margin-bottom: 14px; }
.ops-tabs :deep(.el-tabs__item) { font-size: 14px; font-weight: 600; }
.lead { margin: 0 0 14px; color: var(--muted); font-size: 12.5px; line-height: 1.6; }
</style>
