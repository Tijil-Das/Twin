@echo off
setlocal enabledelayedexpansion

title Twin Desktop (Development Mode)
echo ========================================================
echo   Starting Twin Desktop (Development Mode)
echo ========================================================

cd /d "%~dp0"

:: Set Cargo environment paths
if exist "T:\DevLibs\cargo" set "CARGO_HOME=T:\DevLibs\cargo"
if exist "%USERPROFILE%\.cargo\bin" set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

:: Terminate any dangling twin.exe instance so single-instance lock and cargo link don't fail
taskkill /f /im twin.exe >nul 2>&1

:: Automatically free port 1420 if previously occupied by a dangling process
for /f "tokens=5" %%a in ('netstat -aon ^| findstr /r ":1420[ ]" ^| findstr "LISTENING"') do (
    echo Freeing port 1420 for PID %%a...
    taskkill /f /pid %%a >nul 2>&1
)

:: Launch Tauri Dev
call pnpm tauri dev

set "EXIT_CODE=!ERRORLEVEL!"
if !EXIT_CODE! neq 0 (
    echo.
    echo Process exited with error code !EXIT_CODE!.
) else (
    echo.
    echo Twin development session finished.
)
pause
