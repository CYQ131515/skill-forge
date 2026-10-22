#!/bin/bash
# 构建 Universal macOS 安装包并生成 SHA-256，供 GitHub Release 上传。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
VERSION="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$ROOT/package.json','utf8')).version)")"
APP="$DIST/技能锻造台.app"
ZIP_NAME="SkillForge-macos-universal.zip"
ZIP="$DIST/$ZIP_NAME"

rm -rf "$DIST"
mkdir -p "$DIST"

echo "▸ build universal app (v$VERSION)"
SKILL_FORGE_UNIVERSAL=1 SKILL_FORGE_APP_PATH="$APP" "$ROOT/desktop/build.sh"

echo "▸ verify signature"
codesign --verify --deep --strict "$APP"
codesign -dv "$APP" 2>&1 | sed -n '1,6p'

echo "▸ strip metadata and zip"
xattr -cr "$APP" 2>/dev/null || true
ditto -c -k --keepParent --norsrc --noextattr "$APP" "$ZIP"
shasum -a 256 "$ZIP" | tee "$ZIP.sha256"

echo "▸ inspect"
ls -lh "$ZIP"
unzip -l "$ZIP" | head -12
echo ""
echo "asset: $ZIP"
echo "sha:   $ZIP.sha256"
