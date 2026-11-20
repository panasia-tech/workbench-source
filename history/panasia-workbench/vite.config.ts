import path from 'path';
import type { PluginOption } from 'vite';
import { defineConfig } from '@lark-apaas/coding-preset-vite-react';

// 全栈形态（妙搭 archType 3，妙搭沙箱会注入，独立部署自己补）：
// 开发时 vite 把 /api、页面请求反代到 Nest，构建时把 index.html 放到 dist/client/ 给 Nest 渲染
process.env.MIAODA_APP_TYPE ??= '3';

// 独立部署不挂字节跳动的前端埋点（Slardar 监控 / Tea 统计 / performance 脚本），浏览器不再往外报数据
const DROPPED_PLUGINS = new Set(['miaoda-slardar']);

function keepPlugin(plugin: PluginOption): boolean {
  if (plugin && typeof plugin === 'object' && 'name' in plugin) {
    return !DROPPED_PLUGINS.has(plugin.name);
  }
  return true;
}

const config = defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'client/src'),
    },
  },
});
config.plugins = (config.plugins ?? []).filter(keepPlugin);

export default config;
