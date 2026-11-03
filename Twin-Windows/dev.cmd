@echo off
setlocal enabledelayedexpansion

title Twin Desktop (Development Mode)
echo ========================================================
echo   Starting Twin Desktop (Development Mode)
echo ========================================================

cd /d "%~dp0"

:: Set Cargo environment paths
if exist "T:\DevLibs\cargo" set "CARGO_HOME=T:\DevLibs\cargo"
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

:: Automatically free port 1420 if previously occupied by a dangling process
for /f "tokens=5" %%a in ('netstat -aon ^| findstr /r ":1420[ ]" ^| findstr "LISTENING"') do (
    echo Freeing port 1420 (PID %%a)...
    taskkill /f /pid %%a >nul 2>&1
)

:: Launch Tauri Dev
call pnpm tauri dev

if %ERRORLEVEL% neq 0 (
    echo.
    echo Process exited with code %ERRORLEVEL%. Press any key to exit...
    pause >nul
)
