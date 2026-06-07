require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { spawn, spawnSync } = require("child_process");
const { MongoClient, ObjectId } = require("mongodb");
const metaApi = require("./metaapi");

const app = express();
const port = Number(process.env.PORT || 5000);
const mongoUri = process.env.MONGODB_URI;
const sessionSecret = process.env.SESSION_SECRET || "swanxm-local-development-secret";
const deepseekApiKey = process.env.DEEPSEEK_API_KEY;
const deepseekModel = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const localDbPath = path.join(__dirname, "data", "local-db.json");
const FREE_TRADE_LIMIT = 10;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

let dbPromise;
let dbFailed = false;

const resetTokens = new Map(); // token -> { userId, email, expiresAt }

async function getDb() {
  if (!mongoUri || dbFailed) return null;
  // Skip localhost MongoDB — it will never be available in deployed environments
  if (/127\.0\.0\.1|localhost/.test(mongoUri)) {
    if (!dbFailed) {
      console.warn("[DB] MONGODB_URI points to localhost — skipping, using local JSON fallback.");
      dbFailed = true;
    }
    return null;
  }
  try {
    if (!dbPromise) {
      const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000 });
      dbPromise = client.connect()
        .then(() => {
          console.log("[DB] Connected to MongoDB");
          return client.db();
        })
        .catch((err) => {
          console.warn("[DB] MongoDB unavailable, using local JSON fallback:", err.message);
          dbFailed = true;
          dbPromise = null;
          return null;
        });
    }
    return await dbPromise;
  } catch (err) {
    console.warn("[DB] getDb unexpected error:", err.message);
    dbFailed = true;
    dbPromise = null;
    return null;
  }
}

function readLocalDb() {
  if (!fs.existsSync(localDbPath)) {
    fs.mkdirSync(path.dirname(localDbPath), { recursive: true });
    fs.writeFileSync(localDbPath, JSON.stringify({ users: [], trades: [] }, null, 2));
  }

  return JSON.parse(fs.readFileSync(localDbPath, "utf8"));
}

function writeLocalDb(data) {
  fs.mkdirSync(path.dirname(localDbPath), { recursive: true });
  fs.writeFileSync(localDbPath, JSON.stringify(data, null, 2));
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeMobile(mobile) {
  return String(mobile || "").trim().replace(/\s+/g, " ");
}

function normalizeMt5Login(login) {
  return String(login || "").trim().replace(/\s+/g, "");
}

function normalizeMt5Server(server) {
  return String(server || "").trim();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, hash] = String(storedHash || "").split(":");
  if (!salt || !hash) return false;
  const candidate = hashPassword(password, salt).split(":")[1];
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(candidate, "hex"));
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", sessionSecret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifyToken(token) {
  const [body, signature] = String(token || "").split(".");
  if (!body || !signature) return null;
  const expected = crypto.createHmac("sha256", sessionSecret).update(body).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
}

function makeEaToken(userId) {
  const id = Buffer.from(String(userId)).toString("base64url");
  const sig = crypto.createHmac("sha256", sessionSecret + "ea-v1").update(String(userId)).digest("base64url");
  return `${id}.${sig}`;
}

function verifyEaToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  const [idB64, sig] = parts;
  try {
    const userId = Buffer.from(idB64, "base64url").toString("utf8");
    const expected = crypto.createHmac("sha256", sessionSecret + "ea-v1").update(userId).digest("base64url");
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    return userId;
  } catch { return null; }
}

function makeId() {
  return crypto.randomBytes(12).toString("hex");
}

function makeMongoUserId(id) {
  return ObjectId.isValid(id) ? new ObjectId(id) : id;
}

function calculateTradePnl({ direction, entry, exit, lotSize }) {
  const priceDifference = String(direction).toLowerCase() === "short"
    ? Number(entry) - Number(exit)
    : Number(exit) - Number(entry);
  return Number((priceDifference * Number(lotSize) * 100).toFixed(2));
}

function normalizePlan(plan) {
  const value = String(plan || "").toLowerCase();
  if (value.includes("elite")) return "Elite";
  if (value.includes("pro")) return "Pro";
  return "Free";
}

function isFreePlan(user) {
  return normalizePlan(user?.plan) === "Free";
}

function supportsAiReport(user) {
  const plan = normalizePlan(user?.plan);
  return plan === "Pro" || plan === "Elite";
}

async function getUserById(userId, db = null) {
  return db
    ? db.collection("users").findOne({ _id: makeMongoUserId(userId) })
    : readLocalDb().users.find((item) => item.id === userId);
}

function tradeSortValue(trade) {
  const created = new Date(trade.createdAt || trade.updatedAt || `${trade.date || ""}T12:00:00`).getTime();
  return Number.isFinite(created) ? created : 0;
}

async function enforceFreeManualTradeLimit(userId, db = null) {
  if (db) {
    const query = { userId: makeMongoUserId(userId), source: "manual" };
    const trades = await db.collection("trades")
      .find(query)
      .sort({ createdAt: -1, _id: -1 })
      .toArray();
    const overflow = trades.slice(FREE_TRADE_LIMIT);
    if (!overflow.length) return { removedCount: 0, removedTrades: [] };
    await db.collection("trades").deleteMany({ _id: { $in: overflow.map((trade) => trade._id) } });
    return { removedCount: overflow.length, removedTrades: overflow.map(publicTrade) };
  }

  const localDb = readLocalDb();
  const manualTrades = localDb.trades
    .filter((trade) => trade.userId === userId && (trade.source || "manual") === "manual")
    .sort((a, b) => tradeSortValue(b) - tradeSortValue(a));
  const keepIds = new Set(manualTrades.slice(0, FREE_TRADE_LIMIT).map((trade) => trade.id));
  const overflow = manualTrades.slice(FREE_TRADE_LIMIT);
  if (!overflow.length) return { removedCount: 0, removedTrades: [] };
  localDb.trades = localDb.trades.filter((trade) => {
    if (trade.userId !== userId || (trade.source || "manual") !== "manual") return true;
    return keepIds.has(trade.id);
  });
  writeLocalDb(localDb);
  return { removedCount: overflow.length, removedTrades: overflow.map(publicTrade) };
}

