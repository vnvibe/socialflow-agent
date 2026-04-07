@echo off
chcp 65001 >nul 2>&1
title SocialFlow Agent - Setup
echo.
echo  ╔══════════════════════════════════════╗
echo  ║    SocialFlow Agent - Cai dat        ║
echo  ╚══════════════════════════════════════╝
echo.

:: Check Node.js
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [LOI] Chua cai Node.js!
    echo Tai tai: https://nodejs.org/
    echo Chon ban LTS roi cai dat, sau do chay lai file nay.
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('node -v') do echo [OK] Node.js %%i

:: Install dependencies
echo.
echo [1/3] Dang cai dat thu vien...
call npm install --production
if %ERRORLEVEL% NEQ 0 (
    echo [LOI] Cai dat that bai! Kiem tra ket noi mang.
    pause
    exit /b 1
)
echo [OK] Thu vien da cai xong.

:: Install Playwright browser
echo.
echo [2/3] Dang cai trinh duyet Chromium...
call npx playwright install chromium
echo [OK] Trinh duyet da cai xong.

:: Setup .env
echo.
echo [3/3] Cau hinh...
if not exist .env (
    copy .env.example .env >nul
    echo [OK] Da tao file .env tu .env.example
    echo.
    echo *** QUAN TRONG ***
    echo Mo file .env bang Notepad va dien:
    echo   - SUPABASE_SERVICE_ROLE_KEY
    echo   - SUPABASE_ANON_KEY
    echo.
    echo Sau khi dien xong, chay lai setup.bat hoac chay SocialFlowAgent.exe
    echo.
    notepad .env
    pause
    exit /b 0
) else (
    echo [OK] File .env da ton tai, giu nguyen.
)

echo.
echo ╔══════════════════════════════════════╗
echo ║    Cai dat hoan tat!                 ║
echo ║    Chay SocialFlowAgent.exe          ║
echo ║    hoac: node agent.js               ║
echo ╚══════════════════════════════════════╝
echo.
pause
