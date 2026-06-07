#!/usr/bin/env powershell
# Verification Script - Check All Components

Write-Host "🔍 Verifying Live MT5 Trades System..." -ForegroundColor Cyan
Write-Host ""

$projectPath = "c:\Users\bhagw\Downloads\Shadow Web\LX-MANISH-site"
$issues = @()

# Check 1: Required files exist
Write-Host "✓ Checking required files..." -ForegroundColor Yellow
$requiredFiles = @(
    "app.js",
    "server.js", 
    "mt5_core.py",
    "login.html",
    "test-mt5-api.html"
)

foreach ($file in $requiredFiles) {
    $path = Join-Path $projectPath $file
    if (Test-Path $path) {
        Write-Host "  ✅ $file" -ForegroundColor Green
    } else {
        Write-Host "  ❌ $file (MISSING)" -ForegroundColor Red
        $issues += $file
    }
}

Write-Host ""

# Check 2: JavaScript syntax
Write-Host "✓ Checking JavaScript syntax..." -ForegroundColor Yellow
try {
    $result = & node -c (Join-Path $projectPath "app.js") 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  ✅ app.js syntax OK" -ForegroundColor Green
    } else {
        Write-Host "  ❌ app.js syntax ERROR" -ForegroundColor Red
        $issues += "app.js syntax"
    }
} catch {
    Write-Host "  ⚠️  Node not found" -ForegroundColor Yellow
}

try {
    $result = & node -c (Join-Path $projectPath "server.js") 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  ✅ server.js syntax OK" -ForegroundColor Green
    } else {
        Write-Host "  ❌ server.js syntax ERROR" -ForegroundColor Red
        $issues += "server.js syntax"
    }
} catch {
    Write-Host "  ⚠️  Node not found" -ForegroundColor Yellow
}

Write-Host ""

# Check 3: Documentation files
Write-Host "✓ Checking documentation..." -ForegroundColor Yellow
$docFiles = @(
    "README_LIVE_TRADES.md",
    "QUICK_START.md",
    "COMPLETE_FIX_SUMMARY.md",
    "CODE_CHANGES.md",
    "LIVE_TRADES_FIX.md"
)

foreach ($file in $docFiles) {
    $path = Join-Path $projectPath $file
    if (Test-Path $path) {
        Write-Host "  ✅ $file" -ForegroundColor Green
    } else {
        Write-Host "  ❌ $file (MISSING)" -ForegroundColor Red
    }
}

Write-Host ""

# Check 4: Test tools
Write-Host "✓ Checking test tools..." -ForegroundColor Yellow
$testFiles = @(
    "test-mt5-api.html",
    "test_live_trades.py",
    "test-live-trades-api.sh"
)

foreach ($file in $testFiles) {
    $path = Join-Path $projectPath $file
    if (Test-Path $path) {
        Write-Host "  ✅ $file" -ForegroundColor Green
    } else {
        Write-Host "  ⚠️  $file (optional)" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "═════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "SUMMARY" -ForegroundColor Cyan
Write-Host "═════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

if ($issues.Count -eq 0) {
    Write-Host "✅ All checks passed! System is ready." -ForegroundColor Green
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Green
    Write-Host "  1. Start the server: node server.js"
    Write-Host "  2. Open test page: http://localhost:5050/test-mt5-api.html"
    Write-Host "  3. Enter your MT5 credentials"
    Write-Host "  4. Click 'Test Connection'"
    Write-Host ""
    Write-Host "Read this first: README_LIVE_TRADES.md"
} 
else {
    Write-Host "Issues found:" -ForegroundColor Red
    foreach ($issue in $issues) {
        Write-Host "  - $issue" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "═════════════════════════════════════════" -ForegroundColor Cyan
