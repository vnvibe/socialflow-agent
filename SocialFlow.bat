@echo off
chcp 65001 >nul 2>&1
title SocialFlow Agent
cd /d "%~dp0"

echo.
echo   ====================================
echo      SocialFlow Agent
echo   ====================================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo   [!] Khong tim thay Node.js. Hay cai dat truoc.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo   [*] Cai dat dependencies...
    call npm install --production
    echo.
)

echo   Dang khoi dong agent...
echo.
node agent.js

echo.
echo   Agent da dung.
pause
