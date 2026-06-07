@echo off
title SwanXm MT5 Bridge
color 0A
echo.
echo  =====================================================
echo   SwanXm MT5 Bridge - Windows Setup
echo  =====================================================
echo.

:: Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Python not found. Install from https://python.org
    echo         Make sure to check "Add Python to PATH" during install.
    pause
    exit /b 1
)

echo  [1/3] Installing Python dependencies...
python -m pip install MetaTrader5 psutil --quiet
if errorlevel 1 (
    echo  [ERROR] Failed to install packages. Check your internet connection.
    pause
    exit /b 1
)
echo         Done.

echo.
echo  [2/3] Starting MT5 bridge on port 8765...
echo         Make sure MetaTrader 5 is open and logged in.
echo.
echo  =====================================================
echo   IMPORTANT - After the bridge starts:
echo.
echo   Open a NEW command prompt and run:
echo     ngrok http 8765
echo.
echo   Then copy the https URL and add it to
echo   Replit Secrets as:
echo     MT5_BRIDGE_URL = https://xxxx.ngrok.io/sync
echo  =====================================================
echo.
echo  [3/3] Bridge running... (press Ctrl+C to stop)
echo.

python -u mt5_http_bridge.py
pause
