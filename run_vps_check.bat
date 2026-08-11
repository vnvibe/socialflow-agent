@echo off
echo ========================================================
echo   Uploading diagnostics script to VPS...
echo ========================================================
scp -i "C:\Users\1phut\.ssh\socialflow_deploy" -o StrictHostKeyChecking=no check_hermes_vps.sh root@103.142.24.60:/root/check_hermes_vps.sh
if %errorlevel% neq 0 (
    echo [ERROR] Failed to upload script to VPS. Check network or SSH key.
    pause
    exit /b %errorlevel%
)

echo ========================================================
echo   Running diagnostics script on VPS...
echo ========================================================
ssh -i "C:\Users\1phut\.ssh\socialflow_deploy" -o StrictHostKeyChecking=no root@103.142.24.60 "chmod +x /root/check_hermes_vps.sh && bash /root/check_hermes_vps.sh"
if %errorlevel% neq 0 (
    echo [ERROR] Failed to execute script on VPS.
)
pause
