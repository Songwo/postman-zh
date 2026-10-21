@echo off
chcp 65001 >nul
setlocal
title Postman 汉化 - 卸载
cd /d "%~dp0"

set "RUNNER="
for /d %%D in ("%LOCALAPPDATA%\Postman\app-*") do if exist "%%D\Postman.exe" set "RUNNER=%%D\Postman.exe"
if not defined RUNNER (
  where node >nul 2>nul && set "RUNNER=node"
)
if not defined RUNNER (
  echo 没有找到 Postman。
  pause
  exit /b 1
)

set "ELECTRON_RUN_AS_NODE=1"
"%RUNNER%" "%~dp0installer\cli.js" uninstall %*
set "ELECTRON_RUN_AS_NODE="
echo.
pause
