@echo off
:: Twin Release CLI Launcher
cd /d "%~dp0updater-cli"
node --import tsx/esm src/index.ts %*
if errorlevel 1 (
  echo.
  echo [Error] Release process encountered an error (exit code %errorlevel%).
  pause
)
