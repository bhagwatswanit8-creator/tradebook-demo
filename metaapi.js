const META_API_BASE = "https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai";
const META_MARKET_BASE = "https://mt-client-api-v1.london.agiliumtrade.ai";

function metaApiHeaders() {
  return {
    "Content-Type": "application/json",
    "auth-token": process.env.METAAPI_TOKEN || ""
  };
}

async function metaApiFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...metaApiHeaders(), ...(options.headers || {}) }
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { message: text }; }
  if (!res.ok) {
    const msg = json?.message || json?.error || `MetaApi error ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function findExistingAccount(login, server) {
  const accounts = await metaApiFetch(`${META_API_BASE}/users/current/accounts?limit=100`);
  const list = Array.isArray(accounts) ? accounts : (accounts.items || []);
  return list.find(a => String(a.login) === String(login) && a.server === server) || null;
}

async function provisionAccount(login, password, server) {
  const existing = await findExistingAccount(login, server);
  if (existing) {
    if (existing.state === "DEPLOYED") return existing;
    await metaApiFetch(`${META_API_BASE}/users/current/accounts/${existing.id}/deploy`, { method: "POST" });
    return existing;
  }

  const account = await metaApiFetch(`${META_API_BASE}/users/current/accounts`, {
    method: "POST",
    body: JSON.stringify({
      login: String(login),
      password,
      server,
      platform: "mt5",
      name: `SwanXm-${login}`,
      magic: 0,
      application: "MetaApi",
      type: "cloud",
      tags: ["swanxm"]
    })
  });
  return account;
}

async function waitForDeployed(accountId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const account = await metaApiFetch(`${META_API_BASE}/users/current/accounts/${accountId}`);
    if (account.connectionStatus === "CONNECTED" || account.state === "DEPLOYED") return account;
    if (account.state === "DEPLOY_FAILED") throw new Error("MetaApi account deployment failed. Check your MT5 credentials.");
    await sleep(5000);
  }
  throw new Error("MT5 account connection timed out. Please try again.");
}

// Fetch raw account state from provisioning API — null if not found.
async function getAccountState(accountId) {
  try {
    return await metaApiFetch(`${META_API_BASE}/users/current/accounts/${accountId}`);
  } catch (err) {
    if (/not found|404/i.test(err.message)) return null;
    throw err;
  }
}

// Ensure an account is deployed; re-deploys if UNDEPLOYED. Returns account object.
async function ensureDeployed(accountId, timeoutMs = 90000) {
  const account = await getAccountState(accountId);
  if (!account) throw new Error("MetaApi account not found — it may have been removed.");
  if (account.state === "DEPLOYED" || account.connectionStatus === "CONNECTED") return account;
  // Re-deploy if undeploy state
  if (["UNDEPLOYED", "UNDEPLOY_FAILED", "DEPLOY_FAILED"].includes(account.state)) {
    await metaApiFetch(`${META_API_BASE}/users/current/accounts/${accountId}/deploy`, { method: "POST" });
    return waitForDeployed(accountId, timeoutMs);
  }
  // Already in a deploying state — just wait
  return waitForDeployed(accountId, timeoutMs);
}

async function fetchAccountHistory(accountId, from) {
  const fromStr = from ? from.toISOString() : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  const deals = await metaApiFetch(
    `${META_MARKET_BASE}/users/current/accounts/${accountId}/history-deals/time/${fromStr}/${new Date().toISOString()}`
  ).catch(() => []);
  return Array.isArray(deals) ? deals : [];
}

async function fetchOpenPositions(accountId) {
  const positions = await metaApiFetch(
    `${META_MARKET_BASE}/users/current/accounts/${accountId}/positions`
  ).catch(() => []);
  return Array.isArray(positions) ? positions : [];
}

async function fetchAccountInfo(accountId) {
  return metaApiFetch(
    `${META_MARKET_BASE}/users/current/accounts/${accountId}/account-information`
  ).catch(() => null);
}

async function removeAccount(accountId) {
  await metaApiFetch(`${META_API_BASE}/users/current/accounts/${accountId}`, { method: "DELETE" }).catch(() => {});
}

function detectSession(dateStr) {
  if (!dateStr) return "London";
  try {
    const h = new Date(dateStr).getUTCHours();
    if (h >= 0  && h < 7)  return "Asian";
    if (h >= 7  && h < 12) return "London";
    if (h >= 12 && h < 21) return "New York";
    return "Asian";
  } catch { return "London"; }
}

function mapDealToTrade(deal, login, server) {
  const closedAt = deal.time ? new Date(deal.time * 1000).toISOString() : "";
  const date = closedAt ? closedAt.split("T")[0] : new Date().toISOString().split("T")[0];
  const pnl = Number(deal.profit || 0) + Number(deal.swap || 0) + Number(deal.commission || 0);
  const direction = deal.type === "DEAL_TYPE_SELL" ? "short" : "long";
  return {
    date,
    closedAt,
    symbol: String(deal.symbol || "").toUpperCase(),
    direction,
    session: detectSession(closedAt),
    strategy: deal.comment ? String(deal.comment).slice(0, 50) : "MetaApi Sync",
    entry: Number(deal.openPrice || 0),
    exit: Number(deal.closePrice || deal.openPrice || 0),
    lotSize: Number(deal.volume || 0),
    pnl,
    note: `Ticket: ${deal.id || deal.positionId} | Swap: ${deal.swap || 0} | Comm: ${deal.commission || 0}`,
    source: "metaapi",
    mt5DealId: String(deal.id || deal.positionId || ""),
    mt5AccountLogin: String(login),
    mt5Server: String(server)
  };
}

module.exports = {
  provisionAccount,
  waitForDeployed,
  getAccountState,
  ensureDeployed,
  fetchAccountHistory,
  fetchOpenPositions,
  fetchAccountInfo,
  findExistingAccount,
  removeAccount,
  mapDealToTrade
};
