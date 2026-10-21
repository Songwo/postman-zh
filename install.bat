@echo off
chcp 65001 >nul
setlocal
title Postman 汉化 - 安装
cd /d "%~dp0"

rem 优先使用 Postman 自带的 Electron 当作 Node 运行（用户无需安装 Node.js）
set "RUNNER="
for /d %%D in ("%LOCALAPPDATA%\Postman\app-*") do if exist "%%D\Postman.exe" set "RUNNER=%%D\Postman.exe"
if not defined RUNNER (
  where node >nul 2>nul && set "RUNNER=node"
)
if not defined RUNNER (
  echo 没有找到 Postman，请先安装 Postman 桌面版：https://www.postman.com/downloads/
  pause
  exit /b 1
)

set "ELECTRON_RUN_AS_NODE=1"
"%RUNNER%" "%~dp0installer\cli.js" install %*
set "ELECTRON_RUN_AS_NODE="
echo.
pause
