#!/bin/zsh

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIRECTOR_URL="http://127.0.0.1:5173/"
LOG_FILE="/tmp/3d-director-desk.log"

if ! command -v npm >/dev/null 2>&1; then
  osascript -e 'display alert "无法启动 3D 导演台" message "请先安装 Node.js 20 或更高版本。" as critical'
  exit 1
fi

cd "$PROJECT_DIR" || exit 1

if [ ! -d node_modules ]; then
  npm install || exit 1
fi

if ! curl --noproxy "*" --silent --fail --max-time 2 "$DIRECTOR_URL" >/dev/null 2>&1; then
  nohup npm run dev -- --host 127.0.0.1 --port 5173 >"$LOG_FILE" 2>&1 &

  for _ in {1..30}; do
    if curl --noproxy "*" --silent --fail --max-time 1 "$DIRECTOR_URL" >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
fi

open "$DIRECTOR_URL"
