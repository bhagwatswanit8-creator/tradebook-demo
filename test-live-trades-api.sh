#!/bin/bash
# Quick test script to verify live trades API is working

echo "Testing /api/mt5/live-trades endpoint..."
echo ""

# Test with sample MT5 credentials (replace with real ones)
curl -X POST http://localhost:5050/api/mt5/live-trades \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_AUTH_TOKEN" \
  -d '{
    "login": "12345678",
    "password": "your_password",
    "server": "LirunexLimited-Live-MT5"
  }' | jq .

echo ""
echo "Test complete!"
