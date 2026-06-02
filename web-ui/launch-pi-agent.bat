@echo off
title PI Agent
:: PI Agent Desktop Launcher - Standalone window, no browser chrome
cd /d "E:\pi-windows-x64\web-ui"

:: Kill any existing instance on port 3003
for /f "tokens=5" %%a in ('netstat -ano ^| find ":3003" ^| find "LISTENING"') do (
    taskkill /f /pid %%a >nul 2>&1
)
timeout /t 1 >nul

echo Starting PI Agent...
start "" E:\nodejs\node.exe server.js

:: Wait for server to be ready
:wait
timeout /t 1 >nul
curl -s -o nul http://localhost:3003 2>nul
if errorlevel 1 goto wait

:: Launch Edge in app mode - standalone window, no tabs, no address bar
start "" msedge --app=http://localhost:3003 --new-window --no-first-run --disable-session-crashed-bubble
