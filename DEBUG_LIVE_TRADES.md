# Live Trades Debug Guide

## Prerequisites to Show Live Trades

1. **Must be logged in** ✓
2. **User account must be Pro or Elite plan** (NOT Free) - Check in Settings → Subscription
3. **MT5 credentials must be entered** - Settings → MT5 Connection
4. **Must have active open trades in MT5 Terminal**
5. **MT5 Terminal must be running and logged in**

## How to Test Live Trades

### Step 1: Check Browser Console for Errors
- Press `F12` to open Developer Tools
- Go to Console tab
- Look for any error messages starting with "MT5 Live Trades Error" or "MT5 Live Trades Request Failed"

### Step 2: Verify Plan
- Log in to dashboard
- Go to Settings → Subscription
- Check if plan is "Pro" or "Elite"
- If Free, upgrade to see live trades

### Step 3: Enter MT5 Credentials
- Go to Settings → MT5 Connection
- Enter: Login (account number), Password, Server
- Fields should be filled and "Ready" status should show

### Step 4: Check Network Tab
- Press F12 → Network tab
- Look for requests to `/api/mt5/live-trades`
- Check the response to see if it returns trades

### Step 5: Verify MT5 Has Open Trades
- Open your MetaTrader 5 terminal
- Check that you have open positions
- The live trades poll runs every 2 seconds after connecting

## Expected API Response

```json
{
  "ok": true,
  "trades": [
    {
      "ticket": 12345,
      "symbol": "XAUUSD",
      "type": "LONG",
      "volume": 0.1,
      "priceOpen": 2450.00,
      "priceCurrent": 2455.00,
      "pnl": 50.00,
      "pnlPercent": 2.04,
      "status": "WINNING"
    }
  ],
  "stats": {
    "totalTrades": 1,
    "winningTrades": 1,
    "losingTrades": 0,
    "totalPnl": 50.00,
    "winRate": 100,
    "profitFactor": 1.0
  }
}
```

## If Live Trades Still Don't Show

### Check 1: Is supportsMt5Sync() returning true?
In browser console, run:
```javascript
console.log("Plan:", getCurrentPlan());
console.log("Supports MT5:", supportsMt5Sync());
console.log("Auth Token:", !!authToken);
```

### Check 2: Are credentials being passed?
In browser console, run:
```javascript
console.log("Credentials:", getMt5CredentialValues());
```

### Check 3: Is the polling running?
In browser console, run:
```javascript
console.log("Live MT5 Trades:", liveMt5Trades);
console.log("Live MT5 Stats:", liveMt5Stats);
console.log("Polling Timer ID:", window.liveMt5TradesPollTimer);
```

### Check 4: Are DOM elements present?
In browser console, run:
```javascript
console.log("Live Trades List Element:", document.querySelector("[data-live-trades-list"));
console.log("Dashboard P&L Element:", document.querySelector("[data-dashboard-total-pnl]"));
```

## Common Issues

| Issue | Solution |
|-------|----------|
| "Live trades card hidden" | You don't have open MT5 trades or Free plan |
| No response from `/api/mt5/live-trades` | MT5 bridge not running or Python error |
| Empty trades array | No open positions in your MT5 account |
| Browser console errors | Check error messages and MT5 connection status |

