#!/bin/bash
# 双击启动技能锻造台：起本地服务并打开浏览器。
cd "$(dirname "$0")" || exit 1
PORT="${SKILL_FORGE_PORT:-4318}"
URL="http://127.0.0.1:${PORT}"

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ] && [ -x "$HOME/.local/bin/node" ]; then NODE_BIN="$HOME/.local/bin/node"; fi
if [ -z "$NODE_BIN" ] && [ -x "/opt/homebrew/bin/node" ]; then NODE_BIN="/opt/homebrew/bin/node"; fi
if [ -z "$NODE_BIN" ] && [ -x "/usr/local/bin/node" ]; then NODE_BIN="/usr/local/bin/node"; fi
if [ -z "$NODE_BIN" ]; then
  echo "没有找到 node。请先安装 Node.js 20+，或把 node 加入 PATH。"
  read -r -p "按回车关闭…"
  exit 1
fi

echo ""
echo "  SKILL FORGE · 技能锻造台"
echo "  → ${URL}"
echo "  关闭此终端窗口即停止服务。"
echo ""
(sleep 1.2 && open "${URL}") &
exec "$NODE_BIN" server.mjs
