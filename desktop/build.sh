#!/bin/bash
# 构建 macOS 桌面应用：编 Swift 壳 + 打包 web 资源 + 生成 .app
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS="$(cd "$ROOT/.." && pwd)"
APP="${SKILL_FORGE_APP_PATH:-$TOOLS/技能锻造台.app}"
BUILD="$ROOT/desktop/.build"
if [ -z "${SKILL_FORGE_SDK:-}" ]; then
  for candidate in MacOSX26.5.sdk MacOSX26.sdk MacOSX15.4.sdk; do
    if [ -d "/Library/Developer/CommandLineTools/SDKs/$candidate" ]; then
      SKILL_FORGE_SDK="/Library/Developer/CommandLineTools/SDKs/$candidate"
      break
    fi
  done
fi
SDK="${SKILL_FORGE_SDK:-$(xcrun --show-sdk-path)}"

echo "▸ root  $ROOT"
echo "▸ app   $APP"

rm -rf "$BUILD"
mkdir -p "$BUILD"

HOST_ARCH="$(uname -m)"
case "$HOST_ARCH" in
  arm64) TARGET="arm64-apple-macos13.0" ;;
  x86_64) TARGET="x86_64-apple-macos13.0" ;;
  *) echo "不支持的 CPU 架构：$HOST_ARCH"; exit 1 ;;
esac

echo "▸ compile SkillForge.swift ($HOST_ARCH)"
swiftc -swift-version 5 \
  -sdk "$SDK" \
  -target "$TARGET" \
  "$ROOT/desktop/SkillForge.swift" \
  -o "$BUILD/SkillForge" \
  -framework Cocoa -framework WebKit -O

echo "▸ assemble bundle"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"
cp "$BUILD/SkillForge" "$APP/Contents/MacOS/SkillForge"
cp "$ROOT/desktop/Info.plist" "$APP/Contents/Info.plist"
if [ -f "$ROOT/desktop/AppIcon.icns" ]; then
  cp "$ROOT/desktop/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
fi

rsync -a --delete \
  --exclude '.DS_Store' \
  "$ROOT/server.mjs" \
  "$ROOT/package.json" \
  "$ROOT/lib" \
  "$ROOT/public" \
  "$ROOT/samples" \
  "$APP/Contents/Resources/app/"

echo "▸ sign (ad-hoc)"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true

echo "▸ done"
du -sh "$APP"
