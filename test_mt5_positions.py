#!/usr/bin/env python
"""
Direct MT5 positions test - run this to verify MT5 connection works
"""
import MetaTrader5 as mt5

print("=" * 60)
print("🧪 TESTING MT5 DIRECT CONNECTION")
print("=" * 60)

# Initialize
print("\n1️⃣ Initializing MT5...")
if not mt5.initialize():
    print("❌ FAILED: initialize() failed")
    print("   Error:", mt5.last_error())
    quit()
print("✅ SUCCESS: MT5 initialized")

# Get account info
print("\n2️⃣ Getting account info...")
account = mt5.account_info()
if account is None:
    print("❌ FAILED: Could not get account info")
    print("   Error:", mt5.last_error())
    mt5.shutdown()
    quit()
print(f"✅ SUCCESS: Logged in as {account.login} on {account.server}")

# Fetch positions
print("\n3️⃣ Fetching open positions...")
positions = mt5.positions_get()
print(f"   Type returned: {type(positions)}")
print(f"   Length: {len(positions) if positions else 0}")

if positions is None:
    print("❌ FAILED: positions_get() returned None")
    print("   Error:", mt5.last_error())
    mt5.shutdown()
    quit()

if len(positions) == 0:
    print("⚠️  No open positions found (this is OK if you have no open trades)")
    print("   To test: Open a position in MT5 and run again")
else:
    print(f"✅ SUCCESS: Found {len(positions)} open position(s)")
    print("\n📊 Position Details:")
    for i, pos in enumerate(positions, 1):
        print(f"\n   Position #{i}:")
        print(f"      Ticket: {pos.ticket}")
        print(f"      Symbol: {pos.symbol}")
        print(f"      Type: {'LONG' if pos.type == 1 else 'SHORT'}")
        print(f"      Volume: {pos.volume}")
        print(f"      Open Price: {pos.price_open}")
        print(f"      Current Price: {pos.price_current}")
        print(f"      Profit: {pos.profit}")
        print(f"      SL: {pos.sl}")
        print(f"      TP: {pos.tp}")

mt5.shutdown()
print("\n" + "=" * 60)
print("✅ Test complete!")
print("=" * 60)
