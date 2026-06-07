#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');

// Read the local database
const dbPath = './data/local-db.json';
const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

// Hash password function (same as server.js)
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

// Create test user with password
const testEmail = 'dashboard.test@example.com';
const testPassword = 'test123456';
const passwordHash = hashPassword(testPassword);

// Check if user already exists and update
let userExists = db.users.findIndex(u => u.email === testEmail);
if (userExists >= 0) {
  db.users[userExists].passwordHash = passwordHash;
  console.log(`Updated existing user with email: ${testEmail}`);
} else {
  const newUser = {
    id: 'dashboard-test-' + Date.now(),
    name: 'Dashboard Test',
    email: testEmail,
    plan: 'Pro',
    passwordHash: passwordHash,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  db.users.push(newUser);
  console.log(`Created new user with email: ${testEmail}`);
}

// Add test trades
const userId = db.users.find(u => u.email === testEmail).id;
const now = new Date();

for (let i = 0; i < 5; i++) {
  const trade = {
    id: `test-trade-${i}-${Date.now()}`,
    userId: userId,
    date: new Date(now.getTime() - i * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    symbol: 'XAUUSD',
    session: ['London', 'New York', 'Overlap', 'Asia'][i % 4],
    strategy: ['Liquidity Sweep', 'Breakout', 'Pullback', 'News Reaction'][i % 4],
    direction: i % 2 === 0 ? 'Long' : 'Short',
    entry: 4820 + i * 10,
    exit: 4820 + i * 10 + [15, -25, 30, -10, 20][i],
    lotSize: 0.01,
    pnl: [150, -100, 200, -75, 125][i],
    risk: 1,
    note: `Test trade ${i + 1}`,
    source: 'manual',
    createdAt: new Date(now.getTime() - i * 60 * 1000).toISOString(),
    updatedAt: new Date(now.getTime() - i * 60 * 1000).toISOString()
  };
  db.trades.unshift(trade);
}

// Write updated database
fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

console.log(`Password: ${testPassword}`);
console.log('Test data and user created successfully!');
