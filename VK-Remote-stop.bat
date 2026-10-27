@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "NODE=%~dp0runtime\node\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" server.js --stop >nul 2>nul
if errorlevel 1 (echo VK Remote не был запущен.) else (echo VK Remote остановлен.)
timeout /t 2 >nul
