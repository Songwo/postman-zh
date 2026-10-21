#!/usr/bin/env bash
# macOS / Linux 一键安装（卸载：./install.sh uninstall）
set -e
cd "$(dirname "$0")"
CMD="${1:-install}"
[ $# -gt 0 ] && shift

RUNNER=""
for p in "/Applications/Postman.app/Contents/MacOS/Postman" "$HOME/Applications/Postman.app/Contents/MacOS/Postman" \
         "/opt/Postman/app/Postman" "/opt/postman/app/Postman" "$HOME/Postman/app/Postman"; do
  [ -x "$p" ] && RUNNER="$p" && break
done
[ -z "$RUNNER" ] && command -v node >/dev/null 2>&1 && RUNNER="node"
if [ -z "$RUNNER" ]; then
  echo "没有找到 Postman，请先安装 Postman 桌面版：https://www.postman.com/downloads/"
  exit 1
fi

ELECTRON_RUN_AS_NODE=1 "$RUNNER" installer/cli.js "$CMD" "$@"

if [ "$(uname)" = "Darwin" ] && [ "$CMD" != "status" ]; then
  echo "提示：如果 macOS 提示“已损坏”，执行：sudo xattr -cr /Applications/Postman.app"
fi
