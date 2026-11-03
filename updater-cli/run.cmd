@echo off
:: Quick launcher for the JioTv Max release CLI (Windows)
:: Usage: run.cmd [watch|status] [flags]
cd /d "%~dp0"
node --import tsx/esm src/index.ts %*
if errorlevel 1 (
  echo.
  echo [Error] Updater CLI encountered an error (exit code %errorlevel%).
  pause
)
