# Twin Development Mode Runner
Write-Host "=== Starting Twin Desktop (Development Mode) ===" -ForegroundColor Cyan
$env:CARGO_HOME = "T:\DevLibs\cargo"
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
Set-Location -Path $PSScriptRoot

try {
    pnpm tauri dev
} catch {
    Write-Error $_
}

if ($LASTEXITCODE -ne 0) {
    Write-Host "`nProcess exited with code $LASTEXITCODE. Press any key to exit..." -ForegroundColor Yellow
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
}
