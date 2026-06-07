@echo off
REM Verification Script for Live MT5 Trades System

echo.
echo ============================================================
echo  Live MT5 Trades System - Verification
echo ============================================================
echo.

setlocal enabledelayedexpansion
set issues=0

REM Check required files
echo Checking required files...
for %%F in (app.js server.js mt5_core.py login.html test-mt5-api.html) do (
    if exist "%%F" (
        echo   OK: %%F
    ) else (
        echo   MISSING: %%F
        set /a issues=!issues!+1
    )
)

echo.
echo Checking documentation...
for %%F in (README_LIVE_TRADES.md QUICK_START.md COMPLETE_FIX_SUMMARY.md CODE_CHANGES.md LIVE_TRADES_FIX.md) do (
    if exist "%%F" (
        echo   OK: %%F
    ) else (
        echo   MISSING: %%F
    )
)

echo.
echo ============================================================
if %issues% equ 0 (
    echo SUCCESS - All components are in place!
    echo.
    echo Next Steps:
    echo   1. Start server: node server.js
    echo   2. Open: http://localhost:5050/test-mt5-api.html
    echo   3. Enter MT5 credentials
    echo   4. Click "Test Connection"
    echo.
    echo Read: README_LIVE_TRADES.md
) else (
    echo WARNING - %issues% files missing
    echo Please check file paths and try again
)
echo ============================================================
echo.
pause
