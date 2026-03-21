@echo off
chcp 65001 >nul 2>&1
title SocialFlow Agent
cd /d "%~dp0"
color 0A

echo.
echo   ====================================
echo      SocialFlow Agent
echo   ====================================
echo.

:: Check config exists (config.env or .env or lib\config.js)
if not exist "config.env" if not exist ".env" if not exist "lib\config.js" (
    color 0C
    echo   [!] Thieu file cau hinh
    echo   Tai lai agent tu trang Cai dat.
    echo.
    pause
    exit /b
)

:: Use local node if available, otherwise system node
set "NODE=node"
set "NPM=npm"
set "NPX=npx"
if exist "node\node.exe" (
    set "NODE=%~dp0node\node.exe"
    set "NPM=%~dp0node\npm.cmd"
    set "NPX=%~dp0node\npx.cmd"
    set "PATH=%~dp0node;%PATH%"
)

:: Check Node.js (local or system)
"%NODE%" --version >nul 2>&1
if %errorlevel% neq 0 (
    echo   [*] Cai dat Node.js tu dong...
    echo.
    powershell -Command "& { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $url = 'https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip'; $out = 'node-portable.zip'; Write-Host '   Dang tai Node.js (~30MB)...'; (New-Object Net.WebClient).DownloadFile($url, $out); Write-Host '   [OK] Da tai xong' }"

    if not exist "node-portable.zip" (
        color 0C
        echo   [!] Khong the tai Node.js
        echo   Kiem tra ket noi mang roi thu lai.
        pause
        exit /b
    )

    echo   Giai nen...
    powershell -Command "Expand-Archive -Path 'node-portable.zip' -DestinationPath '.' -Force"
    if exist "node-v22.14.0-win-x64" ren "node-v22.14.0-win-x64" "node"
    del "node-portable.zip" 2>nul

    set "NODE=%~dp0node\node.exe"
    set "NPM=%~dp0node\npm.cmd"
    set "NPX=%~dp0node\npx.cmd"
    set "PATH=%~dp0node;%PATH%"
    echo   [OK] Node.js san sang
    echo.
)

:: Auto install/repair dependencies
if not exist "node_modules\@supabase" (
    if exist "node_modules" (
        echo   [*] Thu muc node_modules bi hong, cai lai...
        rmdir /s /q "node_modules" 2>nul
    ) else (
        echo   [*] Cai dat dependencies lan dau...
    )
    echo.
    echo   [1/2] npm install...
    call "%NPM%" install --production 2>nul
    if %errorlevel% neq 0 (
        color 0C
        echo   [!] Loi cai dat. Kiem tra mang roi thu lai.
        pause
        exit /b
    )
    echo.
    echo   [2/2] Cai trinh duyet Chromium (2-5 phut)...
    call "%NPX%" playwright install chromium 2>nul
    echo.
    echo   [OK] Cai dat hoan tat!
    echo.
)

:: Verify playwright browsers exist
if not exist "%LOCALAPPDATA%\ms-playwright" (
    if not exist "%USERPROFILE%\.cache\ms-playwright" (
        echo   [*] Cai trinh duyet Chromium...
        call "%NPX%" playwright install chromium 2>nul
        echo.
    )
)

:: Start agent (auto-restart on crash, max 5 times)
set "RESTART_COUNT=0"
:start_agent
echo   ------------------------------------
echo     Agent dang chay...
echo     Nhan Ctrl+C de dung
echo   ------------------------------------
echo.
"%NODE%" agent.js
set "EXIT_CODE=%errorlevel%"

:: If clean exit (Ctrl+C), don't restart
if %EXIT_CODE% equ 0 goto :end

:: Increment restart count
set /a RESTART_COUNT+=1
if %RESTART_COUNT% gtr 5 (
    color 0C
    echo.
    echo   [!] Agent bi loi qua 5 lan. Dung thu lai.
    echo   Bao loi cho admin de duoc ho tro.
    goto :end
)

echo.
echo   [!] Agent bi loi (code: %EXIT_CODE%). Thu lai lan %RESTART_COUNT%/5...
timeout /t 5 /nobreak >nul
goto :start_agent

:end
echo.
pause
