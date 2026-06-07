#!/usr/bin/env node

const fs = require('fs');

// Read the local database
const dbPath = './data/local-db.json';
const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

// Find the test user
const testUser = db.users.find(u => u.email === 'dashboard.test@example.com');
if (!testUser) {
  console.log('Test user not found');
  process.exit(1);
}

const userId = testUser.id;

// Add open positions (trades with same entry/exit to simulate current position)
const openPositions = [
  {
    id: `open-trade-1`,
    userId: userId,
    mt5DealId: `deal-001`,
    symbol: 'XAUUSD',
    direction: 'Long',
    entry: 4830.50,
    exit: 4835.75,  // Current price (floating)
    pnl: 525,  // Unrealized P&L
    volume: 0.5,
    lotSize: 0.5,
    openTime: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),  // 2 hours ago
    date: new Date().toISOString().split('T')[0],
    session: 'London',
    strategy: 'Liquidity Sweep',
    source: 'mt5',
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: `open-trade-2`,
    userId: userId,
    mt5DealId: `deal-002`,
    symbol: 'XAUUSD',
    direction: 'Short',
    entry: 4828.00,
    exit: 4820.50,  // Current price (floating)
    pnl: 750,  // Unrealized P&L (winning position)
    volume: 1.0,
    lotSize: 1.0,
    openTime: new Date(Date.now() - 30 * 60 * 1000).toISOString(),  // 30 minutes ago
    date: new Date().toISOString().split('T')[0],
    session: 'London',
    strategy: 'Breakout',
    source: 'mt5',
    createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: `open-trade-3`,
    userId: userId,
    mt5DealId: `deal-003`,
    symbol: 'XAUUSD',
    direction: 'Long',
    entry: 4827.20,
    exit: 4823.10,  // Current price (floating)
    pnl: -410,  // Unrealized P&L (losing position)
    volume: 0.75,
    lotSize: 0.75,
    openTime: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),  // 1 hour ago
    date: new Date().toISOString().split('T')[0],
    session: 'New York',
    strategy: 'Pullback',
    source: 'mt5',
    createdAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date().toISOString()
  }
];

// Separate open positions from regular trades
const regularTrades = db.trades.filter(t => t.source !== 'mt5' || !t.mt5DealId);
db.trades = openPositions.concat(regularTrades);

// Write updated database
fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

console.log(`Added ${openPositions.length} open positions for testing`);
console.log('Total P&L of open positions: $' + openPositions.reduce((sum, p) => sum + p.pnl, 0).toFixed(2));
