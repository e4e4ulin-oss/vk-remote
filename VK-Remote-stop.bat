@echo off
chcp 65001 >nul
curl.exe -s -m 3 -X POST -H "X-VKR: 1" http://127.0.0.1:8765/shutdown >nul 2>nul
if errorlevel 1 (echo VK Remote не был запущен.) else (echo VK Remote остановлен.)
timeout /t 2 >nul
