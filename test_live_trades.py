#!/usr/bin/env python3
"""
Test script for live MT5 trades functionality
Run this to test if the Python backend is correctly formatting live trades data
"""

import json
import sys

# Add parent directory to path
sys.path.insert(0, '.')

try:
    from mt5_core import fetch_live_trades_formatted
    print("✓ Successfully imported fetch_live_trades_formatted")
except ImportError as e:
    print(f"✗ Failed to import: {e}")
    sys.exit(1)

# Test with sample data
print("\n" + "="*60)
print("Testing fetch_live_trades_formatted() function")
print("="*60 + "\n")

# Replace these with your actual MT5 credentials
MT5_LOGIN = "12345678"
MT5_PASSWORD = "your_password"
MT5_SERVER = "LirunexLimited-Live-MT5"

print(f"Testing with:")
print(f"  Login: {MT5_LOGIN}")
print(f"  Server: {MT5_SERVER}")
print()

try:
    result = fetch_live_trades_formatted(MT5_LOGIN, MT5_PASSWORD, MT5_SERVER)
    
    print("Response received:")
    print(json.dumps(result, indent=2))
    
    if result.get("ok") is False:
        print(f"\n✗ Error: {result.get('error')}")
        print("\nMake sure:")
        print("  1. MT5 Terminal is running and logged in")
        print("  2. You have open positions in MT5")
        print("  3. Your credentials are correct")
        sys.exit(1)
    
    trades = result.get("trades", [])
    stats = result.get("stats", {})
    
    print(f"\n✓ Success! Found {len(trades)} open trades")
    print(f"\nStatistics:")
    print(f"  Total Trades: {stats.get('totalTrades', 0)}")
    print(f"  Winning Trades: {stats.get('winningTrades', 0)}")
    print(f"  Losing Trades: {stats.get('losingTrades', 0)}")
    print(f"  Total P&L: ${stats.get('totalPnl', 0):.2f}")
    print(f"  Win Rate: {stats.get('winRate', 0):.2f}%")
    
    if trades:
        print(f"\nTrades:")
        for i, trade in enumerate(trades[:3], 1):
            print(f"\n  Trade #{i}:")
            print(f"    Symbol: {trade.get('symbol', 'N/A')}")
            print(f"    Type: {trade.get('type', 'N/A')}")
            print(f"    Volume: {trade.get('volume', 0)} lots")
            print(f"    Entry: {trade.get('priceOpen', 0):.2f}")
            print(f"    Current: {trade.get('priceCurrent', 0):.2f}")
            print(f"    P&L: ${trade.get('pnl', 0):.2f} ({trade.get('pnlPercent', 0):.2f}%)")
            print(f"    Status: {trade.get('status', 'N/A')}")
        
        if len(trades) > 3:
            print(f"\n  ... and {len(trades) - 3} more trades")
    else:
        print("\n⚠ No open trades found. Open some positions in MT5 and try again.")
        
except Exception as e:
    print(f"✗ Error occurred: {e}")
    print("\nTroubleshooting:")
    print("  1. Check that MetaTrader5 Python package is installed")
    print("  2. Verify MT5 Terminal is running")
    print("  3. Ensure you're logged into the correct MT5 account")
    import traceback
    traceback.print_exc()
    sys.exit(1)

print("\n" + "="*60)
print("Test complete!")
print("="*60)
