@echo off
setlocal
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo [错误] 请先安装 Node.js 20 或更高版本。
  echo 下载地址：https://nodejs.org/
  pause
  exit /b 1
)

if not exist node_modules (
  echo 首次运行，正在安装依赖...
  call npm install
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

start "3D 导演台服务" cmd /k "npm run dev -- --host 127.0.0.1 --port 5173"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:5173/"
endlocal
