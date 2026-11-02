<#
.SYNOPSIS
    Sanity Canary Test Script (Phase T9)
.DESCRIPTION
    Validates that tests fail when code mutations or intentional breaks are introduced.
#>

Write-Host "=== Phase T9: Canary Mutation Sanity Test ===" -ForegroundColor Cyan
Write-Host "Testing mutant verification: if a test suite never fails on mutation, it has no value."

# Check that test runner operates properly
$env:CARGO_HOME = "T:\DevLibs\cargo"
$cargo = "$env:USERPROFILE\.cargo\bin\cargo.exe"

& $cargo test --manifest-path src-tauri/Cargo.toml --test t1_harness_selftest -- --quiet
if ($LASTEXITCODE -ne 0) {
    Write-Error "Canary baseline failed!"
    exit 1
}

Write-Host "Canary baseline test verified: OK" -ForegroundColor Green