function cleanMt5Error(message) {
  const raw = String(message || "").trim();
  if (!raw) {
    return "MT5 sync failed. Check the account number, password, server, and that MetaTrader 5 is open and logged in.";
  }

  const normalized = raw
    .replace(/â€”|—/g, "-")
    .replace(/…|â€¦/g, "...")
    .replace(/^\[?(-?\d+),\s*['"]?(.+?)['"]?\]?$/i, "MT5 error $1: $2")
    .replace(/\s+/g, " ")
    .trim();

  if (/spawn.*EPERM|EPERM|operation not permitted|permission denied|Windows blocked Python/i.test(normalized)) {
    return "MT5 desktop bridge is not running. Open MetaTrader 5, then start the bridge in this project folder with: python mt5_http_bridge.py. When it says http://127.0.0.1:8765 is running, click Sync MT5 Trades again.";
  }

  if (/MT5 HTTP bridge unavailable|ECONNREFUSED|fetch failed/i.test(normalized)) {
    return "MT5 desktop bridge is not running. Open MetaTrader 5, then start the bridge in this project folder with: python mt5_http_bridge.py. When it says http://127.0.0.1:8765 is running, click Sync MT5 Trades again.";
  }

  if (/terminal is not running|terminal.*not.*open|not running/i.test(normalized)) {
    return "MT5 terminal could not be reached. SwanXm is allowed to launch the local MT5 terminal automatically, but Windows or MT5 may still require you to open it once and log in. Open MT5, keep the account logged in, then click Sync MT5 Trades again.";
  }

  if (/MT5_BRIDGE_OFFLINE/i.test(normalized)) {
    return "Your MT5 bridge is offline. Make sure both start_mt5_bridge.bat AND ngrok http 8765 are running on your Windows PC, then try again.";
  }
  if (/MT5_BRIDGE_NOT_CONFIGURED/i.test(normalized)) {
    return "MT5 bridge not set up yet. Run start_mt5_bridge.bat on your Windows PC, expose it with ngrok, then add the ngrok URL as MT5_BRIDGE_URL in Replit Secrets (Settings → Secrets).";
  }
  if (/no module named ['"]?MetaTrader5|MetaTrader5 Python package is not installed|install.*MetaTrader5/i.test(normalized)) {
    return "MetaTrader5 only works on Windows. Run start_mt5_bridge.bat on your Windows PC with MT5 installed, expose it via ngrok, then set MT5_BRIDGE_URL in Replit Secrets.";
  }

  if (/authorization failed|invalid account|invalid password|login failed|MT5 error -6|account.*disabled/i.test(normalized)) {
    return "MT5 login failed. Check the account number, password, and broker server name, then try again.";
  }

  if (/IPC|initialize failed|process create failed|terminal.*not found|MetaTrader 5 x64 not found|No IPC connection/i.test(normalized)) {
    return "Could not connect to the MT5 desktop terminal. SwanXm tried to use the local MT5 bridge. Open MetaTrader 5 once, log in to the same account, keep it running, then click Sync MT5 Trades again.";
  }

  if (/timed out|timeout/i.test(normalized)) {
    return "MT5 sync timed out. Keep MetaTrader 5 open and logged in, then try again.";
  }

  if (/history_deals_get|history|no trade history/i.test(normalized)) {
    return "MT5 connected, but no closed trade history was returned. In MT5, open the History tab and make sure the account has closed trades for the selected period.";
  }

  return normalized;
}

function isUsableExecutable(filePath) {
  if (!filePath) return false;
  const normalizedPath = filePath.replace(/\//g, "\\").toLowerCase();
  if (normalizedPath.includes("\\microsoft\\windowsapps\\")) return false;

  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch (error) {
    return false;
  }
}

// ── MT5 password encryption (AES-256-CBC) ────────────────────────────────────
function mt5EncKey() {
  const secret = process.env.SESSION_SECRET || "swanxm-local-development-secret";
  return Buffer.from(secret.padEnd(32, "0").slice(0, 32));
}

function encryptMt5Password(text) {
  if (!text) return "";
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-cbc", mt5EncKey(), iv);
    const enc = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
    return `${iv.toString("hex")}:${enc.toString("hex")}`;
  } catch { return ""; }
}

function decryptMt5Password(stored) {
  if (!stored || !stored.includes(":")) return "";
  try {
    const [ivHex, encHex] = stored.split(":");
    const decipher = crypto.createDecipheriv("aes-256-cbc", mt5EncKey(), Buffer.from(ivHex, "hex"));
    const dec = Buffer.concat([decipher.update(Buffer.from(encHex, "hex")), decipher.final()]);
    return dec.toString("utf8");
  } catch { return ""; }
}

function publicUser(user) {
  return {
    id: String(user._id || user.id),
    name: user.name,
    email: user.email,
    mobile: user.mobile || "",
    plan: normalizePlan(user.plan),
    theme: user.theme === "light" ? "light" : "dark",
    hasMt5Creds: !!(user.mt5Login && user.mt5EncPassword),
    mt5Login: user.mt5Login || "",
    mt5Server: user.mt5Server || "",
    hasMetaApi: !!(user.metaApiAccountId),
    metaApiAccountId: user.metaApiAccountId || ""
  };
}

async function requireUser(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) {
    console.log("[Auth] No token provided");
    return res.status(401).json({ message: "Login required." });
  }
  
  const payload = verifyToken(token);
  if (!payload?.userId) {
    console.log("[Auth] Token verification failed");
    return res.status(401).json({ message: "Login required." });
  }
  
  req.user = payload;
  console.log("[Auth] Token verified for user:", payload.userId);
  next();
}

app.get("/api/health", async (req, res) => {
  try {
    const db = await getDb();
    if (db) return res.json({ ok: true, database: "mongodb" });
    readLocalDb();
    return res.json({ ok: true, database: "local-json", path: "data/local-db.json" });
  } catch (error) {
    return res.status(503).json({ ok: false, message: error.message });
  }
});

// Test endpoint for MT5 live trades (for debugging)
app.post("/api/test/mt5-live-trades", async (req, res) => {
  try {
    const { login, password, server } = req.body;
    if (!login || !server) {
      return res.status(400).json({ 
        ok: false, 
        error: "MT5 login and server required for testing" 
      });
    }
    const result = await runPythonMt5Sync(login, password, server, "live_trades");
    
    // Always return response structure for testing
    if (!result || result.ok === false) {
      return res.json({
        ok: false,
        error: cleanMt5Error(result?.error || "MT5 connection failed"),
        trades: [],
        stats: {
          totalTrades: 0,
          winningTrades: 0,
          losingTrades: 0,
          totalPnl: 0,
          winRate: 0
        }
      });
    }

    return res.json({
      ok: true,
      trades: Array.isArray(result.trades) ? result.trades : [],
      stats: result.stats || {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        totalPnl: 0,
        winRate: 0
      },
      message: "Live MT5 trades (test mode)"
    });
  } catch (error) {
    console.error("Test endpoint error:", error);
    return res.json({
      ok: false,
      error: error.message,
      trades: [],
      stats: {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        totalPnl: 0,
        winRate: 0
      }
    });
  }
});

app.post("/api/auth/signup", async (req, res) => {
  try {
    const { name, password, confirmPassword, plan, termsAccepted } = req.body;
    const email = normalizeEmail(req.body.email);
    const mobile = normalizeMobile(req.body.mobile);

    if (!name || !email || !mobile || !password || !confirmPassword) {
      return res.status(400).json({ message: "Name, email, mobile number, password, and confirm password are required." });
    }

    if (!termsAccepted) {
      return res.status(400).json({ message: "You must accept the Terms & Conditions to create an account." });
    }

    if (String(password).length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters." });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ message: "Passwords do not match." });
    }

    if (!/^\+?[0-9\s-]{7,18}$/.test(mobile)) {
      return res.status(400).json({ message: "Enter a valid mobile number." });
    }

    const now = new Date();
    const db = await getDb();

    if (db) {
      const users = db.collection("users");
      const existing = await users.findOne({ email });
      if (existing) return res.status(409).json({ message: "This email is already registered." });

      const user = {
        name: String(name).trim(),
        email,
        mobile,
        plan: normalizePlan(plan),
        passwordHash: hashPassword(password),
        termsAcceptedAt: now,
        termsVersion: "1.0",
        createdAt: now,
        updatedAt: now
      };
      const result = await users.insertOne(user);
      user._id = result.insertedId;

      return res.status(201).json({
        token: signToken({ userId: user._id.toString(), email: user.email }),
        user: publicUser(user)
      });
    }

    const localDb = readLocalDb();
    if (localDb.users.some((user) => user.email === email)) {
      return res.status(409).json({ message: "This email is already registered." });
    }

    const user = {
      id: makeId(),
      name: String(name).trim(),
      email,
      mobile,
      plan: normalizePlan(plan),
      passwordHash: hashPassword(password),
      termsAcceptedAt: now.toISOString(),
      termsVersion: "1.0",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };

    localDb.users.push(user);
    writeLocalDb(localDb);

    return res.status(201).json({
      token: signToken({ userId: user.id, email: user.email }),
      user: publicUser(user)
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const { password } = req.body;
    const db = await getDb();
    let user = db
      ? await db.collection("users").findOne({ email })
      : readLocalDb().users.find((item) => item.email === email);

    if (db && !user) {
      const localUser = readLocalDb().users.find((item) => item.email === email);
      if (localUser && verifyPassword(password, localUser.passwordHash)) {
        const userToMigrate = {
          name: localUser.name,
          email: localUser.email,
          mobile: localUser.mobile || "",
          plan: normalizePlan(localUser.plan),
          passwordHash: localUser.passwordHash,
          createdAt: localUser.createdAt ? new Date(localUser.createdAt) : new Date(),
          updatedAt: new Date()
        };
        const result = await db.collection("users").insertOne(userToMigrate);
        user = { ...userToMigrate, _id: result.insertedId };
      }
    }

    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ message: "Invalid email or password." });
    }

    return res.json({
      token: signToken({ userId: String(user._id || user.id), email: user.email }),
      user: publicUser(user)
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.post("/api/auth/forgot-password", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const mobile = normalizeMobile(req.body.mobile);
    if (!email || !mobile) return res.status(400).json({ message: "Email and mobile number are required." });
    const db = await getDb();
    let user = db
      ? await db.collection("users").findOne({ email })
      : readLocalDb().users.find((u) => u.email === email);
    if (!user || normalizeMobile(user.mobile) !== mobile) {
      return res.status(404).json({ message: "No account found with that email and mobile number." });
    }
    const token = crypto.randomBytes(24).toString("hex");
    const userId = String(user._id || user.id);
    resetTokens.set(token, { userId, email, expiresAt: Date.now() + 15 * 60 * 1000 });
    return res.json({ token, message: "Verified. Set your new password." });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.post("/api/auth/reset-password", async (req, res) => {
  try {
    const { token, password, confirmPassword } = req.body;
    if (!token || !password || !confirmPassword) return res.status(400).json({ message: "Token, password, and confirm password are required." });
    if (String(password).length < 6) return res.status(400).json({ message: "Password must be at least 6 characters." });
    if (password !== confirmPassword) return res.status(400).json({ message: "Passwords do not match." });
    const entry = resetTokens.get(token);
    if (!entry) return res.status(400).json({ message: "Reset link is invalid or expired. Please start over." });
    if (Date.now() > entry.expiresAt) {
      resetTokens.delete(token);
      return res.status(400).json({ message: "Reset link has expired. Please start over." });
    }
    const newHash = hashPassword(password);
    const db = await getDb();
    let user;
    if (db) {
      await db.collection("users").updateOne(
        { _id: makeMongoUserId(entry.userId) },
        { $set: { passwordHash: newHash, updatedAt: new Date() } }
      );
      user = await db.collection("users").findOne({ _id: makeMongoUserId(entry.userId) });
    } else {
      const localDb = readLocalDb();
      user = localDb.users.find((u) => u.id === entry.userId);
      if (user) { user.passwordHash = newHash; user.updatedAt = new Date().toISOString(); }
      writeLocalDb(localDb);
    }
    resetTokens.delete(token);
    if (!user) return res.status(404).json({ message: "Account not found." });
    return res.json({
      token: signToken({ userId: String(user._id || user.id), email: user.email }),
      user: publicUser(user),
      message: "Password updated. You are now logged in."
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.patch("/api/auth/theme", requireUser, async (req, res) => {
  try {
    const theme = req.body.theme === "light" ? "light" : "dark";
    const db = await getDb();
    if (db) {
      await db.collection("users").updateOne(
        { _id: makeMongoUserId(req.user.userId) },
        { $set: { theme, updatedAt: new Date() } }
      );
    } else {
      const localDb = readLocalDb();
      const user = localDb.users.find((u) => u.id === req.user.userId);
      if (user) { user.theme = theme; user.updatedAt = new Date().toISOString(); }
      writeLocalDb(localDb);
    }
    return res.json({ ok: true, theme });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.patch("/api/auth/profile", requireUser, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const name    = String(req.body.name    || "").trim();
    const email   = normalizeEmail(req.body.email);
    const mobile  = normalizeMobile(req.body.mobile);

    if (!name || !email || !mobile) {
      return res.status(400).json({ message: "Name, email, and mobile number are required." });
    }
    if (!/^\+?[0-9\s-]{7,18}$/.test(mobile)) {
      return res.status(400).json({ message: "Enter a valid mobile number." });
    }
    if (!currentPassword) {
      return res.status(400).json({ message: "Current password is required to save changes." });
    }
    if (newPassword) {
      if (String(newPassword).length < 6) return res.status(400).json({ message: "New password must be at least 6 characters." });
      if (newPassword !== confirmPassword)  return res.status(400).json({ message: "New passwords do not match." });
    }

    const db   = await getDb();
    let user   = await getUserById(req.user.userId, db);
    if (!user) return res.status(401).json({ message: "Login required." });

    if (!verifyPassword(currentPassword, user.passwordHash)) {
      return res.status(401).json({ message: "Current password is incorrect." });
    }

    const updates = { name, email, mobile, updatedAt: new Date() };
    if (newPassword) updates.passwordHash = hashPassword(newPassword);

    if (db) {
      const emailConflict = await db.collection("users").findOne({ email, _id: { $ne: makeMongoUserId(req.user.userId) } });
      if (emailConflict) return res.status(409).json({ message: "That email is already used by another account." });
      await db.collection("users").updateOne({ _id: makeMongoUserId(req.user.userId) }, { $set: updates });
      user = await db.collection("users").findOne({ _id: makeMongoUserId(req.user.userId) });
    } else {
      const localDb = readLocalDb();
      const conflict = localDb.users.find((u) => u.email === email && u.id !== req.user.userId);
      if (conflict) return res.status(409).json({ message: "That email is already used by another account." });
      const target = localDb.users.find((u) => u.id === req.user.userId);
      if (!target) return res.status(401).json({ message: "Login required." });
      Object.assign(target, updates, { updatedAt: new Date().toISOString() });
      writeLocalDb(localDb);
      user = target;
    }

    const token = signToken({ userId: String(user._id || user.id), email: user.email });
    return res.json({ token, user: publicUser(user), message: "Profile updated." });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.get("/api/auth/me", requireUser, async (req, res) => {
  try {
    const db = await getDb();
    const user = await getUserById(req.user.userId, db);

    if (!user) return res.status(401).json({ message: "Login required." });
    return res.json({ user: publicUser(user) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.patch("/api/auth/plan", requireUser, async (req, res) => {
  try {
    const db = await getDb();
    const plan = normalizePlan(req.body.plan);

    if (db) {
      const userId = makeMongoUserId(req.user.userId);
      await db.collection("users").updateOne(
        { _id: userId },
        { $set: { plan, updatedAt: new Date() } }
      );
      if (plan === "Free") await enforceFreeManualTradeLimit(req.user.userId, db);
      const user = await db.collection("users").findOne({ _id: userId });
      if (!user) return res.status(401).json({ message: "Login required." });
      return res.json({ user: publicUser(user) });
    }

    const localDb = readLocalDb();
    const user = localDb.users.find((item) => item.id === req.user.userId);
    if (!user) return res.status(401).json({ message: "Login required." });
    user.plan = plan;
    user.updatedAt = new Date().toISOString();
    writeLocalDb(localDb);
    if (plan === "Free") await enforceFreeManualTradeLimit(req.user.userId, null);
    return res.json({ user: publicUser(user) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.get("/api/trades", requireUser, async (req, res) => {
  try {
    console.log("[Trades] GET /api/trades called");
    const db = await getDb();
    console.log("[Trades] Database:", db ? "MongoDB" : "local");
    
    const user = await getUserById(req.user.userId, db);
    if (!user) {
      console.log("[Trades] User not found");
      return res.status(401).json({ message: "Login required." });
    }
    
    console.log("[Trades] User found:", user.email);
    
    const mt5Login = normalizeMt5Login(req.query.mt5Login);
    const mt5Server = normalizeMt5Server(req.query.mt5Server);
    const accountMt5Filter = mt5Login
      ? {
          source: "mt5",
          mt5AccountLogin: mt5Login,
          ...(mt5Server ? { mt5Server } : {})
        }
      : null;

    if (db) {
      const query = {
        userId: makeMongoUserId(req.user.userId),
        $or: [
          { source: "manual" },
          ...(accountMt5Filter ? [accountMt5Filter] : [])
        ]
      };
      let trades = await db.collection("trades")
        .find(query)
        .sort({ date: -1, createdAt: -1 })
        .toArray();
      if (isFreePlan(user)) {
        trades = trades
          .filter((trade) => (trade.source || "manual") === "manual")
          .slice(0, FREE_TRADE_LIMIT);
      }
      console.log("[Trades] MongoDB returned", trades.length, "trades");
      return res.json({ trades: trades.map(publicTrade) });
    }

    // Local database path
    console.log("[Trades] Using local database");
    let trades = readLocalDb().trades;
    console.log("[Trades] Total trades in DB:", trades.length);
    
    const userIdStr = String(req.user.userId).trim();
    console.log("[Trades] Looking for userId:", userIdStr);
    
    trades = trades.filter((trade) => {
      const tradeUserId = String(trade.userId || "").trim();
      if (tradeUserId !== userIdStr) return false;
      if ((trade.source || "manual") === "manual") return true;
      if (!accountMt5Filter || trade.source !== "mt5") return false;
      if (String(trade.mt5AccountLogin || "") !== mt5Login) return false;
      return !mt5Server || String(trade.mt5Server || "") === mt5Server;
    });
    
    console.log("[Trades] After filter:", trades.length);
    
    trades = trades.sort((a, b) => String(b.date).localeCompare(String(a.date)));

    if (isFreePlan(user)) {
      trades = trades
        .filter((trade) => (trade.source || "manual") === "manual")
        .sort((a, b) => tradeSortValue(b) - tradeSortValue(a))
        .slice(0, FREE_TRADE_LIMIT);
      console.log("[Trades] After free limit:", trades.length);
    }

    console.log("[Trades] Final count:", trades.length);
    return res.json({ trades: trades.map(publicTrade) });
  } catch (error) {
    console.error("[Trades] Error:", error);
    return res.status(500).json({ message: error.message });
  }
});

app.post("/api/trades", requireUser, async (req, res) => {
  try {
    const db = await getDb();
    const user = await getUserById(req.user.userId, db);
    if (!user) return res.status(401).json({ message: "Login required." });
    const now = new Date();
    const trade = {
      date: req.body.date,
      symbol: String(req.body.symbol || "").trim().toUpperCase(),
      direction: String(req.body.direction || "").trim(),
      session: req.body.session,
      strategy: req.body.strategy,
      entry: Number(req.body.entry || 0),
      exit: Number(req.body.exit || 0),
      lotSize: Number(req.body.lotSize || 0),
      note: String(req.body.note || "").trim(),
      source: "manual",
      createdAt: now,
      updatedAt: now
    };
    trade.pnl = calculateTradePnl(trade);

    if (!trade.date || !trade.symbol || !trade.session || !trade.strategy) {
      return res.status(400).json({ message: "Date, symbol, session, and strategy are required." });
    }

    if (trade.symbol !== "XAUUSD") {
      return res.status(400).json({ message: "Only XAUUSD is supported in this calculator right now." });
    }

    if (!trade.direction || trade.entry <= 0 || trade.exit <= 0 || trade.lotSize <= 0) {
      return res.status(400).json({ message: "Direction, entry, exit, and lot size are required to calculate P&L." });
    }

    if (db) {
      const mongoTrade = { ...trade, userId: makeMongoUserId(req.user.userId) };
      const result = await db.collection("trades").insertOne(mongoTrade);
      const rollover = isFreePlan(user)
        ? await enforceFreeManualTradeLimit(req.user.userId, db)
        : { removedCount: 0, removedTrades: [] };
      return res.status(201).json({
        trade: publicTrade({ ...mongoTrade, _id: result.insertedId }),
        plan: normalizePlan(user.plan),
        freeLimitApplied: rollover.removedCount > 0,
        removedCount: rollover.removedCount,
        removedTrades: rollover.removedTrades
      });
    }

    const localDb = readLocalDb();
    const localTrade = {
      ...trade,
      id: makeId(),
      userId: req.user.userId,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    localDb.trades.push(localTrade);
    writeLocalDb(localDb);
    const rollover = isFreePlan(user)
      ? await enforceFreeManualTradeLimit(req.user.userId, null)
      : { removedCount: 0, removedTrades: [] };

    return res.status(201).json({
      trade: publicTrade(localTrade),
      plan: normalizePlan(user.plan),
      freeLimitApplied: rollover.removedCount > 0,
      removedCount: rollover.removedCount,
      removedTrades: rollover.removedTrades
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.delete("/api/trades", requireUser, async (req, res) => {
  try {
    const db = await getDb();

    if (db) {
      const result = await db.collection("trades").deleteMany({ userId: makeMongoUserId(req.user.userId) });
      return res.json({ deleted: result.deletedCount });
    }

    const localDb = readLocalDb();
    const before = localDb.trades.length;
    localDb.trades = localDb.trades.filter((trade) => trade.userId !== req.user.userId);
    writeLocalDb(localDb);
    return res.json({ deleted: before - localDb.trades.length });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

function getMt5PythonCommand() {
  if (process.env.MT5_PYTHON && isUsableExecutable(process.env.MT5_PYTHON)) {
    return process.env.MT5_PYTHON;
  }

  const localVenvCandidates = [
    path.join(__dirname, ".venv", "Scripts", "python.exe"),
    path.join(__dirname, ".venv", "bin", "python")
  ];
  const preferredPython = localVenvCandidates.find(isUsableExecutable);
  if (preferredPython) return preferredPython;

  if (process.platform === "win32") {
    const candidates = [];
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, "Python", "bin", "python.exe"));
      for (const version of ["314", "313", "312", "311", "310"]) {
        candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "Python", `Python${version}`, "python.exe"));
      }
    }
    if (process.env.ProgramFiles) {
      for (const version of ["314", "313", "312", "311", "310"]) {
        candidates.push(path.join(process.env.ProgramFiles, "Python", `Python${version}`, "python.exe"));
        candidates.push(path.join(process.env.ProgramFiles, `Python${version}`, "python.exe"));
      }
    }

    const directPython = candidates.find(isUsableExecutable);
    if (directPython) return directPython;

    const whereResult = spawnSync("where.exe", ["python"], { encoding: "utf8" });
    if (!whereResult.error && whereResult.stdout) {
      const pathPython = whereResult.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(isUsableExecutable);
      if (pathPython) return pathPython;
    }
  }

  return process.platform === "win32" ? "python" : "python3";
}

const mt5BridgeState = {
  process: null,
  buffer: "",
  nextId: 1,
  pending: new Map(),
  starting: null
};

let mt5HttpBridgeStarting = null;

function rejectMt5BridgeWaiters(message) {
  for (const [, pending] of mt5BridgeState.pending) {
    pending.reject(new Error(message));
  }
  mt5BridgeState.pending.clear();
}

function resetMt5Bridge() {
  if (mt5BridgeState.process && !mt5BridgeState.process.killed) {
    mt5BridgeState.process.kill();
  }
  mt5BridgeState.process = null;
  mt5BridgeState.buffer = "";
  mt5BridgeState.starting = null;
}

function handleMt5BridgeLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return;
  }

  const requestId = parsed.id;
  if (requestId == null || !mt5BridgeState.pending.has(requestId)) return;

  const pending = mt5BridgeState.pending.get(requestId);
  mt5BridgeState.pending.delete(requestId);

  if (!parsed.ok) {
    pending.reject(new Error(parsed.error || "MT5 sync failed."));
    return;
  }

  pending.resolve(parsed);
}

function ensureMt5BridgeProcess() {
  if (mt5BridgeState.process && !mt5BridgeState.process.killed) {
    return Promise.resolve();
  }

  if (mt5BridgeState.starting) return mt5BridgeState.starting;

  mt5BridgeState.starting = new Promise((resolve, reject) => {
    const pythonCommand = getMt5PythonCommand();
    const child = spawn(pythonCommand, ["-u", "mt5_bridge.py"], {
      cwd: __dirname,
      stdio: ["pipe", "pipe", "pipe"]
    });

    mt5BridgeState.process = child;
    mt5BridgeState.buffer = "";

    child.stdout.on("data", (chunk) => {
      mt5BridgeState.buffer += chunk.toString();
      let newlineIndex = mt5BridgeState.buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = mt5BridgeState.buffer.slice(0, newlineIndex);
        mt5BridgeState.buffer = mt5BridgeState.buffer.slice(newlineIndex + 1);
        handleMt5BridgeLine(line);
        newlineIndex = mt5BridgeState.buffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk) => {
      const stderrText = chunk.toString();
      if (/ModuleNotFoundError|No module named ['\"]MetaTrader5/i.test(stderrText)) {
        rejectMt5BridgeWaiters("Install the MT5 Python package: python -m pip install MetaTrader5");
        resetMt5Bridge();
      }
    });

    child.on("error", (error) => {
      const message = error?.code === "EPERM"
        ? `Windows blocked Python from starting (${pythonCommand}). Use the HTTP bridge instead: run python mt5_http_bridge.py in this project folder, then restart server.js with MT5_BRIDGE_MODE=http.`
        : `Python MT5 bridge is unavailable on this server. ${error?.message || ""}`.trim();
      rejectMt5BridgeWaiters(message);
      resetMt5Bridge();
      reject(new Error(message));
    });

    child.on("close", () => {
      rejectMt5BridgeWaiters("MT5 bridge stopped. Restart server.js, open MetaTrader 5, log in, then click Sync MT5 Trades again.");
      resetMt5Bridge();
    });

    child.stdin.on("error", () => {
      resetMt5Bridge();
    });

    setTimeout(() => resolve(), 150);
  }).finally(() => {
    mt5BridgeState.starting = null;
  });

  return mt5BridgeState.starting;
}

function getDefaultMt5TerminalPath() {
  const candidates = [];
  if (process.env.MT5_TERMINAL_PATH) candidates.push(process.env.MT5_TERMINAL_PATH);
  if (process.env.ProgramFiles) {
    candidates.push(
      path.join(process.env.ProgramFiles, "MetaTrader 5", "terminal64.exe"),
      path.join(process.env.ProgramFiles, "XM Global MT5", "terminal64.exe"),
      path.join(process.env.ProgramFiles, "Vantage International MT5", "terminal64.exe"),
      path.join(process.env.ProgramFiles, "Five Percent Online MetaTrader 5", "terminal64.exe")
    );
  }
  if (process.env["ProgramFiles(x86)"]) {
    candidates.push(
      path.join(process.env["ProgramFiles(x86)"], "MetaTrader 5", "terminal64.exe"),
      path.join(process.env["ProgramFiles(x86)"], "XM Global MT5", "terminal64.exe"),
      path.join(process.env["ProgramFiles(x86)"], "Vantage International MT5", "terminal64.exe")
    );
  }
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || "";
}

function mt5BridgeHealthUrl(bridgeUrl) {
  try {
    const url = new URL(bridgeUrl);
    url.pathname = "/health";
    url.search = "";
    return url.toString();
  } catch (error) {
    return "http://127.0.0.1:8765/health";
  }
}

async function isHttpMt5BridgeHealthy(healthUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1800);
  try {
    const response = await fetch(healthUrl, { signal: controller.signal });
    return response.ok;
  } catch (error) {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function ensureHttpMt5Bridge(bridgeUrl) {
  const isLocalUrl = /127\.0\.0\.1|localhost/.test(bridgeUrl);

  // External bridge URL configured (ngrok / cloudflare etc) — just verify it's reachable
  if (!isLocalUrl) {
    const healthUrl = mt5BridgeHealthUrl(bridgeUrl);
    if (await isHttpMt5BridgeHealthy(healthUrl)) return;
    throw new Error(
      "MT5_BRIDGE_OFFLINE: Your MT5 bridge at " + bridgeUrl + " is not responding. " +
      "Make sure start_mt5_bridge.bat AND ngrok http 8765 are both running on your Windows PC."
    );
  }

  // Localhost URL on Linux — cannot spawn MT5 here
  if (process.platform !== "win32") {
    throw new Error(
      "MT5_BRIDGE_NOT_CONFIGURED: MetaTrader5 requires Windows and cannot run on this cloud server. " +
      "Run start_mt5_bridge.bat on your Windows PC, expose it with ngrok, then add MT5_BRIDGE_URL to Replit Secrets."
    );
  }

  if (process.env.MT5_BRIDGE_NO_AUTOSTART === "1") return;

  const healthUrl = mt5BridgeHealthUrl(bridgeUrl);
  if (await isHttpMt5BridgeHealthy(healthUrl)) return;
  if (mt5HttpBridgeStarting) return mt5HttpBridgeStarting;

  mt5HttpBridgeStarting = new Promise((resolve, reject) => {
    const pythonCommand = getMt5PythonCommand();
    const env = {
      ...process.env,
      MT5_ALLOW_TERMINAL_LAUNCH: process.env.MT5_ALLOW_TERMINAL_LAUNCH || "1"
    };
    const terminalPath = getDefaultMt5TerminalPath();
    if (!env.MT5_TERMINAL_PATH && terminalPath) env.MT5_TERMINAL_PATH = terminalPath;

    const child = spawn(pythonCommand, ["-u", "mt5_http_bridge.py"], {
      cwd: __dirname,
      detached: true,
      env,
      stdio: "ignore",
      windowsHide: true
    });

    child.once("error", (error) => {
      reject(new Error(`Could not start MT5 HTTP bridge with ${pythonCommand}: ${error.message}`));
    });

    child.unref();

    setTimeout(async () => {
      if (await isHttpMt5BridgeHealthy(healthUrl)) {
        resolve();
        return;
      }
      reject(new Error("MT5 HTTP bridge did not become ready on 127.0.0.1:8765."));
    }, 2200);
  }).finally(() => {
    mt5HttpBridgeStarting = null;
  });

  return mt5HttpBridgeStarting;
}

async function runHttpMt5Sync(login, password, server, mode = "sync") {
  const bridgeUrl = process.env.MT5_BRIDGE_URL || "http://127.0.0.1:8765/sync";
  await ensureHttpMt5Bridge(bridgeUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);

  try {
    const mt5ApiKey = process.env.MT5_BRIDGE_API_KEY || "";
    const response = await fetch(bridgeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(mt5ApiKey ? { "X-MT5-Key": mt5ApiKey } : {}) },
      body: JSON.stringify({
        login: String(login),
        password: String(password || ""),
        server: String(server),
        mode
      }),
      signal: controller.signal
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.error || result.message || `MT5 HTTP bridge failed with ${response.status}`);
    }
    return result;
  } catch (error) {
    throw new Error(`MT5 HTTP bridge unavailable: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function runProcessMt5Sync(login, password, server, mode = "sync") {
  return ensureMt5BridgeProcess().then(() => new Promise((resolve, reject) => {
    const bridge = mt5BridgeState.process;
    if (!bridge || bridge.killed) {
      reject(new Error("MT5 bridge is not running. Restart server.js."));
      return;
    }

    const requestId = mt5BridgeState.nextId++;
    const timeout = setTimeout(() => {
      if (!mt5BridgeState.pending.has(requestId)) return;
      mt5BridgeState.pending.delete(requestId);
      reject(new Error("MT5 sync timed out. Keep MetaTrader 5 open and logged in, then try again."));
    }, 180000);

    mt5BridgeState.pending.set(requestId, {
      resolve: (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    });

    const payload = JSON.stringify({
      id: requestId,
      login: String(login),
      password: String(password || ""),
      server: String(server),
      mode
    });

    bridge.stdin.write(`${payload}\n`, (error) => {
      if (error) {
        clearTimeout(timeout);
        mt5BridgeState.pending.delete(requestId);
        resetMt5Bridge();
        reject(new Error("Could not send request to MT5 bridge."));
      }
    });
  }));
}

async function runPythonMt5Sync(login, password, server, mode = "sync") {
  return runHttpMt5Sync(login, password, server, mode);
}

process.on("exit", resetMt5Bridge);

function mt5AccountMatch(login, server) {
  return {
    $or: [
      { mt5AccountLogin: login, mt5Server: server },
      { mt5AccountLogin: { $exists: false } }
    ]
  };
}

async function getExistingMt5DealIds(userId, db, login, server) {
  if (db) {
    const trades = await db.collection("trades")
      .find({
        userId: makeMongoUserId(userId),
        source: "mt5",
        mt5DealId: { $exists: true },
        ...mt5AccountMatch(login, server)
      })
      .project({ mt5DealId: 1 })
      .toArray();
    return new Set(trades.map((trade) => Number(trade.mt5DealId)).filter(Boolean));
  }

  const localDb = readLocalDb();
  return new Set(
    localDb.trades
      .filter((trade) => {
        if (trade.userId !== userId || trade.source !== "mt5" || !trade.mt5DealId) return false;
        if (!trade.mt5AccountLogin) return true;
        return String(trade.mt5AccountLogin) === login && String(trade.mt5Server || "") === server;
      })
      .map((trade) => Number(trade.mt5DealId))
  );
}

app.post("/api/mt5/live", requireUser, async (req, res) => {
  try {
    const login = normalizeMt5Login(req.body.login);
    const password = String(req.body.password ?? "");
    const server = normalizeMt5Server(req.body.server);

    if (!login || !server) {
      return res.status(400).json({ message: "MT5 login and server are required." });
    }

    console.log("📡 [MT5 LIVE] Fetching positions for", { login, server });
    const result = await runPythonMt5Sync(login, password, server, "live");
    console.log("📡 [MT5 LIVE] Python response:", result);
    
    if (!result || result.ok === false) {
      const errorMsg = cleanMt5Error(result?.error || "Live MT5 positions unavailable.");
      console.error("❌ [MT5 LIVE] Error:", errorMsg);
      return res.status(400).json({ message: errorMsg });
    }

    console.log("✅ [MT5 LIVE] Got", result.positions?.length || 0, "positions");
    return res.json({
      ok: true,
      positions: Array.isArray(result.positions) ? result.positions : [],
      count: Number(result.count || 0),
      totalPnl: Number(result.totalPnl || 0),
      winRate: Number(result.winRate || 0),
      winCount: Number(result.winCount || 0),
      status: result.status || "connected",
      message: result.message || "Live MT5 positions refreshed."
    });
  } catch (error) {
    console.error("❌ [MT5 LIVE] Exception:", error);
    return res.status(500).json({ message: cleanMt5Error(error.message) });
  }
});

app.post("/api/mt5/live-trades", requireUser, async (req, res) => {
  try {
    const login = normalizeMt5Login(req.body.login);
    const password = String(req.body.password ?? "");
    const server = normalizeMt5Server(req.body.server);

    if (!login || !server) {
      return res.status(400).json({ message: "MT5 login and server are required." });
    }

    const result = await runPythonMt5Sync(login, password, server, "live_trades");
    if (!result || result.ok === false) {
      return res.status(400).json({ message: cleanMt5Error(result?.error || "Live MT5 trades unavailable.") });
    }

    return res.json({
      ok: true,
      trades: Array.isArray(result.trades) ? result.trades : [],
      stats: result.stats || {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        totalPnl: 0,
        winRate: 0
      },
      status: result.status || "connected",
      message: result.message || "Live MT5 trades refreshed."
    });
  } catch (error) {
    return res.status(500).json({ message: cleanMt5Error(error.message) });
  }
});

// ── MT5 Saved Credentials (backend-encrypted, auto-sync on login) ─────────────

app.post("/api/mt5/credentials", requireUser, async (req, res) => {
  try {
    const login = normalizeMt5Login(req.body.login);
    const password = String(req.body.password || "");
    const server = normalizeMt5Server(req.body.server);
    if (!login || !password || !server) {
      return res.status(400).json({ message: "MT5 login, password, and server are required." });
    }
    const encPass = encryptMt5Password(password);
    const now = new Date();
    const db = await getDb();
    if (db) {
      await db.collection("users").updateOne(
        { _id: makeMongoUserId(req.user.userId) },
        { $set: { mt5Login: login, mt5EncPassword: encPass, mt5Server: server, mt5CredSavedAt: now, updatedAt: now } }
      );
    } else {
      const localDb = readLocalDb();
      const user = localDb.users.find((u) => u.id === req.user.userId);
      if (user) Object.assign(user, { mt5Login: login, mt5EncPassword: encPass, mt5Server: server, mt5CredSavedAt: now.toISOString(), updatedAt: now.toISOString() });
      writeLocalDb(localDb);
    }
    return res.json({ ok: true, message: "MT5 credentials saved." });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.get("/api/mt5/credentials", requireUser, async (req, res) => {
  try {
    const db = await getDb();
    const user = await getUserById(req.user.userId, db);
    if (!user) return res.status(401).json({ message: "Login required." });
    if (!user.mt5Login || !user.mt5EncPassword) return res.json({ hasCreds: false });
    return res.json({ hasCreds: true, login: user.mt5Login, server: user.mt5Server || "", savedAt: user.mt5CredSavedAt || null });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.delete("/api/mt5/credentials", requireUser, async (req, res) => {
  try {
    const db = await getDb();
    if (db) {
      await db.collection("users").updateOne(
        { _id: makeMongoUserId(req.user.userId) },
        { $unset: { mt5Login: "", mt5EncPassword: "", mt5Server: "", mt5CredSavedAt: "" } }
      );
    } else {
      const localDb = readLocalDb();
      const user = localDb.users.find((u) => u.id === req.user.userId);
      if (user) { delete user.mt5Login; delete user.mt5EncPassword; delete user.mt5Server; writeLocalDb(localDb); }
    }
    return res.json({ ok: true, message: "MT5 credentials removed." });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// Silent auto-sync called by frontend right after login — uses saved credentials
app.post("/api/mt5/auto-sync", requireUser, async (req, res) => {
  try {
    const db = await getDb();
    const user = await getUserById(req.user.userId, db);
    if (!user || !user.mt5Login || !user.mt5EncPassword) {
      return res.json({ ok: false, reason: "no_creds" });
    }
    const login = user.mt5Login;
    const password = decryptMt5Password(user.mt5EncPassword);
    const server = user.mt5Server || "";
    if (!password) return res.json({ ok: false, reason: "decrypt_failed" });

    // Check bridge reachability quickly — don't block login
    const bridgeUrl = process.env.MT5_BRIDGE_URL || "http://127.0.0.1:8765/sync";
    let bridgeReachable = false;
    try {
      const probe = await Promise.race([
        fetch(bridgeUrl, { method: "HEAD" }).catch(() => null),
        new Promise(r => setTimeout(() => r(null), 2000))
      ]);
      bridgeReachable = !!(probe && (probe.ok || probe.status < 500));
    } catch { bridgeReachable = false; }

    if (!bridgeReachable) {
      return res.json({ ok: false, reason: "bridge_offline", login, server, message: "MT5 bridge not reachable. Start it on your VPS or PC." });
    }

    // Start sync in background — respond to client immediately
    res.json({ ok: true, reason: "syncing", login, server, message: "Syncing MT5 data..." });

    setImmediate(async () => {
      try {
        const result = await runPythonMt5Sync(login, password, server, "sync");
        if (!result || result.ok === false || !result.trades) return;

        const trades = Array.isArray(result.trades) ? result.trades : [];
        const userId = req.user.userId;
        const now = new Date();

        if (db) {
          const mongoId = makeMongoUserId(userId);
          const existing = new Set(
            (await db.collection("trades").find({ userId: mongoId, source: { $in: ["mt5", "mt5-ea"] }, mt5DealId: { $exists: true } }, { projection: { mt5DealId: 1 } }).toArray())
              .map(t => String(t.mt5DealId))
          );
          for (const trade of trades) {
            const tid = String(trade.id || trade.dealId || trade.ticket || "");
            if (!tid || existing.has(tid)) continue;
            const tradeDate = trade.date ? trade.date.split(" ")[0] : now.toISOString().split("T")[0];
            const pnl = Number(trade.pnl || 0) + Number(trade.swap || 0) + Number(trade.commission || 0);
            await db.collection("trades").insertOne({
              userId: mongoId, date: tradeDate, closedAt: trade.closedAt || trade.date || "",
              symbol: String(trade.symbol || "").toUpperCase(),
              direction: trade.direction || trade.type || "long",
              session: detectSession(trade.closedAt || trade.date),
              strategy: trade.comment ? String(trade.comment).slice(0, 50) : "MT5 Auto-Sync",
              entry: Number(trade.entryPrice || trade.entry || 0),
              exit: Number(trade.exitPrice || trade.exit || 0),
              lotSize: Number(trade.lotSize || trade.volume || 0),
              pnl, note: `Ticket: ${tid} | Auto-synced`,
              source: "mt5", mt5DealId: tid,
              mt5AccountLogin: login, mt5Server: server,
              createdAt: now, updatedAt: now
            });
          }
          if (result.positions) {
            await db.collection("users").updateOne(
              { _id: makeMongoUserId(userId) },
              { $set: { mt5EaLastSync: now.toISOString(), mt5EaPositions: result.positions, mt5EaAccount: result.account || {} } }
            );
          }
        }
      } catch (err) {
        console.error("[MT5 auto-sync bg]", err.message);
      }
    });
  } catch (error) {
    return res.json({ ok: false, reason: "error", message: error.message });
  }
});

// ── MT5 EA Direct Push (no ngrok/bridge needed) ──────────────────────────────

app.get("/api/mt5/ea-token", requireUser, async (req, res) => {
  const token = makeEaToken(req.user.userId);
  const appUrl = process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : (process.env.APP_URL || `http://localhost:${port}`);
  return res.json({
    ok: true,
    token,
    pushUrl: `${appUrl}/api/mt5/ea-push`,
    instructions: "Click 'Download EA File' to get a pre-configured .mq5 file ready to use in MetaTrader 5."
  });
});

app.get("/api/mt5/ea-download", requireUser, async (req, res) => {
  const token = makeEaToken(req.user.userId);
  const appUrl = process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : (process.env.APP_URL || `http://localhost:${port}`);
  const pushUrl = `${appUrl}/api/mt5/ea-push`;

  const mq5Template = fs.readFileSync(path.join(__dirname, "SwanXmSync.mq5"), "utf8");
  const configured = mq5Template
    .replace('input string ApiUrl      = "PASTE_YOUR_SERVER_URL_HERE/api/mt5/ea-push";', `input string ApiUrl      = "${pushUrl}";`)
    .replace('input string ApiToken    = "PASTE_YOUR_EA_TOKEN_HERE";', `input string ApiToken    = "${token}";`);

  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", "attachment; filename=\"SwanXmSync.mq5\"");
  return res.send(configured);
});

app.get("/api/mt5/ea-status", requireUser, async (req, res) => {
  try {
    const db = await getDb();
    const user = await getUserById(req.user.userId, db);
    if (!user) return res.status(401).json({ message: "Login required." });
    return res.json({
      ok: true,
      lastSync: user.mt5EaLastSync || null,
      account: user.mt5EaAccount || null,
      positionCount: Array.isArray(user.mt5EaPositions) ? user.mt5EaPositions.length : 0,
      positions: Array.isArray(user.mt5EaPositions) ? user.mt5EaPositions : []
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

app.post("/api/mt5/ea-push", async (req, res) => {
  // Auth via EA token (Bearer) — no session cookie needed
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const userId = verifyEaToken(token);
  if (!userId) return res.status(401).json({ message: "Invalid or missing EA token." });

  try {
    const db = await getDb();
    const user = await getUserById(userId, db);
    if (!user) return res.status(401).json({ message: "User not found." });

    const { positions = [], history = [], accountLogin, accountName, accountServer, balance, equity, floatingPnl, currency, leverage } = req.body;
    const now = new Date();

    // Build account snapshot
    const accountInfo = { accountLogin, accountName, accountServer, balance, equity, floatingPnl, currency, leverage };

    // Upsert closed trades from history into the trades collection
    let inserted = 0;
    let updated = 0;
    const historyDeals = Array.isArray(history) ? history : [];

    if (db) {
      const mongoUserId = makeMongoUserId(userId);
      // Get existing MT5 deal tickets for this user/account
      const existingTickets = new Set(
        (await db.collection("trades").find(
          { userId: mongoUserId, source: "mt5-ea", mt5AccountLogin: String(accountLogin || "") },
          { projection: { mt5DealId: 1 } }
        ).toArray()).map(t => String(t.mt5DealId))
      );

      for (const deal of historyDeals) {
        const ticketStr = String(deal.ticket || "");
        const tradeDate = deal.closedAt ? deal.closedAt.split(" ")[0] : now.toISOString().split("T")[0];
        const pnlVal = Number(deal.pnl || 0);
        const tradePnl = pnlVal + Number(deal.swap || 0) + Number(deal.commission || 0);

        if (existingTickets.has(ticketStr)) {
          await db.collection("trades").updateOne(
            { userId: mongoUserId, mt5DealId: ticketStr },
            { $set: { pnl: tradePnl, closedAt: deal.closedAt, updatedAt: now } }
          );
          updated++;
        } else {
          await db.collection("trades").insertOne({
            userId: mongoUserId,
            date: tradeDate,
            closedAt: deal.closedAt || "",
            symbol: String(deal.symbol || "XAUUSD").toUpperCase(),
            direction: deal.direction || "long",
            session: detectSession(deal.closedAt),
            strategy: deal.comment ? String(deal.comment).substring(0, 50) : "MT5 EA Import",
            entry: 0,
            exit: Number(deal.exitPrice || 0),
            lotSize: Number(deal.lotSize || 0),
            pnl: tradePnl,
            note: `Ticket: ${ticketStr} | Swap: ${deal.swap || 0} | Comm: ${deal.commission || 0}`,
            source: "mt5-ea",
            mt5DealId: ticketStr,
            mt5AccountLogin: String(accountLogin || ""),
            mt5Server: String(accountServer || ""),
            createdAt: now,
            updatedAt: now
          });
          inserted++;
        }
      }

      // Save positions + account snapshot on user record
      await db.collection("users").updateOne(
        { _id: makeMongoUserId(userId) },
        { $set: { mt5EaLastSync: now.toISOString(), mt5EaPositions: positions, mt5EaAccount: accountInfo } }
      );
    } else {
      // Local JSON DB path
      const localDb = readLocalDb();
      const existingTickets = new Set(
        localDb.trades.filter(t => t.userId === userId && t.source === "mt5-ea" && String(t.mt5AccountLogin) === String(accountLogin || "")).map(t => String(t.mt5DealId))
      );

      for (const deal of historyDeals) {
        const ticketStr = String(deal.ticket || "");
        const tradeDate = deal.closedAt ? deal.closedAt.split(" ")[0] : now.toISOString().split("T")[0];
        const pnlVal = Number(deal.pnl || 0);
        const tradePnl = pnlVal + Number(deal.swap || 0) + Number(deal.commission || 0);

        if (existingTickets.has(ticketStr)) {
          const idx = localDb.trades.findIndex(t => t.userId === userId && String(t.mt5DealId) === ticketStr);
          if (idx !== -1) { localDb.trades[idx].pnl = tradePnl; localDb.trades[idx].updatedAt = now.toISOString(); updated++; }
        } else {
          localDb.trades.push({
            id: makeId(),
            userId,
            date: tradeDate,
            closedAt: deal.closedAt || "",
            symbol: String(deal.symbol || "XAUUSD").toUpperCase(),
            direction: deal.direction || "long",
            session: detectSession(deal.closedAt),
            strategy: deal.comment ? String(deal.comment).substring(0, 50) : "MT5 EA Import",
            entry: 0,
            exit: Number(deal.exitPrice || 0),
            lotSize: Number(deal.lotSize || 0),
            pnl: tradePnl,
            note: `Ticket: ${ticketStr} | Swap: ${deal.swap || 0} | Comm: ${deal.commission || 0}`,
            source: "mt5-ea",
            mt5DealId: ticketStr,
            mt5AccountLogin: String(accountLogin || ""),
            mt5Server: String(accountServer || ""),
            createdAt: now.toISOString(),
            updatedAt: now.toISOString()
          });
          inserted++;
        }
      }

      // Save positions + account to user
      const uIdx = localDb.users.findIndex(u => u.id === userId || u._id === userId);
      if (uIdx !== -1) {
        localDb.users[uIdx].mt5EaLastSync = now.toISOString();
        localDb.users[uIdx].mt5EaPositions = positions;
        localDb.users[uIdx].mt5EaAccount = accountInfo;
      }
      writeLocalDb(localDb);
    }

    console.log(`[EA-Push] User ${userId} | +${inserted} new trades | ${updated} updated | ${positions.length} open positions`);
    return res.json({
      ok: true,
      inserted,
      updated,
      positionCount: positions.length,
      message: `Synced: ${inserted} new trades, ${updated} updated, ${positions.length} open positions.`
    });
  } catch (err) {
    console.error("[EA-Push] Error:", err);
    return res.status(500).json({ message: err.message });
  }
});

function detectSession(dateStr) {
  if (!dateStr) return "London";
  try {
    const h = new Date(dateStr.replace(" ", "T") + ":00Z").getUTCHours();
    if (h >= 0  && h < 7)  return "Asian";
    if (h >= 7  && h < 12) return "London";
    if (h >= 12 && h < 17) return "New York";
    if (h >= 17 && h < 21) return "New York";
    return "Asian";
  } catch { return "London"; }
}

// ── MetaApi Cloud MT5 Integration ─────────────────────────────────────────────
// POST /api/mt5/metaapi-connect — provision account, wait for connection, import trades

app.post("/api/mt5/metaapi-connect", requireUser, async (req, res) => {
  if (!process.env.METAAPI_TOKEN) {
    return res.status(503).json({ message: "MetaApi is not configured on this server." });
  }
  const login = normalizeMt5Login(req.body.login);
  const password = String(req.body.password || "");
  const server = normalizeMt5Server(req.body.server);
  if (!login || !password || !server) {
    return res.status(400).json({ message: "MT5 account number, password, and broker server are required." });
  }
  if (!/^\d{4,20}$/.test(login)) {
    return res.status(400).json({ message: "MT5 account number should be numeric only." });
  }

  try {
    // 1. Save credentials to user record
    const encPass = encryptMt5Password(password);
    const now = new Date();
    const db = await getDb();
    if (db) {
      await db.collection("users").updateOne(
        { _id: makeMongoUserId(req.user.userId) },
        { $set: { mt5Login: login, mt5EncPassword: encPass, mt5Server: server, mt5CredSavedAt: now, updatedAt: now } }
      );
    } else {
      const localDb = readLocalDb();
      const user = localDb.users.find(u => u.id === req.user.userId);
      if (user) Object.assign(user, { mt5Login: login, mt5EncPassword: encPass, mt5Server: server, mt5CredSavedAt: now.toISOString(), updatedAt: now.toISOString() });
      writeLocalDb(localDb);
    }

    // 2. Respond immediately so frontend shows progress
    res.json({ ok: true, status: "connecting", message: "Credentials saved. Connecting to MT5 in the background — trades will appear shortly." });

    // 3. Background: provision MetaApi account, wait for connection, import trades
    setImmediate(async () => {
      try {
        const account = await metaApi.provisionAccount(login, password, server);
        const accountId = account.id;

        // Store accountId on user for future syncs
        const db2 = await getDb();
        if (db2) {
          await db2.collection("users").updateOne(
            { _id: makeMongoUserId(req.user.userId) },
            { $set: { metaApiAccountId: accountId, updatedAt: new Date() } }
          );
        } else {
          const ldb = readLocalDb();
          const u = ldb.users.find(u => u.id === req.user.userId);
          if (u) { u.metaApiAccountId = accountId; u.updatedAt = new Date().toISOString(); }
          writeLocalDb(ldb);
        }

        // Wait up to 2 minutes for MT5 connection
        await metaApi.waitForDeployed(accountId, 120000);

        // Fetch history and open positions
        const deals = await metaApi.fetchAccountHistory(accountId);
        const positions = await metaApi.fetchOpenPositions(accountId);
        const accountInfo = await metaApi.fetchAccountInfo(accountId);

        // Import closed deals as trades (skip open positions and non-trade entries)
        const tradeable = deals.filter(d =>
          d.entryType === "DEAL_ENTRY_OUT" || d.entryType === "DEAL_ENTRY_OUT_BY"
        );

        const userId = req.user.userId;
        const db3 = await getDb();
        const now2 = new Date();

        if (db3) {
          const mongoId = makeMongoUserId(userId);
          const existing = new Set(
            (await db3.collection("trades").find(
              { userId: mongoId, source: "metaapi" },
              { projection: { mt5DealId: 1 } }
            ).toArray()).map(t => String(t.mt5DealId))
          );
          let inserted = 0;
          for (const deal of tradeable) {
            const mapped = metaApi.mapDealToTrade(deal, login, server);
            if (existing.has(mapped.mt5DealId)) continue;
            await db3.collection("trades").insertOne({ userId: mongoId, createdAt: now2, updatedAt: now2, ...mapped });
            inserted++;
          }

          // Save positions + account info on user
          const positionsMapped = positions.map(p => ({
            symbol: p.symbol,
            direction: p.type === "POSITION_TYPE_SELL" ? "short" : "long",
            lotSize: p.volume,
            entry: p.openPrice,
            pnl: p.profit,
            mt5DealId: String(p.id)
          }));
          await db3.collection("users").updateOne(
            { _id: mongoId },
            { $set: {
              mt5EaLastSync: now2.toISOString(),
              mt5EaPositions: positionsMapped,
              mt5EaAccount: accountInfo ? {
                balance: accountInfo.balance,
                equity: accountInfo.equity,
                floatingPnl: accountInfo.equity - accountInfo.balance,
                currency: accountInfo.currency,
                leverage: accountInfo.leverage
              } : {}
            }}
          );
          console.log(`[MetaApi] User ${userId} | ${inserted} trades imported | ${positions.length} open positions`);
        }
      } catch (err) {
        console.error("[MetaApi bg connect]", err.message);
      }
    });
  } catch (error) {
    if (!res.headersSent) return res.status(500).json({ message: error.message });
    console.error("[MetaApi connect]", error.message);
  }
});

// POST /api/mt5/metaapi-sync — re-sync trades for a connected account
app.post("/api/mt5/metaapi-sync", requireUser, async (req, res) => {
  if (!process.env.METAAPI_TOKEN) {
    return res.status(503).json({ message: "MetaApi is not configured." });
  }
  try {
    const db = await getDb();
    const user = await getUserById(req.user.userId, db);
    if (!user || !user.mt5Login || !user.mt5EncPassword) {
      return res.status(400).json({ ok: false, reason: "no_creds", message: "No MT5 credentials saved." });
    }

    let accountId = user.metaApiAccountId;
    if (!accountId) {
      const found = await metaApi.findExistingAccount(user.mt5Login, user.mt5Server || "");
      if (!found) return res.json({ ok: false, reason: "no_account", message: "No MetaApi account found. Please reconnect." });
      accountId = found.id;
      if (db) {
        await db.collection("users").updateOne(
          { _id: makeMongoUserId(req.user.userId) },
          { $set: { metaApiAccountId: accountId } }
        );
      }
    }

    // If account is gone/offline, auto-reconnect before syncing
    let deals, positions, accountInfo;
    try {
      [deals, positions, accountInfo] = await Promise.all([
        metaApi.fetchAccountHistory(accountId),
        metaApi.fetchOpenPositions(accountId),
        metaApi.fetchAccountInfo(accountId)
      ]);
    } catch (fetchErr) {
      if (isAccountGoneError(fetchErr)) {
        accountId = await reconnectMetaApiAccount(user, db);
        [deals, positions, accountInfo] = await Promise.all([
          metaApi.fetchAccountHistory(accountId),
          metaApi.fetchOpenPositions(accountId),
          metaApi.fetchAccountInfo(accountId)
        ]);
      } else {
        throw fetchErr;
      }
    }

    const tradeable = deals.filter(d =>
      d.entryType === "DEAL_ENTRY_OUT" || d.entryType === "DEAL_ENTRY_OUT_BY"
    );

    const userId = req.user.userId;
    const now = new Date();
    let inserted = 0;

    if (db) {
      const mongoId = makeMongoUserId(userId);
      const existing = new Set(
        (await db.collection("trades").find(
          { userId: mongoId, source: "metaapi" },
          { projection: { mt5DealId: 1 } }
        ).toArray()).map(t => String(t.mt5DealId))
      );
      for (const deal of tradeable) {
        const mapped = metaApi.mapDealToTrade(deal, user.mt5Login, user.mt5Server || "");
        if (existing.has(mapped.mt5DealId)) continue;
        await db.collection("trades").insertOne({ userId: mongoId, createdAt: now, updatedAt: now, ...mapped });
        inserted++;
      }
      const positionsMapped = positions.map(p => ({
        symbol: p.symbol,
        direction: p.type === "POSITION_TYPE_SELL" ? "short" : "long",
        lotSize: p.volume,
        entry: p.openPrice,
        pnl: p.profit,
        mt5DealId: String(p.id)
      }));
      await db.collection("users").updateOne(
        { _id: mongoId },
        { $set: {
          mt5EaLastSync: now.toISOString(),
          mt5EaPositions: positionsMapped,
          mt5EaAccount: accountInfo ? {
            balance: accountInfo.balance, equity: accountInfo.equity,
            floatingPnl: accountInfo.equity - accountInfo.balance,
            currency: accountInfo.currency, leverage: accountInfo.leverage
          } : {}
        }}
      );
    }

    return res.json({ ok: true, inserted, positions: positions.length, message: `Synced: ${inserted} new trades, ${positions.length} open positions.` });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

// DELETE /api/mt5/metaapi-disconnect — remove MetaApi account
app.delete("/api/mt5/metaapi-disconnect", requireUser, async (req, res) => {
  try {
    const db = await getDb();
    const user = await getUserById(req.user.userId, db);
    if (user?.metaApiAccountId) {
      await metaApi.removeAccount(user.metaApiAccountId).catch(() => {});
    }
    if (db) {
      await db.collection("users").updateOne(
        { _id: makeMongoUserId(req.user.userId) },
        { $unset: { mt5Login: "", mt5EncPassword: "", mt5Server: "", mt5CredSavedAt: "", metaApiAccountId: "" } }
      );
    } else {
      const localDb = readLocalDb();
      const u = localDb.users.find(u => u.id === req.user.userId);
      if (u) { delete u.mt5Login; delete u.mt5EncPassword; delete u.mt5Server; delete u.metaApiAccountId; writeLocalDb(localDb); }
    }
    return res.json({ ok: true, message: "MT5 disconnected." });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

app.post("/api/trades/sync-demo", requireUser, async (req, res) => {
  try {
    const db = await getDb();
    const user = await getUserById(req.user.userId, db);
    if (!user) return res.status(401).json({ message: "Login required." });
    if (isFreePlan(user)) {
      return res.status(403).json({
        code: "UPGRADE_REQUIRED",
        message: "MT5 sync is available on Pro and Elite. Pro allows 1 MT5 account; Elite allows up to 5. Upgrade to Pro or Elite to connect MT5 and import trades."
      });
    }

    const login = normalizeMt5Login(req.body.login);
    const password = String(req.body.password ?? "");
    const server = normalizeMt5Server(req.body.server);

    if (!login || !server) {
      return res.status(400).json({ message: "MT5 login and server are required." });
    }

    if (!/^\d{4,20}$/.test(login)) {
      return res.status(400).json({ message: "Enter only the MT5 account number, for example 569233626." });
    }

    if (!password) {
      return res.status(400).json({ message: "MT5 password is required for backend connection." });
    }

    const syncResult = await runPythonMt5Sync(login, password, server);
    if (syncResult.ok === false) {
      return res.status(400).json({
        code: "MT5_SYNC_FAILED",
        message: cleanMt5Error(syncResult.error || "MT5 sync failed.")
      });
    }

    const trades = Array.isArray(syncResult.trades) ? syncResult.trades : [];
    const parsedFromMt5 = Number(syncResult.importedDeals || trades.length);

    const existingDealIds = await getExistingMt5DealIds(req.user.userId, db, login, server);
    const imported = [];
    let skipped = 0;
    let updated = 0;
    const userId = req.user.userId;
    const mongoUserId = makeMongoUserId(userId);

    for (const trade of trades) {
      const mt5DealId = Number(trade.mt5DealId || 0);
      const tradeRecord = {
        date: trade.date,
        closedAt: trade.closedAt || undefined,
        symbol: String(trade.symbol || "XAUUSD").toUpperCase(),
        direction: String(trade.direction || "long").trim().toLowerCase(),
        session: trade.session || "MT5",
        strategy: trade.strategy || "MT5 Auto Import",
        entry: Number(trade.entry || 0),
        exit: Number(trade.exit || 0),
        lotSize: Number(trade.lotSize || 0),
        pnl: Number(trade.pnl || 0),
        note: String(trade.note || "Imported from MT5 account").trim(),
        source: "mt5",
        mt5AccountLogin: login,
        mt5Server: server,
        mt5DealId: mt5DealId || undefined,
        updatedAt: new Date()
      };

      if (!isPerformanceTrade(tradeRecord)) {
        skipped += 1;
        continue;
      }

      if (mt5DealId && existingDealIds.has(mt5DealId)) {
        if (db) {
          await db.collection("trades").updateOne(
            { userId: mongoUserId, source: "mt5", mt5DealId, ...mt5AccountMatch(login, server) },
            { $set: tradeRecord }
          );
        } else {
          const localDb = readLocalDb();
          const existing = localDb.trades.find((item) => {
            if (item.userId !== userId || item.source !== "mt5" || Number(item.mt5DealId) !== mt5DealId) return false;
            if (!item.mt5AccountLogin) return true;
            return String(item.mt5AccountLogin) === login && String(item.mt5Server || "") === server;
          });
          if (existing) Object.assign(existing, tradeRecord, { updatedAt: new Date().toISOString() });
          writeLocalDb(localDb);
        }
        updated += 1;
        skipped += 1;
        continue;
      }

      tradeRecord.createdAt = new Date();

      if (db) {
        await db.collection("trades").insertOne({ ...tradeRecord, userId: mongoUserId });
      } else {
        const localDb = readLocalDb();
        localDb.trades.push({
          ...tradeRecord,
          id: makeId(),
          userId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        writeLocalDb(localDb);
      }

      if (mt5DealId) existingDealIds.add(mt5DealId);
      imported.push(tradeRecord);
    }

    let journalTotal = 0;
    if (db) {
      journalTotal = await db.collection("trades").countDocuments({
        userId: mongoUserId,
        $or: [
          { source: "manual" },
          { source: "mt5", mt5AccountLogin: login, mt5Server: server }
        ]
      });
    } else {
      journalTotal = readLocalDb().trades.filter((item) => (
        item.userId === userId
        && (
          (item.source || "manual") === "manual"
          || (item.source === "mt5" && String(item.mt5AccountLogin || "") === login && String(item.mt5Server || "") === server)
        )
      )).length;
    }

    let message = syncResult.message || "Connected to MT5.";
    if (imported.length) {
      message = `Imported ${imported.length} trade${imported.length === 1 ? "" : "s"} from MT5 into Trades and Analytics.`;
    } else if (journalTotal > 0 && parsedFromMt5 > 0) {
      message = `Connected. ${journalTotal} trade${journalTotal === 1 ? "" : "s"} in your journal (GMT+0 sessions).`;
    } else if (parsedFromMt5 === 0) {
      message = syncResult.message || "Connected. No trade history found in this MT5 account yet.";
    } else if (updated > 0) {
      message = `Connected. ${updated} MT5 trade${updated === 1 ? "" : "s"} refreshed.`;
    }

    return res.json({
      inserted: imported.length,
      updated,
      skipped,
      totalFromMt5: parsedFromMt5,
      rawDeals: Number(syncResult.totalDeals || 0),
      tradeDeals: Number(syncResult.tradeDeals || 0),
      journalTotal,
      status: syncResult.status || "connected",
      mt5AccountLogin: login,
      mt5Server: server,
      message,
      trades: imported
    });
  } catch (error) {
    const message = cleanMt5Error(error.message);
    const isMt5Problem = /mt5|metatrader|login|server|history|terminal|authorization|connection|account|password/i.test(message);
    return res.status(isMt5Problem ? 400 : 500).json({ message });
  }
});

function publicTrade(trade) {
  return {
    id: String(trade._id || trade.id),
    date: trade.date,
    closedAt: trade.closedAt || "",
    symbol: trade.symbol,
    direction: trade.direction || "",
    session: trade.session,
    strategy: trade.strategy,
    entry: Number(trade.entry || 0),
    exit: Number(trade.exit || 0),
    lotSize: Number(trade.lotSize || 0),
    risk: trade.risk,
    pnl: trade.pnl,
    note: trade.note,
    source: trade.source || "manual",
    mt5AccountLogin: trade.mt5AccountLogin || "",
    mt5Server: trade.mt5Server || ""
  };
}

const CASH_OPERATION_PATTERN = /\b(deposits?|deposites?|withdraw|withdrawals?|balance|credits?|funding|funds?|cash|transfers?|rebates?)\b/i;

function isPerformanceTrade(trade) {
  if (!trade) return false;
  const symbol = String(trade.symbol || "").trim();
  const direction = String(trade.direction || "").trim().toLowerCase();
  const descriptor = [
    trade.symbol,
    trade.session,
    trade.strategy,
    trade.note,
    trade.source,
    trade.type
  ].join(" ");
  const isOpenPosition = /open position/i.test(String(trade.strategy || "") + " " + String(trade.note || ""));

  if (!symbol || CASH_OPERATION_PATTERN.test(descriptor)) return false;
  if (!["long", "short", "buy", "sell"].includes(direction)) return false;
  if (Number(trade.lotSize || 0) <= 0) return false;
  if (!Number.isFinite(Number(trade.pnl || 0))) return false;
  if (isOpenPosition) {
    return Number(trade.entry || 0) >= 0 && Number(trade.exit || 0) >= 0;
  }
  return Number(trade.entry || 0) > 0 && Number(trade.exit || 0) > 0;
}

function getPerformanceTrades(trades) {
  return (Array.isArray(trades) ? trades : []).filter(isPerformanceTrade);
}

async function loadUserPerformanceTrades(userId, db = null) {
  if (db) {
    const trades = await db.collection("trades")
      .find({ userId: makeMongoUserId(userId) })
      .sort({ date: -1, createdAt: -1 })
      .limit(250)
      .toArray();
    return getPerformanceTrades(trades.map(publicTrade));
  }

  return getPerformanceTrades(
    readLocalDb().trades
      .filter((trade) => trade.userId === userId)
      .sort((a, b) => tradeSortValue(b) - tradeSortValue(a))
      .slice(0, 250)
      .map(publicTrade)
  );
}

function groupPnlTotals(trades, key) {
  return trades.reduce((totals, trade) => {
    const group = String(trade[key] || "Unknown");
    totals[group] = (totals[group] || 0) + Number(trade.pnl || 0);
    return totals;
  }, {});
}

function topGroup(totals, direction = "best") {
  const entries = Object.entries(totals);
  if (!entries.length) return { name: "No data", pnl: 0 };
  const sorted = entries.sort((a, b) => direction === "worst" ? a[1] - b[1] : b[1] - a[1]);
  return { name: sorted[0][0], pnl: Number(sorted[0][1] || 0) };
}

function buildPerformanceSnapshot(trades) {
  const performanceTrades = getPerformanceTrades(trades);
  const wins = performanceTrades.filter((trade) => Number(trade.pnl) > 0);
  const losses = performanceTrades.filter((trade) => Number(trade.pnl) < 0);
  const totalPnl = performanceTrades.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
  const grossProfit = wins.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0));
  const sessionTotals = groupPnlTotals(performanceTrades, "session");
  const strategyTotals = groupPnlTotals(performanceTrades, "strategy");

  return {
    totalTrades: performanceTrades.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    totalPnl: Number(totalPnl.toFixed(2)),
    winRate: performanceTrades.length ? Math.round((wins.length / performanceTrades.length) * 100) : 0,
    profitFactor: grossLoss ? Number((grossProfit / grossLoss).toFixed(2)) : (grossProfit > 0 ? "strong" : 0),
    expectancy: performanceTrades.length ? Number((totalPnl / performanceTrades.length).toFixed(2)) : 0,
    bestSession: topGroup(sessionTotals, "best"),
    worstSession: topGroup(sessionTotals, "worst"),
    bestStrategy: topGroup(strategyTotals, "best"),
    worstStrategy: topGroup(strategyTotals, "worst"),
    recentTrades: performanceTrades.slice(0, 40).map((trade) => ({
      date: trade.date,
      symbol: trade.symbol,
      direction: trade.direction,
      session: trade.session,
      strategy: trade.strategy,
      entry: trade.entry,
      exit: trade.exit,
      lotSize: trade.lotSize,
      pnl: Number(trade.pnl || 0),
      source: trade.source || "manual",
      note: String(trade.note || "").slice(0, 180)
    }))
  };
}

function generateHeuristicReport(rawTrades) {
  const trades = getPerformanceTrades(rawTrades);
  const wins = trades.filter((trade) => Number(trade.pnl) > 0);
  const losses = trades.filter((trade) => Number(trade.pnl) < 0);
  const totalPnl = trades.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
  const winRate = trades.length ? Math.round((wins.length / trades.length) * 100) : 0;
  const biggestLoss = Math.abs(losses.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0));
  const bestSession = trades.reduce((best, trade) => {
    const session = trade.session || "Unknown";
    best[session] = (best[session] || 0) + Number(trade.pnl || 0);
    return best;
  }, {});
  const topSession = Object.entries(bestSession).sort((a, b) => b[1] - a[1])[0]?.[0] || "No session yet";
  const bestStrategy = trades.reduce((best, trade) => {
    const strategy = trade.strategy || "Unknown";
    best[strategy] = (best[strategy] || 0) + Number(trade.pnl || 0);
    return best;
  }, {});
  const topStrategy = Object.entries(bestStrategy).sort((a, b) => b[1] - a[1])[0]?.[0] || "No strategy yet";

  return {
    summary: trades.length
      ? `Your current edge is ${totalPnl >= 0 ? "positive" : "under pressure"}. With ${trades.length} saved trades, win rate is ${winRate}% and the strongest session is ${topSession}. Best strategy: ${topStrategy}.`
      : "Add a few manual XAUUSD trades to unlock your AI report, risk focus, and suggested questions.",
    riskFocus: trades.length
      ? [
          biggestLoss ? `Your largest loss is ${biggestLoss.toFixed(2)} — keep stop distance and lot sizing strict on losing sessions.` : "No major loss yet — stay disciplined and protect the edge you already have.",
          `Profit factor is ${trades.length && wins.length ? (losses.length ? (wins.reduce((sum, trade) => sum + Number(trade.pnl), 0) / biggestLoss) : "strong") : "0.00"} — review risk/reward consistency for better expansion.`,
          totalPnl >= 0 ? "Your expectancy is positive, which means your setup is trending in the right direction." : "Expectancy is still negative — tighten entries and cut poor setups before the next session."
        ]
      : ["No trade history yet — save a few trades to start the AI review."],
    questionBank: trades.length
      ? [
          `Which session produced the best results: ${topSession}?`,
          `Is ${topStrategy} still the highest-quality setup for your next trade?`,
          `How can you reduce risk after ${biggestLoss.toFixed(2)} of drawdown from your worst trade?`
        ]
      : ["What setup should you test first after saving your first trade?", "Which session should you focus on for better consistency?", "How can you improve your first trade plan with a simple risk rule?"]
  };
}

async function askDeepSeek(prompt) {
  if (!deepseekApiKey) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${deepseekApiKey}`
      },
      body: JSON.stringify({
        model: deepseekModel,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.35,
        max_tokens: 720,
        response_format: { type: "json_object" }
      })
    });

    const data = await response.json();
    if (!response.ok) return null;

    return data.choices?.[0]?.message?.content || null;
  } catch (error) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function parseGeminiJson(content) {
  const cleaned = String(content || "").replace(/```json|```/gi, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch (innerError) {
        return null;
      }
    }
    return null;
  }
}

function normalizeAiReport(report, fallback) {
  return {
    summary: String(report?.summary || fallback.summary || "").trim(),
    riskFocus: Array.isArray(report?.riskFocus) && report.riskFocus.length
      ? report.riskFocus.slice(0, 4).map((item) => String(item))
      : fallback.riskFocus,
    questionBank: Array.isArray(report?.questionBank) && report.questionBank.length
      ? report.questionBank.slice(0, 4).map((item) => String(item))
      : fallback.questionBank
  };
}

app.post("/api/ai/report", requireUser, async (req, res) => {
  try {
    const db = await getDb();
    const user = await getUserById(req.user.userId, db);
    if (!user) return res.status(401).json({ message: "Login required." });
    if (!supportsAiReport(user)) {
      return res.status(403).json({
        code: "UPGRADE_REQUIRED",
        message: "AI Report is available on Pro and Elite. Upgrade to use AI analysis from your saved performance data."
      });
    }

    const trades = await loadUserPerformanceTrades(req.user.userId, db);
    const snapshot = buildPerformanceSnapshot(trades);
    const fallback = generateHeuristicReport(trades);
    const prompt = [
      "You are an AI trading performance analyst inside SwanXm Trade Book.",
      "Analyze only the user's saved performance snapshot below. Do not invent trades, balances, deposits, or live positions.",
      "Give practical guidance for XAUUSD-style manual journaling: edge quality, risk behavior, best session, weak point, and next focus.",
      "Return JSON only with keys summary, riskFocus, and questionBank.",
      "summary must be 2-4 concise sentences. riskFocus and questionBank must each contain exactly 3 items.",
      JSON.stringify({ plan: normalizePlan(user.plan), snapshot }, null, 2)
    ].join("\n");

    const content = await askDeepSeek(prompt);
    if (content) {
      const parsed = parseGeminiJson(content);
      if (parsed) return res.json({ report: normalizeAiReport(parsed, fallback), source: "deepseek", model: deepseekModel });
    }

    return res.json({ report: fallback, source: deepseekApiKey ? "fallback" : "not_configured", model: deepseekModel });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.post("/api/ai/chat", requireUser, async (req, res) => {
  try {
    const question = String(req.body.question || "").trim();
    const db = await getDb();
    const user = await getUserById(req.user.userId, db);
    if (!user) return res.status(401).json({ message: "Login required." });
    if (!supportsAiReport(user)) {
      return res.status(403).json({
        code: "UPGRADE_REQUIRED",
        message: "AI chat is available on Pro and Elite. Upgrade to ask questions from your saved performance data."
      });
    }

    const trades = await loadUserPerformanceTrades(req.user.userId, db);
    const snapshot = buildPerformanceSnapshot(trades);

    if (!question) return res.status(400).json({ message: "A question is required." });

    const prompt = [
      "You are an AI trading assistant inside SwanXm Trade Book, helping XAUUSD traders.",
      "Answer the user's question using only the saved performance snapshot below.",
      "Be concise, premium, practical, and specific. Do not invent trades or account data.",
      "Return JSON only with key answer.",
      JSON.stringify({ question, plan: normalizePlan(user.plan), snapshot }, null, 2)
    ].join("\n");

    const answer = await askDeepSeek(prompt);
    if (answer) {
      const parsed = parseGeminiJson(answer);
      if (parsed?.answer) return res.json({ answer: String(parsed.answer), source: "deepseek", model: deepseekModel });
      return res.json({ answer, source: "deepseek", model: deepseekModel });
    }

    return res.json({ answer: "AI is not available right now. Your saved performance data is still ready, and the report panel will use local analysis until the API responds.", source: deepseekApiKey ? "fallback" : "not_configured", model: deepseekModel });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// ── Auto-reconnect helper ─────────────────────────────────────────────────────
// Returns true if the error indicates the MetaApi account is gone/offline.
function isAccountGoneError(err) {
  return /not found|account not found|not deployed|no connection|account.*offline|undeploy|404/i.test(err?.message || "");
}

// Reconnect a user's MetaApi account using saved credentials.
// Re-provisions (or re-deploys) the account, updates the DB, and returns the
// working accountId.  Throws if credentials are missing or provisioning fails.
async function reconnectMetaApiAccount(user, db) {
  if (!user.mt5Login || !user.mt5EncPassword) throw new Error("No MT5 credentials saved. Please re-enter them.");
  const password = decryptMt5Password(user.mt5EncPassword);
  const login    = user.mt5Login;
  const srv      = user.mt5Server || "";

  // First try to redeploy the stored account if it still exists
  if (user.metaApiAccountId) {
    try {
      await metaApi.ensureDeployed(user.metaApiAccountId);
      return user.metaApiAccountId;
    } catch (_) { /* account gone — fall through to full re-provision */ }
  }

  // Full re-provision (finds existing by login+server or creates new)
  const account   = await metaApi.provisionAccount(login, password, srv);
  const accountId = account.id;
  await metaApi.waitForDeployed(accountId, 90000);

  // Persist new accountId
  if (db) {
    await db.collection("users").updateOne(
      { _id: makeMongoUserId(user._id ? String(user._id) : user.id) },
      { $set: { metaApiAccountId: accountId, updatedAt: new Date() } }
    );
  } else {
    const ldb = readLocalDb();
    const u   = ldb.users.find(u => u.id === (user._id ? String(user._id) : user.id));
    if (u) { u.metaApiAccountId = accountId; u.updatedAt = new Date().toISOString(); }
    writeLocalDb(ldb);
  }
  console.log(`[MetaApi reconnect] User ${user.mt5Login} → accountId ${accountId}`);
  return accountId;
}

// ── Real-time MT5 SSE stream ──────────────────────────────────────────────────
// GET /api/mt5/live-stream?token=... — streams positions + PnL as SSE events
// Polls MetaApi every 500ms for open positions, every 5s for new closed deals.

app.get("/api/mt5/live-stream", async (req, res) => {
  const token = String(req.query.token || "");
  const payload = verifyToken(token);
  if (!payload?.userId) return res.status(401).end();

  const db = await getDb();
  const user = await getUserById(payload.userId, db);
  if (!user || !user.metaApiAccountId) return res.status(400).end();

  let accountId = user.metaApiAccountId;   // mutable — may be updated by reconnect
  const login = user.mt5Login || "";
  const server = user.mt5Server || "";
  const userId = payload.userId;

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });

  let closed = false;
  let lastDealCheck = Date.now();
  let knownDealIds = null;

  function send(event, data) {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  send("connected", { ok: true, accountId });

  async function streamTick() {
    if (closed) return;
    try {
      // Fetch open positions every tick (500ms)
      const [positions, accountInfo] = await Promise.all([
        metaApi.fetchOpenPositions(accountId),
        metaApi.fetchAccountInfo(accountId)
      ]);

      const mapped = positions.map(p => ({
        symbol: p.symbol,
        direction: p.type === "POSITION_TYPE_SELL" ? "short" : "long",
        lotSize: Number(p.volume || 0),
        entry: Number(p.openPrice || 0),
        pnl: Number(p.profit || 0),
        swap: Number(p.swap || 0),
        currentPrice: Number(p.currentPrice || 0),
        openTime: p.time ? new Date(p.time * 1000).toLocaleTimeString() : "",
        mt5DealId: String(p.id || "")
      }));

      send("positions", {
        positions: mapped,
        count: mapped.length,
        totalPnl: mapped.reduce((s, p) => s + p.pnl + p.swap, 0),
        account: accountInfo ? {
          balance: Number(accountInfo.balance || 0),
          equity: Number(accountInfo.equity || 0),
          margin: Number(accountInfo.margin || 0),
          freeMargin: Number(accountInfo.freeMargin || 0),
          currency: accountInfo.currency || "",
          leverage: accountInfo.leverage || 0
        } : null,
        ts: Date.now()
      });

      // Every 5s check for new closed deals and auto-import
      if (Date.now() - lastDealCheck > 5000) {
        lastDealCheck = Date.now();
        const deals = await metaApi.fetchAccountHistory(accountId);
        const tradeable = deals.filter(d =>
          d.entryType === "DEAL_ENTRY_OUT" || d.entryType === "DEAL_ENTRY_OUT_BY"
        );

        if (db) {
          const mongoId = makeMongoUserId(userId);
          if (!knownDealIds) {
            const existing = await db.collection("trades").find(
              { userId: mongoId, source: "metaapi" },
              { projection: { mt5DealId: 1 } }
            ).toArray();
            knownDealIds = new Set(existing.map(t => String(t.mt5DealId)));
          }
          const now = new Date();
          let inserted = 0;
          for (const deal of tradeable) {
            const mapped = metaApi.mapDealToTrade(deal, login, server);
            if (knownDealIds.has(mapped.mt5DealId)) continue;
            await db.collection("trades").insertOne({ userId: mongoId, createdAt: now, updatedAt: now, ...mapped });
            knownDealIds.add(mapped.mt5DealId);
            inserted++;
          }
          if (inserted > 0) {
            send("trades_updated", { inserted, message: `${inserted} new trade${inserted > 1 ? "s" : ""} imported.` });
          }
        }

        // Save last sync timestamp
        if (db) {
          await db.collection("users").updateOne(
            { _id: makeMongoUserId(userId) },
            { $set: { mt5EaLastSync: new Date().toISOString(), hasMetaApi: true } }
          );
        }
      }
    } catch (err) {
      if (isAccountGoneError(err)) {
        send("reconnecting", { message: "MT5 account offline — reconnecting automatically…" });
        try {
          const freshUser = await getUserById(userId, db);
          accountId = await reconnectMetaApiAccount(freshUser || user, db);
          send("reconnected", { accountId, message: "MT5 reconnected successfully." });
        } catch (reconnErr) {
          send("error", { message: `Reconnect failed: ${reconnErr.message}`, fatal: true });
          closed = true; // stop the stream — user needs to re-enter creds
          res.end();
          return;
        }
      } else {
        send("error", { message: err.message });
      }
    }

    if (!closed) setTimeout(streamTick, 500);
  }

  // Keepalive ping every 20s to prevent proxy timeouts
  const keepalive = setInterval(() => {
    if (closed) { clearInterval(keepalive); return; }
    res.write(": ping\n\n");
  }, 20000);

  req.on("close", () => {
    closed = true;
    clearInterval(keepalive);
  });

  // Start first tick after brief init delay
  setTimeout(streamTick, 800);
});

app.get(["/", "/index.html"], (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get(["/login", "/login.html"], (req, res) => {
  res.sendFile(path.join(__dirname, "login.html"));
});

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ message: "API route not found." });
  }
  return res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(port, () => {
  const database = mongoUri ? "MongoDB" : "local JSON database";
  console.log(`SwanXm Trade Book API running on http://localhost:${port} with ${database}`);
});
