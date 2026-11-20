<script setup>
// 工信部备案号。
//
// # 为什么必须有
//
// 备案号要在网站首页底部展示、并链到 beian.miit.gov.cn，这是备案本身的条件，
// 不是装饰。通信管理局的抽查是直接访问域名根路径——2026-09-17 起根路径 301 到
// /console/，所以「首页」实际上就是这个后台的登录页，那一页必须挂住它。
//
// # 为什么做成组件
//
// 登录页和侧栏底部都要挂。号码写两遍就会有一天只改一遍，而改错的那一遍谁也不会
// 去看。号码只在这个文件里出现一次。
//
// # 深色专用
//
// 两个挂载点的背景都是深色（登录页的渐变、侧栏的 --brand-dark），所以这里只按
// 浅字配色。挪到浅色底之前先改这里，别就地覆盖。
</script>

<template>
  <div class="beian">
    <a
      class="beian-link"
      href="https://beian.miit.gov.cn/"
      target="_blank"
      rel="noopener noreferrer"
    >浙ICP备2026010391号-2</a>
  </div>
</template>

<style scoped>
.beian {
  text-align: center;
  font-size: 12px;
  line-height: 1.6;
}

.beian-link {
  color: rgba(255, 255, 255, 0.45);
  text-decoration: none;
}

.beian-link:hover {
  color: rgba(255, 255, 255, 0.75);
}
</style>
