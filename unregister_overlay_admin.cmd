@echo off
setlocal
echo Unregistering Twin Explorer Overlay Shell Extension (Administrator)...

reg delete "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\ShellIconOverlayIdentifiers\   TwinSynced" /f
reg delete "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\ShellIconOverlayIdentifiers\   TwinSyncing" /f

reg delete "HKLM\SOFTWARE\Classes\CLSID\{9B46E711-2051-417A-8D52-19253DE6C7D1}" /f
reg delete "HKLM\SOFTWARE\Classes\CLSID\{9B46E712-2051-417A-8D52-19253DE6C7D2}" /f

echo Done.
