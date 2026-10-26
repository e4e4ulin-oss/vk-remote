@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title VK Remote
set "PORT=8765"
set "NODE_VER=22.22.0"

rem ---- Уже запущен? Тогда просто открываем страницу. ----
call :ping
if not errorlevel 1 (
  start "" "http://127.0.0.1:%PORT%/setup"
  exit /b 0
)

rem ---- Node.js: портативный в папке runtime, иначе системный (18+), иначе скачиваем. ----
set "NODE=%~dp0runtime\node\node.exe"
if exist "%NODE%" goto :have_node

for /f "delims=" %%P in ('where node 2^>nul') do if not defined SYS_NODE set "SYS_NODE=%%P"
if defined SYS_NODE (
  "%SYS_NODE%" -e "process.exit(+process.versions.node.split('.')[0] < 18)" >nul 2>nul
  if not errorlevel 1 (
    set "NODE=%SYS_NODE%"
    goto :have_node
  )
)

set "ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"
set "PKG=node-v%NODE_VER%-win-%ARCH%"
echo.
echo  Первый запуск: скачиваю Node.js (~30 МБ) в папку runtime...
echo.
if not exist runtime mkdir runtime
curl.exe -fL --progress-bar -o "runtime\node.zip" "https://nodejs.org/dist/v%NODE_VER%/%PKG%.zip"
if errorlevel 1 goto :fail_node
echo  Распаковываю...
tar -xf "runtime\node.zip" -C runtime
if errorlevel 1 goto :fail_node
if exist "runtime\node" rmdir /s /q "runtime\node"
move "runtime\%PKG%" "runtime\node" >nul
del "runtime\node.zip"
set "NODE=%~dp0runtime\node\node.exe"
if not exist "%NODE%" goto :fail_node
echo  Готово.

:have_node
if not exist runtime mkdir runtime

rem ---- Ярлык на рабочем столе (запускается свёрнутым, чтобы окно не мелькало). ----
if not exist "runtime\shortcut-v2" (
  set "VKR_BAT=%~f0"
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\VK Remote.lnk'); $s.TargetPath=$env:VKR_BAT; $s.WorkingDirectory=(Split-Path $env:VKR_BAT); $s.IconLocation='shell32.dll,168'; $s.WindowStyle=7; $s.Save()" >nul 2>nul
  echo.> "runtime\shortcut-v2"
)

rem ---- Запуск сервера в фоне, без окна. Лог: runtime\server.log ----
set "VK_REMOTE_OPEN=1"
set "VK_REMOTE_LOG=%~dp0runtime\server.log"
set "VKR_NODE=%NODE%"
set "VKR_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath $env:VKR_NODE -ArgumentList 'server.js' -WorkingDirectory $env:VKR_DIR -WindowStyle Hidden"

rem ---- Ждём до 10 секунд, пока сервер ответит. ----
for /l %%i in (1,1,10) do (
  timeout /t 1 /nobreak >nul
  call :ping
  if not errorlevel 1 exit /b 0
)
echo.
echo  Сервер не запустился. Последние строки лога:
echo.
if exist "runtime\server.log" type "runtime\server.log"
pause
exit /b 1

:ping
curl.exe -s -m 2 http://127.0.0.1:%PORT%/ping 2>nul | find "vk-remote" >nul
exit /b %errorlevel%

:fail_node
echo.
echo  Не получилось скачать Node.js. Проверь интернет или поставь Node.js LTS вручную: https://nodejs.org
echo  и запусти этот файл ещё раз.
pause
exit /b 1
