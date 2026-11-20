#!/usr/bin/env bash
# 独立部署构建。原文件由妙搭 fullstack-cli 生成，依赖平台命令行（fullstack-cli、
# generate-api-routes、generate-page-routes），外面跑不了，已改写。
#
# 产物都在 dist/，从项目根目录运行 `node dist/server/main.js`：
#   dist/server/   Nest 服务端（swc 编译）
#   dist/shared/   前后端共享代码
#   dist/client/   前端：index.html（Nest 用 hbs 渲染）+ assets/（服务端 /assets/ 直接出）+ public 下的文件
#
# 妙搭构建里的另外几步这里不做：
#   - action-plugin init：平台插件（飞书通知、AI 文本生成）已换成直连或没在用
#   - generate-api-routes / generate-page-routes：只给前端埋点做路由归类，缺了不影响功能
#   - prune-smart：依赖裁剪要 @vercel/nft，Docker 镜像里直接用完整 node_modules
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# 给构建子进程预留 8GB heap，缓解 vite build transform 阶段 OOM；外部设了 NODE_OPTIONS 就用外部的
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"

echo "[1/3] 清理 dist/"
rm -rf dist

echo "[2/3] 构建服务端"
npm run build:server

# 前端要在服务端之后：全栈插件会把 server/mcp/skills 同步进 dist/server/mcp
echo "[3/3] 构建前端"
npm run build:client

# 全栈插件会把 index.html 挪到 dist/client/；万一没挪，这里兜底
if [ -f dist/client/client/index.html ] && [ ! -f dist/client/index.html ]; then
  mv dist/client/client/index.html dist/client/index.html
  rmdir dist/client/client 2>/dev/null || true
fi
if [ ! -f dist/client/index.html ]; then
  echo "构建失败：没有生成 dist/client/index.html" >&2
  exit 1
fi
rm -f dist/tsconfig.node.tsbuildinfo

echo "构建完成：dist/ $(du -sh dist | cut -f1)"
