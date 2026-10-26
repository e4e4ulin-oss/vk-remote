@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title VK Remote
set "PORT=8765"
set "NODE_VER=22.22.0"

rem ---- Уже запущен? Тогда просто открываем страницу. ----
curl.exe -s -m 2 http://127.0.0.1:%PORT%/ping 2>nul | find "vk-remote" >nul
if not errorlevel 1 (
  echo VK Remote уже запущен, открываю страницу...
  start "" "http://127.0.0.1:%PORT%/setup"
  exit /b 0
)

rem ---- Node.js: портативный в папке runtime, иначе системный (18+), иначе скачиваем. ----
set "NODE=%~dp0runtime\node\node.exe"
if exist "%NODE%" goto :have_node

set "NODE=node"
node -e "process.exit(+process.versions.node.split('.')[0] < 18)" >nul 2>nul
if not errorlevel 1 goto :have_node

set "ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"
set "PKG=node-v%NODE_VER%-win-%ARCH%"
echo.
echo  Первый запуск: скачиваю Node.js (~30 МБ) в папку runtime...
echo.
if not exist runtime mkdir runtime
curl.exe -fL --progress-bar -o "runtime\node.zip" "https://nodejs.org/dist/v%NODE_VER%/%PKG%.zip"
if errorlevel 1 goto :fail
echo  Распаковываю...
tar -xf "runtime\node.zip" -C runtime
if errorlevel 1 goto :fail
if exist "runtime\node" rmdir /s /q "runtime\node"
move "runtime\%PKG%" "runtime\node" >nul
del "runtime\node.zip"
set "NODE=%~dp0runtime\node\node.exe"
if not exist "%NODE%" goto :fail
echo  Готово.

:have_node
rem ---- Ярлык на рабочем столе (один раз). ----
if not exist "runtime\shortcut-done" (
  if not exist runtime mkdir runtime
  set "VKR_BAT=%~f0"
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\VK Remote.lnk'); $s.TargetPath=$env:VKR_BAT; $s.WorkingDirectory=(Split-Path $env:VKR_BAT); $s.IconLocation='shell32.dll,168'; $s.Save()" >nul 2>nul
  echo.> "runtime\shortcut-done"
)

rem ---- Запуск сервера; он сам откроет страницу http://127.0.0.1:%PORT%/setup ----
set "VK_REMOTE_OPEN=1"
"%NODE%" server.js
echo.
echo Сервер остановлен.
pause
exit /b 0

:fail
echo.
echo  Не получилось скачать Node.js. Проверь интернет или поставь Node.js LTS вручную: https://nodejs.org
echo  и запусти этот файл ещё раз.
pause
exit /b 1
