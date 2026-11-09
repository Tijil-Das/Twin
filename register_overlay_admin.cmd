@echo off
setlocal
echo Registering Twin Explorer Overlay Shell Extension (Administrator)...

set "DLL_PATH=%~dp0Twin-Windows\src-tauri\icons\overlay\twin_overlay.dll"
if not exist "%DLL_PATH%" (
    set "DLL_PATH=%~dp0icons\overlay\twin_overlay.dll"
)
if not exist "%DLL_PATH%" (
    set "DLL_PATH=%~dp0twin_overlay.dll"
)

if not exist "%DLL_PATH%" (
    echo Error: twin_overlay.dll not found at %DLL_PATH%
    exit /b 1
)

reg add "HKLM\SOFTWARE\Classes\CLSID\{9B46E711-2051-417A-8D52-19253DE6C7D1}" /ve /d "Twin Synced Icon Overlay" /f
reg add "HKLM\SOFTWARE\Classes\CLSID\{9B46E711-2051-417A-8D52-19253DE6C7D1}\InprocServer32" /ve /d "%DLL_PATH%" /f
reg add "HKLM\SOFTWARE\Classes\CLSID\{9B46E711-2051-417A-8D52-19253DE6C7D1}\InprocServer32" /v "ThreadingModel" /d "Apartment" /f

reg add "HKLM\SOFTWARE\Classes\CLSID\{9B46E712-2051-417A-8D52-19253DE6C7D2}" /ve /d "Twin Syncing Icon Overlay" /f
reg add "HKLM\SOFTWARE\Classes\CLSID\{9B46E712-2051-417A-8D52-19253DE6C7D2}\InprocServer32" /ve /d "%DLL_PATH%" /f
reg add "HKLM\SOFTWARE\Classes\CLSID\{9B46E712-2051-417A-8D52-19253DE6C7D2}\InprocServer32" /v "ThreadingModel" /d "Apartment" /f

reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\ShellIconOverlayIdentifiers\   TwinSynced" /ve /d "{9B46E711-2051-417A-8D52-19253DE6C7D1}" /f
reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\ShellIconOverlayIdentifiers\   TwinSyncing" /ve /d "{9B46E712-2051-417A-8D52-19253DE6C7D2}" /f

echo Done.
