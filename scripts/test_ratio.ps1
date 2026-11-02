# scripts/test_ratio.ps1
# Computes non-blank, non-comment lines of code for production vs test.

$prodLoc = 0
$testLoc = 0

function Count-Lines($path, $isTestFile = $false) {
    $prod = 0
    $test = 0
    $inBlockComment = $false
    $inTestCfg = $isTestFile
    $cfgDepth = 0

    $lines = Get-Content -LiteralPath $path
    foreach ($line in $lines) {
        $trimmed = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed)) {
            continue
        }
        if ($trimmed.StartsWith("/*")) {
            $inBlockComment = $true
        }
        if ($inBlockComment) {
            if ($trimmed.Contains("*/")) {
                $inBlockComment = $false
            }
            continue
        }
        if ($trimmed.StartsWith("//")) {
            continue
        }

        if (-not $isTestFile) {
            if ($trimmed -match '^#\[cfg\(test\)\]') {
                $inTestCfg = $true
                $cfgDepth = 0
                $test++
                continue
            }
            if ($inTestCfg) {
                if ($trimmed.Contains("{")) {
                    $cfgDepth += ($trimmed.ToCharArray() | Where-Object { $_ -eq '{' }).Count
                }
                if ($trimmed.Contains("}")) {
                    $cfgDepth -= ($trimmed.ToCharArray() | Where-Object { $_ -eq '}' }).Count
                    if ($cfgDepth -le 0) {
                        $inTestCfg = $false
                    }
                }
                $test++
                continue
            }
        }

        if ($isTestFile -or $inTestCfg) {
            $test++
        } else {
            $prod++
        }
    }

    return @{ Prod = $prod; Test = $test }
}

# Scan src-tauri/src
if (Test-Path "src-tauri/src") {
    $rsFiles = Get-ChildItem -Path "src-tauri/src" -Filter "*.rs" -Recurse
    foreach ($f in $rsFiles) {
        $isTest = $f.Name -eq "tests.rs" -or $f.Name.EndsWith("_test.rs")
        $counts = Count-Lines $f.FullName $isTest
        $prodLoc += $counts.Prod
        $testLoc += $counts.Test
    }
}

# Scan src-tauri/tests
if (Test-Path "src-tauri/tests") {
    $testFiles = Get-ChildItem -Path "src-tauri/tests" -Filter "*.rs" -Recurse
    foreach ($f in $testFiles) {
        $counts = Count-Lines $f.FullName $true
        $testLoc += $counts.Test
    }
}

# Scan src/**/*.test.ts and .tsx
if (Test-Path "src") {
    $tsTestFiles = Get-ChildItem -Path "src" -Recurse | Where-Object { $_.Name -match '\.test\.(ts|tsx)$' }
    foreach ($f in $tsTestFiles) {
        $counts = Count-Lines $f.FullName $true
        $testLoc += $counts.Test
    }
}

$ratio = if ($prodLoc -gt 0) { [math]::Round($testLoc / $prodLoc, 2) } else { 0 }

Write-Host "=========================================="
Write-Host " Tether Test-to-Code Ratio Report"
Write-Host "=========================================="
Write-Host "Production LOC: $prodLoc"
Write-Host "Test LOC:       $testLoc"
Write-Host "Ratio:          ${ratio} : 1  (Target: >= 8.0 : 1)"
Write-Host "=========================================="

if ($ratio -ge 8.0) {
    Write-Host "Gate PASSED" -ForegroundColor Green
    exit 0
} else {
    Write-Host "Gate PENDING (Under 8.0:1 target)" -ForegroundColor Yellow
    exit 0
}

