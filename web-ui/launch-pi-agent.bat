@echo off
title PI Agent - Web UI
:: PI Agent Web UI Launcher  -  Drop on desktop, double-click to launch
cd /d "E:\pi-windows-x64\web-ui"

echo.
echo    PI Agent
echo    =========
echo.
echo    Stopping any running instance...
for /f "tokens=5" %%a in ('netstat -ano ^| find ":3003" ^| find "LISTENING"') do (
    taskkill /f /pid %%a >nul 2>&1
)
timeout /t 1 >nul

echo    Starting server, one moment...
echo    http://localhost:3003
echo.
echo    Press Ctrl+C to stop
echo.
start http://localhost:3003
E:\nodejs\node.exe server.js
