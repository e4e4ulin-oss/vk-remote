@echo off
chcp 65001 >nul
setlocal
title Установка пульта для музыки ВК
set "VKR=%LOCALAPPDATA%\VKRemote"
set "NODE_VER=22.22.0"
set "REPO_ZIP=https://github.com/e4e4ulin-oss/vk-remote/archive/refs/heads/main.zip"

echo.
echo  Устанавливаю пульт для музыки ВК. Это займёт минуту-две.
echo  Папка: %VKR%
echo.
if not exist "%VKR%\runtime" mkdir "%VKR%\runtime"

rem ---- 1. Node.js (портативный, без установки и без прав администратора) ----
set "NODE=%VKR%\runtime\node\node.exe"
if exist "%NODE%" goto :have_node
set "ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"
set "PKG=node-v%NODE_VER%-win-%ARCH%"
echo  [1/3] Скачиваю Node.js (~30 МБ)...
curl.exe -fL --progress-bar -o "%VKR%\runtime\node.zip" "https://nodejs.org/dist/v%NODE_VER%/%PKG%.zip"
if errorlevel 1 goto :fail
tar -xf "%VKR%\runtime\node.zip" -C "%VKR%\runtime"
if errorlevel 1 goto :fail
if exist "%VKR%\runtime\node" rmdir /s /q "%VKR%\runtime\node"
move "%VKR%\runtime\%PKG%" "%VKR%\runtime\node" >nul
del "%VKR%\runtime\node.zip"
if not exist "%NODE%" goto :fail
:have_node

rem ---- 2. Сама программа (последняя версия с GitHub) ----
echo  [2/3] Скачиваю программу...
curl.exe -fsSL -o "%VKR%\runtime\app.zip" "%REPO_ZIP%"
if errorlevel 1 goto :fail
if exist "%VKR%\app\server.js" "%NODE%" "%VKR%\app\server.js" --stop >nul 2>nul
if exist "%VKR%\runtime\vk-remote-main" rmdir /s /q "%VKR%\runtime\vk-remote-main"
tar -xf "%VKR%\runtime\app.zip" -C "%VKR%\runtime"
if errorlevel 1 goto :fail
if exist "%VKR%\app" rmdir /s /q "%VKR%\app"
move "%VKR%\runtime\vk-remote-main" "%VKR%\app" >nul
del "%VKR%\runtime\app.zip"
if not exist "%VKR%\app\server.js" goto :fail

rem ---- 3. Брандмауэр, ярлык на рабочем столе, первый запуск ----
echo  [3/3] Настраиваю...
"%NODE%" "%VKR%\app\server.js" --install --data "%VKR%"
if errorlevel 1 goto :fail_start

echo.
echo  Готово! На рабочем столе появился ярлык «Управлять музыкой через ВК».
echo  Сейчас откроется окно VK (войди в аккаунт один раз) и страница с QR-кодом для телефона.
echo.
timeout /t 8 >nul
exit /b 0

:fail
echo.
echo  Не получилось скачать файлы. Проверь интернет и запусти этот файл ещё раз.
pause
exit /b 1

:fail_start
echo.
echo  Пульт не запустился. Лог: %VKR%\runtime\server.log
if exist "%VKR%\runtime\server.log" type "%VKR%\runtime\server.log"
pause
exit /b 1
