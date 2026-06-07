const API_BASE = window.location.protocol === "file:" ? "http://localhost:5050/api" : "/api";
const AUTH_STORAGE_KEY = "swanxmTradeBookAuth";
const THEME_STORAGE_KEY = "swanxmTradeBookTheme";
const MT5_STORAGE_KEY = "swanxmTradeBookMt5";
const MT5_ACCOUNTS_STORAGE_KEY = "swanxmTradeBookMt5Accounts";
const SETTINGS_STORAGE_KEY = "swanxmTradeBookSettings";
const FREE_TRADE_LIMIT = 10;
const MT5_LIVE_REFRESH_MS = 1000;

let authToken = "";
let currentUser = null;
let currentTrades = [];
let appSettings = loadAppSettings();

const navToggle = document.querySelector("[data-nav-toggle]");
const navLinks = document.querySelector("[data-nav-links]");
const siteNav = document.querySelector(".site-nav");
const authGate = document.querySelector("[data-auth-gate]");
const appWorkspace = document.querySelector("[data-app-workspace]");
const portalMessage = document.querySelector("[data-portal-message]");
const appStatus = document.querySelector("[data-app-status]");
const tradeRows = document.querySelector("[data-trade-rows]");
const tradeForm = document.querySelector("[data-trade-form]");
const syncDemo = document.querySelector("[data-sync-demo]");
const mt5Login = document.querySelector("[data-mt5-login]");
const mt5Password = document.querySelector("[data-mt5-password]");
const mt5Server = document.querySelector("[data-mt5-server]");
const mt5Status = document.querySelector("[data-mt5-status]");
const mt5Message = document.querySelector("[data-mt5-message]");
const mt5TradePreview = document.querySelector("[data-mt5-trade-preview]");
const mt5TradeLists = document.querySelectorAll("[data-live-trades-list], [data-mt5-trade-list]");
const mt5TradeCounts = document.querySelectorAll("[data-live-trades-count], [data-mt5-trade-count]");
const liveTradesCard = document.querySelector("[data-live-trades-card]");
const calendarMonthInput = document.querySelector("[data-calendar-month]");
const calendarPrevButton = document.querySelector("[data-calendar-prev]");
const calendarNextButton = document.querySelector("[data-calendar-next]");
const planLimitNotice = document.querySelector("[data-plan-limit-notice]");

let mt5AutoSyncTimer = null;
let mt5LivePollTimer = null;
let mt5LivePollInFlight = false;
let mt5SyncInFlight = false;
let mt5AnalysisTimer = null;
let liveMt5Positions = [];
let mt5LiveConnectionReady = false;
let mt5LiveStatusMessage = "No open MT5 positions at the moment.";
let lastMt5SyncKey = "";
let lastMt5RenderHash = "";  // Track rendered state to avoid unnecessary DOM updates
let selectedCalendarMonth = getCurrentMonthValue();
let aiReportCacheKey = "";
let aiReportCache = null;

function getCurrentMonthValue() {
  const today = new Date();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  return `${today.getFullYear()}-${month}`;
}
const themeToggle = document.querySelector("[data-theme-toggle]");
const themeIcon = document.querySelector("[data-theme-icon]");

function applyTheme(theme, persist = true) {
  const canUseLightMode = document.body.classList.contains("app-authenticated");
  const nextTheme = canUseLightMode && theme === "light" ? "light" : "dark";
  document.body.classList.toggle("light-theme", nextTheme === "light");
  if (themeIcon) themeIcon.textContent = nextTheme === "light" ? "Light" : "Dark";
  if (themeToggle) {
    themeToggle.setAttribute("aria-label", nextTheme === "light" ? "Switch to dark mode" : "Switch to light mode");
    themeToggle.title = nextTheme === "light" ? "Light mode active" : "Dark mode active";
    themeToggle.dataset.theme = nextTheme;
  }
  if (persist) {
    localStorage.setItem(THEME_STORAGE_KEY, theme === "light" ? "light" : "dark");
    saveThemeToServer(theme);
  }
}

function saveThemeToServer(theme) {
  if (!authToken) return;
  fetch(`${API_BASE}/auth/theme`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${authToken}` },
    body: JSON.stringify({ theme })
  }).catch(() => {});
}

let themeTransitionTimer = null;

function playThemeTransition(nextTheme) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  document.querySelectorAll(".theme-transition-layer").forEach((layer) => layer.remove());
  document.body.classList.remove("theme-switching", "theme-to-light", "theme-to-dark");
  const layer = document.createElement("div");
  layer.className = "theme-transition-layer";
  layer.dataset.nextTheme = nextTheme;
  document.body.appendChild(layer);
  document.body.classList.add("theme-switching", nextTheme === "light" ? "theme-to-light" : "theme-to-dark");
  window.clearTimeout(themeTransitionTimer);
  themeTransitionTimer = window.setTimeout(() => {
    layer.remove();
    document.body.classList.remove("theme-switching", "theme-to-light", "theme-to-dark");
  }, 1500);
}

applyTheme("dark", false);

themeToggle?.addEventListener("click", () => {
  const isLight = document.body.classList.contains("light-theme");
  const nextTheme = isLight ? "dark" : "light";
  appSettings.themePreference = nextTheme;
  saveAppSettings(false);
  playThemeTransition(nextTheme);
  applyTheme(nextTheme);
  renderSettingsState();
});

function defaultAppSettings() {
  return {
    displayName: "",
    handle: "",
    profileNote: "XAUUSD intraday journal",
    preferredSymbol: "XAUUSD",
    defaultSession: "London",
    defaultStrategy: "Liquidity Sweep",
    currency: "USD",
    themePreference: localStorage.getItem(THEME_STORAGE_KEY) || "dark",
    smoothUi: true,
    compactCalendar: false,
    profilePublic: true,
    showLeaderboard: false,
    showTotalPnl: true,
    showWinRate: true
  };
}

function loadAppSettings() {
  try {
    return { ...defaultAppSettings(), ...JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || "{}") };
  } catch (error) {
    return defaultAppSettings();
  }
}

function saveAppSettings(showToast = true) {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(appSettings));
  if (showToast) {
    const state = document.querySelector("[data-settings-save-state]");
    if (state) {
      state.textContent = "Saved just now";
      state.classList.add("saved");
      window.setTimeout(() => state.classList.remove("saved"), 900);
    }
  }
}

function renderSettingsState() {
  const name = appSettings.displayName || currentUser?.name || "SwanXm Trader";
  const email = currentUser?.email || "";

  document.querySelectorAll("[data-setting-field]").forEach((field) => {
    const key = field.dataset.settingField;
    if (!key || document.activeElement === field) return;
    if (key === "displayName") {
      field.value = appSettings.displayName || currentUser?.name || "";
      return;
    }
    if (key === "handle") {
      field.value = appSettings.handle || (currentUser?.email ? `@${currentUser.email.split("@")[0]}` : "");
      return;
    }
    field.value = appSettings[key] ?? "";
  });
  document.querySelectorAll("[data-setting-toggle]").forEach((field) => {
    const key = field.dataset.settingToggle;
    if (key) field.checked = Boolean(appSettings[key]);
  });
  document.querySelectorAll("[data-settings-email]").forEach((field) => {
    field.value = email;
  });
  document.querySelectorAll("[data-current-user]").forEach((node) => {
    node.textContent = name;
  });
  document.querySelectorAll("[data-theme-option]").forEach((button) => {
    button.classList.toggle("active", button.dataset.themeOption === appSettings.themePreference);
  });
  document.querySelectorAll("[data-settings-theme-label]").forEach((node) => {
    node.textContent = appSettings.themePreference === "light" ? "Light" : "Dark";
  });

  document.body.classList.toggle("settings-compact-calendar", Boolean(appSettings.compactCalendar));
  document.body.classList.toggle("settings-reduced-motion", !appSettings.smoothUi);
  applyJournalDefaults();
  populateProfileForm();
}

function applyJournalDefaults() {
  if (!tradeForm) return;
  const symbol = tradeForm.querySelector("select[name='symbol']");
  const session = tradeForm.querySelector("select[name='session']");
  const strategy = tradeForm.querySelector("select[name='strategy']");
  if (symbol) symbol.value = appSettings.preferredSymbol || "XAUUSD";
  if (session) session.value = appSettings.defaultSession || "London";
  if (strategy) strategy.value = appSettings.defaultStrategy || "Liquidity Sweep";
}

function normalizePlan(plan) {
  const value = String(plan || "").toLowerCase();
  if (value.includes("elite")) return "Elite";
  if (value.includes("pro")) return "Pro";
  return "Free";
}

function getCurrentPlan() {
  return normalizePlan(currentUser?.plan);
}

function isFreePlan() {
  return getCurrentPlan() === "Free";
}

function supportsMt5Sync() {
  return getCurrentPlan() === "Pro" || getCurrentPlan() === "Elite";
}

function supportsAiReport() {
  const plan = getCurrentPlan();
  return plan === "Pro" || plan === "Elite";
}

function getMt5AccountLimit() {
  if (getCurrentPlan() === "Elite") return 5;
  if (getCurrentPlan() === "Pro") return 1;
  return 0;
}

function getSavedMt5Accounts() {
  try {
    return Array.isArray(JSON.parse(localStorage.getItem(MT5_ACCOUNTS_STORAGE_KEY) || "[]"))
      ? JSON.parse(localStorage.getItem(MT5_ACCOUNTS_STORAGE_KEY) || "[]")
      : [];
  } catch (error) {
    return [];
  }
}

function getMt5AccountLabel(account) {
  return `${account.login || "MT5"} @ ${account.server || "server"}`;
}

function getManualPerformanceTrades(trades = currentTrades) {
  return getPerformanceTrades(trades).filter((trade) => (trade.source || "manual") === "manual");
}

function renderPlanState() {
  const plan = getCurrentPlan();
  const isFree = plan === "Free";
  const accountLimit = getMt5AccountLimit();
  const savedAccounts = getSavedMt5Accounts();

  document.body.classList.toggle("plan-free", isFree);
  document.body.classList.toggle("plan-pro", !isFree);
  document.querySelectorAll("[data-current-plan]").forEach((node) => {
    node.textContent = plan.toUpperCase();
  });
  document.querySelectorAll("[data-plan-select]").forEach((button) => {
    const buttonPlan = normalizePlan(button.dataset.planSelect);
    const active = buttonPlan === plan;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  document.querySelectorAll("[data-plan-current]").forEach((node) => {
    const nodePlan = normalizePlan(node.dataset.planCurrent);
    node.hidden = nodePlan !== plan;
  });
  document.querySelectorAll("[data-free-limit]").forEach((node) => {
    node.textContent = String(FREE_TRADE_LIMIT);
  });
  document.querySelectorAll("[data-plan-lock='mt5']").forEach((node) => {
    node.hidden = !isFree;
  });
  const canUseAi = supportsAiReport();
  document.body.classList.toggle("plan-ai-locked", !canUseAi);
  document.querySelectorAll("[data-plan-lock='ai']").forEach((node) => {
    node.hidden = canUseAi;
  });
  document.querySelectorAll("[data-ai-premium-content]").forEach((node) => {
    node.hidden = !canUseAi;
  });
  document.querySelectorAll("[data-ai-plan-chip]").forEach((node) => {
    node.textContent = canUseAi ? `${plan} Active` : "Pro / Elite";
  });
  document.querySelectorAll("[data-ai-agent-input], [data-ai-agent-submit]").forEach((node) => {
    node.disabled = !canUseAi;
  });

  if (planLimitNotice) {
    const count = getManualPerformanceTrades().length;
    planLimitNotice.hidden = !isFree;
    planLimitNotice.textContent = `Free plan keeps your latest ${FREE_TRADE_LIMIT} manual trades. You have ${Math.min(count, FREE_TRADE_LIMIT)}/${FREE_TRADE_LIMIT}. Adding trade ${FREE_TRADE_LIMIT + 1} removes your oldest saved trade.`;
  }

  if (!supportsMt5Sync() && syncDemo) {
    setMt5SyncButtonState("locked", "Upgrade to Pro or Elite for MT5 Sync");
    if (mt5Status) mt5Status.value = "MT5 sync is locked on the Free plan. Upgrade to Pro or Elite to connect MT5.";
    setMt5Message("MT5 sync is available on Pro and Elite. Pro allows 1 MT5 account, while Elite allows up to 5.", "warning");
  } else if (syncDemo && syncDemo.dataset.syncState === "locked") {
    setMt5SyncButtonState("idle");
    if (mt5Status) mt5Status.value = "Waiting for account details...";
    setMt5Message("Enter MT5 login, password, and server. SwanXm will use the local MT5 bridge when you click Sync.", "info");
  }

  const accountNote = document.querySelector("[data-mt5-account-note]");
  if (accountNote) {
    const currentLimit = plan === "Elite" ? 5 : plan === "Pro" ? 1 : 0;
    accountNote.textContent = currentLimit > 0
      ? `Current plan: ${plan}. Pro allows 1 MT5 account; Elite allows up to 5.`
      : "MT5 syncing unlocks after you upgrade to Pro or Elite.";
  }
}

async function updateUserPlan(plan) {
  if (!requireLogin()) return;
  const nextPlan = normalizePlan(plan);
  try {
    const result = await apiRequest("/auth/plan", {
      method: "PATCH",
      body: JSON.stringify({ plan: nextPlan })
    });
    currentUser = result.user || { ...currentUser, plan: nextPlan };
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token: authToken, user: currentUser }));
    aiReportCacheKey = "";
    aiReportCache = null;
    renderPlanState();
    await loadTrades();
    showAppStatus(`${nextPlan} mode is active.`, "success");
    if (nextPlan === "Elite") {
      activateAppPanel("mt5");
      prepareMt5AccountView();
    }
  } catch (error) {
    showAppStatus(error.message || "Plan could not be changed.", "error");
  }
}

function showFreeTradeLimitModal() {
  return new Promise((resolve) => {
    const existing = document.querySelector("[data-plan-limit-modal]");
    if (existing) existing.remove();

    const modal = document.createElement("div");
    modal.className = "plan-limit-modal";
    modal.dataset.planLimitModal = "true";
    modal.innerHTML = `
      <div class="plan-limit-dialog" role="dialog" aria-modal="true" aria-labelledby="plan-limit-title">
        <span>Free plan limit</span>
        <h3 id="plan-limit-title">Adding this trade will remove your oldest trade</h3>
        <p>The Free plan stores only your latest ${FREE_TRADE_LIMIT} manual trades. If you continue, trade 1 will be removed and this new trade will become the latest saved trade.</p>
        <div class="plan-limit-actions">
          <button class="ghost-btn" type="button" data-plan-limit-cancel>Cancel</button>
          <button class="pill-btn" type="button" data-plan-limit-confirm>Continue</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const close = (value) => {
      modal.classList.remove("show");
      window.setTimeout(() => modal.remove(), 180);
      resolve(value);
    };

    modal.querySelector("[data-plan-limit-cancel]")?.addEventListener("click", () => close(false));
    modal.querySelector("[data-plan-limit-confirm]")?.addEventListener("click", () => close(true));
    modal.addEventListener("click", (event) => {
      if (event.target === modal) close(false);
    });
    window.setTimeout(() => modal.classList.add("show"), 20);
  });
}

if (navToggle && navLinks) {
  navToggle.addEventListener("click", () => {
    navLinks.classList.toggle("open");
    navToggle.textContent = navLinks.classList.contains("open") ? "x" : "=";
  });
}

function updateNavState() {
  siteNav?.classList.toggle("scrolled", window.scrollY > 24);
}

window.addEventListener("scroll", updateNavState, { passive: true });
updateNavState();

document.querySelectorAll("[data-tabs]").forEach((tabs) => {
  const buttons = tabs.querySelectorAll("[data-tab]");
  const panels = document.querySelectorAll(`[data-tab-panel-group="${tabs.dataset.tabs}"]`);
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      buttons.forEach((item) => item.classList.remove("active"));
      panels.forEach((panel) => panel.classList.remove("active"));
      button.classList.add("active");
      document.querySelector(`[data-tab-panel="${button.dataset.tab}"]`)?.classList.add("active");
    });
  });
});

document.querySelectorAll("[data-faq]").forEach((item) => {
  item.querySelector(".faq-question")?.addEventListener("click", () => item.classList.toggle("open"));
});

document.querySelectorAll("[data-plan]").forEach((button) => {
  button.addEventListener("click", () => {
    window.location.href = "login.html?mode=signup";
  });
});

document.querySelectorAll("[data-toggle-password]").forEach((button) => {
  button.addEventListener("click", () => {
    const input = button.closest(".password-field")?.querySelector("input");
    if (!input) return;
    const isVisible = input.type === "text";
    input.type = isVisible ? "password" : "text";
    button.textContent = isVisible ? "Show" : "Hide";
  });
});

function showAuth(mode) {
  document.querySelectorAll("[data-auth-switch]").forEach((button) => {
    button.classList.toggle("active", button.dataset.authSwitch === mode);
  });
  document.querySelectorAll("[data-auth-form]").forEach((form) => {
    form.classList.toggle("active", form.dataset.authForm === mode);
  });
  if (portalMessage) portalMessage.textContent = "";
  const switchRow = document.querySelector(".auth-switch");
  if (switchRow) switchRow.style.display = (mode === "forgot" || mode === "reset") ? "none" : "";
}

document.querySelectorAll("[data-auth-switch]").forEach((button) => {
  button.addEventListener("click", () => showAuth(button.dataset.authSwitch));
});

const initialAuthMode = new URLSearchParams(window.location.search).get("mode") === "signup" ? "signup" : "login";
showAuth(initialAuthMode);

async function apiRequest(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  } catch (error) {
    throw new Error("Connection failed. Please try again.");
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || "Request failed");
    error.status = response.status;
    error.code = data.code || "";
    throw error;
  }
  return data;
}

document.querySelector("[data-signup-form]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formNode = event.currentTarget;
  const form = new FormData(formNode);
  const password = String(form.get("password") || "");
  const confirmPassword = String(form.get("confirmPassword") || "");
  const mobile = String(form.get("mobile") || "").trim();

  if (password !== confirmPassword) {
    if (portalMessage) portalMessage.textContent = "Passwords do not match.";
    return;
  }

  if (!/^\+?[0-9\s-]{7,18}$/.test(mobile)) {
    if (portalMessage) portalMessage.textContent = "Enter a valid mobile number.";
    return;
  }

  try {
    const session = await apiRequest("/auth/signup", {
      method: "POST",
      body: JSON.stringify({
        name: form.get("name"),
        email: form.get("email"),
        mobile,
        password,
        confirmPassword,
        plan: form.get("plan") || "Free",
        termsAccepted: form.get("termsAccepted") === "on"
      })
    });
    formNode.reset();
    openAuthenticatedApp(session);
  } catch (error) {
    if (portalMessage) portalMessage.textContent = error.message;
  }
});

document.querySelector("[data-forgot-form]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const result = await apiRequest("/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email: form.get("email"), mobile: form.get("mobile") })
    });
    const resetForm = document.querySelector("[data-reset-form]");
    if (resetForm) {
      const tokenInput = resetForm.querySelector("[data-reset-token]");
      if (tokenInput) tokenInput.value = result.token;
    }
    showAuth("reset");
    if (portalMessage) portalMessage.textContent = result.message || "Verified. Set your new password.";
  } catch (error) {
    if (portalMessage) portalMessage.textContent = error.message;
  }
});

document.querySelector("[data-reset-form]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const session = await apiRequest("/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({
        token: form.get("resetToken"),
        password: form.get("password"),
        confirmPassword: form.get("confirmPassword")
      })
    });
    openAuthenticatedApp(session);
  } catch (error) {
    if (portalMessage) portalMessage.textContent = error.message;
  }
});

document.querySelector("[data-login-form]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const session = await apiRequest("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: form.get("email"),
        password: form.get("password")
      })
    });
    openAuthenticatedApp(session);
  } catch (error) {
    if (portalMessage) portalMessage.textContent = error.message;
  }
});

document.querySelector("[data-logout]")?.addEventListener("click", () => {
  authToken = "";
  currentUser = null;
  currentTrades = [];
  localStorage.removeItem(AUTH_STORAGE_KEY);
  document.body.classList.remove("app-authenticated");
  applyTheme("dark", false);
  authGate.hidden = false;
  appWorkspace.hidden = true;
  resetAnalytics();
  showAuth("login");
});

function getMt5CredentialValues() {
  return {
    login: (mt5Login?.value || "").trim().replace(/\s+/g, ""),
    password: mt5Password?.value || "",
    server: mt5Server?.value.trim() || ""
  };
}

function mt5CredentialsReady() {
  const { login, password, server } = getMt5CredentialValues();
  return Boolean(login && password && server);
}

function mt5CredentialKey() {
  const { login, password, server } = getMt5CredentialValues();
  return login && password && server ? `${login}|${server}|${password}` : "";
}

function getMt5AccountQuery() {
  const { login, server } = getMt5CredentialValues();
  if (!/^\d{4,20}$/.test(login) || !server) return "";
  const params = new URLSearchParams({ mt5Login: login, mt5Server: server });
  return `?${params.toString()}`;
}

function loadSavedMt5Credentials() {
  try {
    const saved = JSON.parse(localStorage.getItem(MT5_STORAGE_KEY) || "null");
    if (!saved?.login || !saved?.server) return null;
    if (mt5Login) mt5Login.value = saved.login;
    if (mt5Server) mt5Server.value = saved.server;
    if (mt5Password && saved.password) mt5Password.value = saved.password;
    if (mt5Status) mt5Status.value = saved.connected ? "Account selected. Click Sync MT5 Trades." : "Enter password, then click Sync MT5 Trades.";
    setMt5Message(saved.connected ? "Account selected. Click Sync MT5 Trades to connect through the local bridge." : "Enter password, then click Sync MT5 Trades.", "info");
    return saved;
  } catch (error) {
    return null;
  }
}

function renderMt5TradePreview() {
  const hasTrades = liveMt5Positions.length > 0;  // Only show LIVE positions, not historical trades
  const showPreview = hasTrades || mt5LiveConnectionReady;
  
  // Create hash of current data to only re-render on actual changes
  const currentHash = JSON.stringify({
    ready: mt5LiveConnectionReady,
    message: mt5LiveStatusMessage,
    positions: liveMt5Positions.map(t => ({ ticket: t.mt5DealId, symbol: t.symbol, pnl: t.pnl, entry: t.entry, exit: t.exit }))
  });
  renderDashboardPnlCards();
  if (currentHash === lastMt5RenderHash) {
    return; // No changes, skip DOM updates
  }
  lastMt5RenderHash = currentHash;

  console.log("🎨 Rendering live positions:", hasTrades, liveMt5Positions.length);

  if (liveTradesCard) liveTradesCard.hidden = !showPreview;
  if (mt5TradePreview) mt5TradePreview.hidden = !showPreview;
  mt5TradeCounts.forEach((node) => {
    node.textContent = `${liveMt5Positions.length}`;
  });
  
  const liveHtml = hasTrades
    ? liveMt5Positions.map((trade) => {
        const pnl = Number(trade.pnl || 0);
        const direction = (trade.direction || "").toUpperCase();
        const pnlClass = pnl > 0 ? "profit" : pnl < 0 ? "loss" : "breakeven";
        const openTime = trade.date ? new Date(trade.date).toLocaleTimeString() : "Open";
        return `<div style="display: flex; justify-content: space-between; align-items: center; padding: 12px; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; margin-bottom: 8px; background: rgba(255,255,255,0.02);">
          <div style="flex: 1;">
            <b style="font-size: 14px; color: #fff;">${trade.symbol}</b>
            <div style="font-size: 11px; color: #999; margin-top: 4px;">${direction} • Entry: ${Number(trade.entry || 0).toFixed(2)} • Current: ${Number(trade.exit || 0).toFixed(2)}</div>
            <div style="font-size: 10px; color: #666; margin-top: 2px;">${openTime}</div>
          </div>
          <div style="text-align: right;">
            <em style="display: block; font-size: 14px; font-weight: 600; color: ${pnl > 0 ? '#35ffa8' : pnl < 0 ? '#ff6b6b' : '#999'};">${formatCurrency(pnl)}</em>
            <div style="font-size: 10px; color: #666; margin-top: 4px;">${((pnl / (trade.entry || 1)) * 100).toFixed(2)}%</div>
          </div>
        </div>`;
      }).join("")
    : `<div class="live-trade-empty">
        <strong>MT5 bridge connected</strong>
        <span>${escapeHtml(mt5LiveStatusMessage || "No open MT5 positions at the moment.")}</span>
        <em>Open positions will appear here after you place a live trade on this exact MT5 account.</em>
      </div>`;

  mt5TradeLists.forEach((node) => {
    node.innerHTML = liveHtml;
  });
  
  // Update dashboard open positions in real-time
  renderDashboardOpenPositions();
}

async function refreshLiveMt5Positions() {
  if (mt5LivePollInFlight) return;
  if (!authToken || !supportsMt5Sync()) {
    console.log("❌ MT5 polling skipped: no auth or sync not supported");
    return;
  }
  const { login, password, server } = getMt5CredentialValues();
  if (!login || !password || !server) {
    console.log("❌ MT5 polling skipped: missing credentials", { login: !!login, password: !!password, server: !!server });
    return;
  }

  mt5LivePollInFlight = true;
  try {
    console.log("🔄 Fetching live MT5 positions...", { login, server });
    const result = await apiRequest("/mt5/live", {
      method: "POST",
      body: JSON.stringify({ login, password, server })
    });
    console.log("📡 Server response:", result);
    liveMt5Positions = Array.isArray(result.positions) ? result.positions : [];
    mt5LiveConnectionReady = true;
    mt5LiveStatusMessage = result.message || (liveMt5Positions.length ? "Live MT5 positions refreshed." : "No open MT5 positions at the moment.");
    console.log("✅ Got live positions:", liveMt5Positions.length, liveMt5Positions);
    if (liveMt5Positions.length === 0 && result.message) {
      console.log("⚠️ Message from server:", result.message);
    }
    if (liveMt5Positions.length === 0 && result.message) {
      if (mt5Status) mt5Status.value = result.message;
      setMt5Message(result.message, "info");
    } else if (liveMt5Positions.length > 0) {
      if (mt5Status) mt5Status.value = `${liveMt5Positions.length} live MT5 position${liveMt5Positions.length === 1 ? "" : "s"} fetched.`;
      setMt5Message("Live MT5 positions are updating in real time.", "info");
    }
    renderMt5TradePreview();
  } catch (error) {
    console.error("❌ Live positions error:", error.message, error);
    liveMt5Positions = [];
    mt5LiveConnectionReady = false;
    const message = formatMt5UserMessage(error.message || "Live MT5 positions unavailable.");
    mt5LiveStatusMessage = message;
    if (mt5Status) mt5Status.value = message;
    setMt5Message(message, "error");
    renderDashboardPnlCards();
    renderDashboardOpenPositions();
  } finally {
    mt5LivePollInFlight = false;
  }
}

function startMt5LivePolling() {
  window.clearInterval(mt5LivePollTimer);
  if (!authToken || !supportsMt5Sync()) {
    console.log("❌ Live polling not started: no auth or sync not supported");
    return;
  }
  const { login, password, server } = getMt5CredentialValues();
  if (!login || !password || !server) {
    console.log("❌ Live polling not started: missing credentials");
    return;
  }

  console.log(`STARTING LIVE MT5 POLLING (${MT5_LIVE_REFRESH_MS}ms interval)`);
  void refreshLiveMt5Positions();
  mt5LivePollTimer = window.setInterval(() => {
    void refreshLiveMt5Positions();
  }, MT5_LIVE_REFRESH_MS);
}

function prepareMt5AccountView() {
  window.clearTimeout(mt5AutoSyncTimer);
  window.clearInterval(mt5LivePollTimer);

  if (!authToken) return;
  if (!supportsMt5Sync()) {
    if (mt5Status) mt5Status.value = "MT5 sync is locked until you upgrade to Elite.";
    setMt5Message("MT5 sync is locked on Free. Pro allows 1 MT5 account and Elite allows up to 5.", "warning");
    setMt5SyncButtonState("locked", "Upgrade to Pro or Elite for MT5 Sync");
    if (mt5TradePreview) mt5TradePreview.hidden = true;
    return;
  }

  if (!mt5CredentialsReady()) {
    if (mt5Status) mt5Status.value = "Enter login, password, and server";
    setMt5Message("Enter MT5 login, password, and broker server. SwanXm can launch the local MT5 terminal when Windows allows it; keep the account logged in, then click Sync MT5 Trades.", "info");
    if (mt5TradePreview) mt5TradePreview.hidden = true;
    setMt5SyncButtonState("idle", "Sync MT5 Trades");
    loadTrades().catch(() => {});
    return;
  }

  if (!/^\d{4,20}$/.test(getMt5CredentialValues().login)) {
    if (mt5Status) mt5Status.value = "Enter only the MT5 account number";
    setMt5Message("MT5 login should contain only the account number. Remove spaces, quotes, and symbols.", "error");
    setMt5SyncButtonState("error", "Check MT5 Login");
    return;
  }

  lastMt5SyncKey = "";
  if (mt5Status) mt5Status.value = "Ready. Click Sync MT5 Trades.";
  setMt5Message("Ready to sync. Keep MetaTrader 5 open and logged in to the same account, then click Sync MT5 Trades.", "info");
  setMt5SyncButtonState("ready", "Sync MT5 Trades");

  mt5AutoSyncTimer = window.setTimeout(() => {
    loadTrades().then(() => {
      renderMt5TradePreview();
    }).catch(() => {});
  }, 350);
}

function saveMt5Credentials(login, password, server, connected = true) {
  const account = { login, password, server, connected: Boolean(connected), addedAt: new Date().toISOString() };
  const existingAccounts = getSavedMt5Accounts();
  const limit = getMt5AccountLimit();
  const existingIndex = existingAccounts.findIndex((item) => String(item.login) === String(login) && String(item.server || "") === String(server));

  if (existingIndex >= 0) {
    existingAccounts[existingIndex] = account;
  } else if (limit > 0 && existingAccounts.length >= limit) {
    existingAccounts.splice(0, existingAccounts.length - limit + 1);
    existingAccounts.push(account);
  } else if (limit === 0) {
    existingAccounts.length = 0;
    existingAccounts.push(account);
  } else {
    existingAccounts.push(account);
  }

  localStorage.setItem(MT5_ACCOUNTS_STORAGE_KEY, JSON.stringify(existingAccounts));
  localStorage.setItem(MT5_STORAGE_KEY, JSON.stringify(account));
  return existingAccounts;
}

function clearMt5Credentials() {
  window.clearInterval(mt5LivePollTimer);
  liveMt5Positions = [];
  mt5LiveConnectionReady = false;
  mt5LiveStatusMessage = "MT5 account selection cleared.";
  localStorage.removeItem(MT5_STORAGE_KEY);
  lastMt5SyncKey = "";
  if (mt5Status) mt5Status.value = "Waiting for account details...";
  setMt5Message("MT5 account selection cleared. Enter account details again to sync.", "info");
  if (mt5TradePreview) mt5TradePreview.hidden = true;
  renderDashboardPnlCards();
  renderDashboardOpenPositions();
  setMt5SyncButtonState("idle");
}

function setMt5SyncButtonState(state = "idle", label = "Sync MT5 Trades") {
  if (!syncDemo) return;
  syncDemo.disabled = state === "loading";
  syncDemo.dataset.syncState = state;
  syncDemo.innerHTML = state === "loading"
    ? `<span class="btn-spinner"></span> Syncing MT5`
    : label;
}

function setMt5Message(message, type = "info") {
  if (!mt5Message) return;
  mt5Message.textContent = message;
  mt5Message.dataset.messageType = type;
  mt5Message.classList.toggle("amber", type === "warning");
  mt5Message.classList.toggle("error", type === "error");
  mt5Message.hidden = !message;
}

function formatMt5UserMessage(message) {
  const raw = String(message || "").trim();
  if (!raw) return "MT5 sync failed. Check your account number, password, server, and terminal connection.";
  if (/spawn.*EPERM|EPERM|Windows blocked|ECONNREFUSED|MT5 HTTP bridge unavailable|fetch failed/i.test(raw)) {
    return "MT5 desktop bridge is not running. Start the bridge with: python mt5_http_bridge.py, then click Sync MT5 Trades again.";
  }
  return raw
    .replace(/â€”|—/g, "-")
    .replace(/…|â€¦/g, "...")
    .replace(/\s+/g, " ")
    .trim();
}

async function syncMt5Trades({ auto = false, force = false } = {}) {
  if (!requireLogin()) return null;

  if (!supportsMt5Sync()) {
    const message = "MT5 sync is available on Pro and Elite. Pro allows 1 MT5 account; Elite allows up to 5.";
    if (mt5Status) mt5Status.value = message;
    setMt5Message(message, "warning");
    setMt5SyncButtonState("locked", "Upgrade to Pro or Elite for MT5 Sync");
    if (!auto) showAppStatus(message, "error");
    activateAppPanel("subscription");
    return null;
  }

  const { login, password, server } = getMt5CredentialValues();

  if (!login || !password || !server) {
    if (mt5Status) mt5Status.value = "Enter login, password, and server";
    setMt5Message("All three fields are required: MT5 account number, password, and broker server.", "error");
    setMt5SyncButtonState("idle");
    return null;
  }

  if (!/^\d{4,20}$/.test(login)) {
    const message = "Enter only the MT5 account number, for example 569233626.";
    if (mt5Status) mt5Status.value = message;
    setMt5Message(message, "error");
    if (!auto) showAppStatus(message, "error");
    setMt5SyncButtonState("error", "Check MT5 Login");
    return null;
  }

  const syncKey = mt5CredentialKey();
  if (!force && syncKey && syncKey === lastMt5SyncKey && getPerformanceTrades().length) {
    await loadTrades();
    renderMt5TradePreview();
    renderTradeData();
    return { inserted: 0, updated: 0, totalFromMt5: getPerformanceTrades().length };
  }

  if (mt5SyncInFlight) return null;
  mt5SyncInFlight = true;

  try {
    setMt5SyncButtonState("loading");
    if (mt5Status) mt5Status.value = "Connecting to the MT5 desktop bridge.";
    setMt5Message("Connecting through the desktop MT5 bridge. SwanXm can launch the local terminal when Windows allows it; keep the same account logged in for best results.", "info");
    const result = await apiRequest("/trades/sync-demo", {
      method: "POST",
      body: JSON.stringify({ login, password, server })
    });

    saveMt5Credentials(login, password, server, true);
    if (syncDemo) syncDemo.hidden = false;

    await loadTrades();
    renderMt5TradePreview();
    renderTradeData();

    if (getPerformanceTrades().length > 0 || Number(result.inserted) > 0 || Number(result.updated) > 0) {
      lastMt5SyncKey = syncKey;
    }

    const journalCount = getPerformanceTrades().length || Number(result.journalTotal || 0);
    const parsedFromMt5 = Number(result.totalFromMt5 || 0);

    if (mt5Status) {
      if (journalCount > 0) {
        mt5Status.value = `Connected — ${journalCount} trade${journalCount === 1 ? "" : "s"} in Trades & Analytics (GMT+0)`;
      } else if (parsedFromMt5 > 0) {
        mt5Status.value = `Connected — ${parsedFromMt5} MT5 trade${parsedFromMt5 === 1 ? "" : "s"} parsed, saving…`;
      } else if (Number(result.rawDeals || 0) > 0) {
        mt5Status.value = `Connected — ${result.rawDeals} MT5 deals found, 0 closed trades parsed`;
      } else {
        mt5Status.value = result.message || "Connected — no trade history in MT5 yet";
      }
    }

    if (mt5Status) {
      if (journalCount > 0) {
        mt5Status.value = `Connected - ${journalCount} trade${journalCount === 1 ? "" : "s"} in Trades & Analytics (GMT+0)`;
      } else if (parsedFromMt5 > 0) {
        mt5Status.value = `Connected - ${parsedFromMt5} MT5 trade${parsedFromMt5 === 1 ? "" : "s"} parsed, saving...`;
      } else if (Number(result.rawDeals || 0) > 0) {
        mt5Status.value = `Connected - ${result.rawDeals} MT5 deals found, but 0 closed trades were imported`;
      } else {
        mt5Status.value = result.message || "Connected - no closed trade history found in this MT5 account";
      }
    }

    if (journalCount > 0) {
      showTradesAndAnalysis();
      setMt5Message(result.message || `${journalCount} trades loaded from MT5 into Trades and Analytics.`, "info");
      showAppStatus(result.message || `${journalCount} trades loaded from MT5.`, "success");
      startMt5LivePolling();  // START LIVE POLLING AFTER SUCCESSFUL SYNC
    } else if (!auto) {
      const noTradeMessage = result.message || "MT5 connected, but no closed trades were imported. Deposits and withdrawals are ignored.";
      setMt5Message(noTradeMessage, "warning");
      showAppStatus(noTradeMessage, "info");
      startMt5LivePolling();  // START LIVE POLLING EVEN IF NO TRADES YET
    }

    setMt5SyncButtonState("success", journalCount > 0 ? "Synced Successfully" : "Sync MT5 Trades");
    return result;
  } catch (error) {
    lastMt5SyncKey = "";
    const message = formatMt5UserMessage(error.message || "MT5 sync failed.");
    if (mt5Status) mt5Status.value = message;
    setMt5Message(message, "error");
    if (mt5TradePreview) mt5TradePreview.hidden = true;
    if (error.status === 403 || error.code === "UPGRADE_REQUIRED" || /upgrade to pro|pro plan/i.test(error.message || "")) {
      currentUser = currentUser ? { ...currentUser, plan: "Free" } : currentUser;
      if (currentUser) localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token: authToken, user: currentUser }));
      renderPlanState();
      activateAppPanel("subscription");
    } else {
      scrollAppPanelToTop("mt5");
    }
    if (!auto) showAppStatus(message, "error");
    setMt5SyncButtonState("error", "Retry MT5 Sync");
    throw error;
  } finally {
    mt5SyncInFlight = false;
    window.setTimeout(() => {
      if (syncDemo?.dataset.syncState === "success") setMt5SyncButtonState("idle");
    }, 2600);
  }
}

function openAuthenticatedApp(session) {
  authToken = session.token;
  currentUser = session.user;
  if (authToken && currentUser) {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token: authToken, user: currentUser }));
  }
  document.body.classList.add("app-authenticated");
  const serverTheme = session.user?.theme;
  const resolvedTheme = serverTheme || appSettings.themePreference || localStorage.getItem(THEME_STORAGE_KEY) || "dark";
  if (serverTheme) { appSettings.themePreference = serverTheme; localStorage.setItem(THEME_STORAGE_KEY, serverTheme); }
  applyTheme(resolvedTheme, false);
  authGate.hidden = true;
  appWorkspace.hidden = false;
  document.querySelectorAll("[data-current-user]").forEach((node) => node.textContent = currentUser.name || "SwanXm Trader");
  document.querySelectorAll("[data-current-email]").forEach((node) => node.textContent = currentUser.email || "");
  renderSettingsState();
  renderPlanState();
  renderMetaApiPanel();
  activateAppPanel("dashboard");
  loadTrades().then(() => {
    renderPlanState();
    renderMt5TradePreview();
  });
  // Silent background MT5 sync — user sees nothing, data just appears
  silentMt5AutoSync();
  startEaStatusPolling();
}

async function restoreAuthenticatedApp() {
  let savedSession;
  try {
    savedSession = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || "null");
  } catch (error) {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    return false;
  }

  if (!savedSession?.token) return false;

  // SET TOKEN FIRST - keep it even if verification fails
  authToken = savedSession.token;
  console.log("✅ Restored auth token from localStorage");
  
  try {
    const result = await apiRequest("/auth/me");
    console.log("✅ Auth verified with server:", result.user);
    openAuthenticatedApp({ token: authToken, user: result.user });
    return true;
  } catch (error) {
    console.warn("⚠️ Auth verification failed:", error.message);
    // KEEP THE TOKEN - don't clear it on verification failure
    // Just open the app with cached user info or default info
    console.log("📍 Continuing with cached token anyway...");
    loadTrades().catch(() => {});
    renderTradeData();
    if (mt5CredentialsReady()) {
      prepareMt5AccountView();
    }
    return true; // Still return true so app keeps running
  }
}

function requireLogin() {
  if (!authToken) {
    if (portalMessage) portalMessage.textContent = "Login with email and password first.";
    return false;
  }
  return true;
}

let appStatusTimer;

function showAppStatus(message, type = "info") {
  if (!appStatus) return;
  window.clearTimeout(appStatusTimer);
  appStatus.textContent = message;
  appStatus.hidden = false;
  appStatus.className = `app-status ${type}`.trim();
  appStatusTimer = window.setTimeout(() => {
    appStatus.hidden = true;
  }, 4500);
}

const NAV_GROUP_CHILDREN = {
  analysis: new Set(["performance", "trade-analysis"]),
  "traders-lounge": new Set(["lounge", "leaderboard"])
};

function setNavGroupOpen(groupName, open) {
  const group = document.querySelector(`[data-nav-group="${groupName}"]`);
  const toggle = document.querySelector(`[data-nav-group-toggle="${groupName}"]`);
  if (!group || !toggle) return;

  window.clearTimeout(group._sxmCloseTimer);
  if (open) {
    group.hidden = false;
    requestAnimationFrame(() => group.classList.add("open"));
  } else {
    group.classList.remove("open");
    group._sxmCloseTimer = window.setTimeout(() => {
      if (!group.classList.contains("open")) group.hidden = true;
    }, 220);
  }
  toggle.classList.toggle("open", open);
  toggle.setAttribute("aria-expanded", String(open));
}

function syncNavGroups(panelName) {
  Object.entries(NAV_GROUP_CHILDREN).forEach(([groupName, children]) => {
    const active = children.has(panelName);
    setNavGroupOpen(groupName, active);
    document.querySelector(`[data-nav-group-toggle="${groupName}"]`)?.classList.toggle("active", active);
  });
}

function scrollAppPanelToTop(panelName, behavior = "smooth") {
  const activePanel = document.querySelector(`[data-app-panel="${panelName}"]`);
  const scrollTargets = [
    document.scrollingElement,
    document.documentElement,
    document.body,
    document.querySelector(".sxm-main"),
    document.querySelector(".sxm-content")
  ].filter(Boolean);

  scrollTargets.forEach((target) => {
    if (typeof target.scrollTo === "function") {
      target.scrollTo({ top: 0, left: 0, behavior });
      return;
    }
    target.scrollTop = 0;
    target.scrollLeft = 0;
  });

  window.requestAnimationFrame(() => {
    if (panelName === "mt5") {
      document.querySelector('.sxm-page[data-app-panel="mt5"].active .mt5-connect-card')?.scrollIntoView({ block: "start", behavior });
      return;
    }
    activePanel?.scrollIntoView({ block: "start", behavior });
  });
}

// ── EA Direct Integration ────────────────────────────────────────────────────

let eaStatusPollTimer = null;

async function loadEaTokenAndStatus() {
  if (!requireLogin()) return;
  try {
    const [tokenData, statusData] = await Promise.all([
      apiRequest("/mt5/ea-token"),
      apiRequest("/mt5/ea-status")
    ]);
    const tokenInput = document.querySelector("[data-ea-token]");
    const urlInput   = document.querySelector("[data-ea-push-url]");
    if (tokenInput) tokenInput.value = tokenData.token || "";
    if (urlInput)   urlInput.value   = tokenData.pushUrl || "";
    renderEaStatus(statusData);
    clearInterval(eaStatusPollTimer);
    eaStatusPollTimer = setInterval(async () => {
      const panel = document.querySelector('[data-app-panel="mt5"]');
      if (!panel?.classList.contains("active")) { clearInterval(eaStatusPollTimer); return; }
      try { renderEaStatus(await apiRequest("/mt5/ea-status")); } catch {}
    }, 30000);
  } catch (err) {
    const tokenInput = document.querySelector("[data-ea-token]");
    if (tokenInput) tokenInput.placeholder = "Error loading token";
  }
}

function renderEaStatus(data) {
  const lastSyncEl = document.querySelector("[data-ea-last-sync]");
  const accountEl  = document.querySelector("[data-ea-account-name]");
  const posCountEl = document.querySelector("[data-ea-position-count]");
  const posListEl  = document.querySelector("[data-ea-position-list]");
  const badgeEl    = document.querySelector("[data-ea-sync-badge]");
  const msgEl      = document.querySelector("[data-mt5-message]");
  if (!data?.ok) return;
  const hasSynced = Boolean(data.lastSync);
  if (lastSyncEl) {
    if (hasSynced) {
      const d = new Date(data.lastSync);
      const ago = Math.round((Date.now() - d.getTime()) / 1000);
      const agoStr = ago < 60 ? ago + "s ago" : ago < 3600 ? Math.round(ago/60) + "m ago" : Math.round(ago/3600) + "h ago";
      lastSyncEl.textContent = "Last synced: " + d.toLocaleTimeString() + " (" + agoStr + ")";
    } else {
      lastSyncEl.textContent = "Not synced yet \u2014 install the EA to begin";
    }
  }
  if (accountEl && data.account) {
    const acc = data.account;
    let accTxt = acc.accountName ? acc.accountName + " \u00b7 " + acc.accountLogin : (acc.accountLogin || "");
    if (acc.accountServer) accTxt += " \u00b7 " + acc.accountServer;
    if (acc.balance != null) accTxt += " \u00b7 Balance: " + Number(acc.balance).toFixed(2) + " " + (acc.currency || "");
    accountEl.textContent = accTxt;
  }
  const posCount = data.positionCount || 0;
  if (posCountEl) posCountEl.textContent = posCount > 0 ? posCount : "\u2014";
  if (badgeEl)   badgeEl.hidden = !hasSynced;
  if (msgEl && hasSynced) {
    msgEl.textContent = "EA is active. Trades and open positions sync automatically every 30 seconds.";
  }
  if (posListEl) {
    if (posCount === 0) {
      posListEl.innerHTML = hasSynced ? '<div style="opacity:.5;font-size:0.85rem;padding:6px 0">No open positions right now.</div>' : "";
    } else {
      posListEl.innerHTML = (data.positions || []).map(function(p) {
        const pnlColor = Number(p.pnl) >= 0 ? "#35ffa8" : "#ff6b6b";
        const dir = String(p.direction || "").toUpperCase();
        const pnlStr = (Number(p.pnl) >= 0 ? "+" : "") + Number(p.pnl || 0).toFixed(2);
        return '<div class="trade-row" style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.06)">'
          + '<span style="font-size:0.82rem;opacity:.8">' + escapeHtml(p.symbol || "") + ' <strong>' + dir + '</strong> ' + (p.lotSize || "") + 'L \u00b7 open ' + escapeHtml(p.openTime || "") + '</span>'
          + '<strong style="color:' + pnlColor + '">' + pnlStr + '</strong></div>';
      }).join("");
    }
  }
  if (hasSynced) loadTrades().then(renderTradeData).catch(function(){});
}

// ── Background EA polling (always on after login) ────────────────────────────

function startEaStatusPolling() {
  clearInterval(eaStatusPollTimer);
  if (!authToken) return;
  // Immediate first check
  apiRequest("/mt5/ea-status").then(renderEaStatus).catch(() => {});
  // Then every 30s silently
  eaStatusPollTimer = setInterval(() => {
    if (!authToken) { clearInterval(eaStatusPollTimer); return; }
    apiRequest("/mt5/ea-status").then(data => {
      renderEaStatus(data);
      if (data?.lastSync) {
        loadTrades().then(() => { renderMt5TradePreview(); renderTradeData(); }).catch(() => {});
      }
    }).catch(() => {});
  }, 30000);
}

// ── MetaApi cloud MT5 panel ───────────────────────────────────────────────────

function renderMetaApiPanel() {
  const connected = currentUser?.hasMetaApi || currentUser?.hasMt5Creds;
  const connectedEl = document.querySelector("[data-metaapi-connected]");
  const formEl = document.querySelector("[data-metaapi-connect-form]");
  const loginDisplay = document.querySelector("[data-metaapi-login-display]");
  const serverDisplay = document.querySelector("[data-metaapi-server-display]");
  const msgEl = document.querySelector("[data-mt5-message]");

  if (connectedEl) connectedEl.hidden = !connected;
  if (formEl) formEl.hidden = connected;
  if (connected) {
    if (loginDisplay) loginDisplay.textContent = currentUser.mt5Login || "—";
    if (serverDisplay) serverDisplay.textContent = currentUser.mt5Server || "—";
    if (msgEl) {
      msgEl.textContent = currentUser.hasMetaApi
        ? "Connected via cloud — trades sync automatically."
        : "Credentials saved. Cloud connection pending...";
      msgEl.hidden = false;
    }
  } else {
    if (msgEl) {
      msgEl.textContent = "Enter your MT5 credentials below to connect your account automatically via the cloud.";
      msgEl.hidden = false;
    }
  }
}

// Connect form submit
document.querySelector("[data-metaapi-connect-form]")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!requireLogin()) return;
  const form = new FormData(e.currentTarget);
  const login = String(form.get("maLogin") || "").trim().replace(/\s+/g, "");
  const password = String(form.get("maPassword") || "");
  const server = String(form.get("maServer") || "").trim();
  const btn = e.currentTarget.querySelector("[data-metaapi-connect-btn]");

  if (!login || !password || !server) {
    showAppStatus("Enter your MT5 account number, password, and broker server.", "error");
    return;
  }
  if (!/^\d{4,20}$/.test(login)) {
    showAppStatus("MT5 account number should be numeric only.", "error");
    return;
  }

  const orig = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "Connecting…"; }
  try {
    const result = await apiRequest("/mt5/metaapi-connect", {
      method: "POST",
      body: JSON.stringify({ login, password, server })
    });
    if (result.ok) {
      if (currentUser) {
        currentUser.hasMt5Creds = true;
        currentUser.mt5Login = login;
        currentUser.mt5Server = server;
        localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token: authToken, user: currentUser }));
      }
      renderMetaApiPanel();
      showAppStatus("MT5 connected! Syncing your trade history in the background…", "success");
      e.currentTarget.reset();
      // Reload trades after 30s to pick up imported data
      setTimeout(() => {
        loadTrades().then(() => { renderMt5TradePreview(); renderTradeData(); }).catch(() => {});
      }, 30000);
    } else {
      showAppStatus(result.message || "Could not connect MT5.", "error");
    }
  } catch (err) {
    showAppStatus(err.message || "Could not connect MT5.", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = orig; }
  }
});

// Sync Now button
document.querySelector("[data-metaapi-sync-btn]")?.addEventListener("click", async () => {
  if (!requireLogin()) return;
  const btn = document.querySelector("[data-metaapi-sync-btn]");
  const orig = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "Syncing…"; }
  try {
    const result = await apiRequest("/mt5/metaapi-sync", { method: "POST" });
    if (result.ok) {
      showAppStatus(`Sync complete — ${result.inserted || 0} new trades imported.`, "success");
      await loadTrades();
      renderMt5TradePreview();
      renderTradeData();
    } else {
      showAppStatus(result.message || "Sync failed.", "error");
    }
  } catch (err) {
    showAppStatus(err.message || "Sync failed.", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = orig; }
  }
});

// Disconnect button
document.querySelector("[data-metaapi-disconnect-btn]")?.addEventListener("click", async () => {
  if (!requireLogin()) return;
  try {
    await apiRequest("/mt5/metaapi-disconnect", { method: "DELETE" });
    if (currentUser) {
      currentUser.hasMt5Creds = false;
      currentUser.hasMetaApi = false;
      currentUser.mt5Login = "";
      currentUser.mt5Server = "";
      currentUser.metaApiAccountId = "";
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token: authToken, user: currentUser }));
    }
    renderMetaApiPanel();
    showAppStatus("MT5 disconnected.", "info");
  } catch (err) {
    showAppStatus("Could not disconnect.", "error");
  }
});

// ── Silent MT5 auto-sync using saved backend credentials ─────────────────────

let mt5BackgroundSyncPending = false;

async function silentMt5AutoSync() {
  if (!authToken || mt5BackgroundSyncPending) return;
  if (!currentUser?.hasMt5Creds) return;
  mt5BackgroundSyncPending = true;
  try {
    // Use MetaApi sync if connected via cloud
    const result = await apiRequest("/mt5/metaapi-sync", { method: "POST" });
    if (result.ok && result.inserted > 0) {
      setTimeout(() => {
        loadTrades().then(() => { renderMt5TradePreview(); renderTradeData(); }).catch(() => {});
      }, 2000);
    }
    renderMetaApiPanel();
  } catch (e) {
    // Silent — never show this error to user
  } finally {
    mt5BackgroundSyncPending = false;
  }
}

// ── MT5 credential panel renderer (kept for compat) ─────────────────────────

function renderMt5CredentialPanel() {
  renderMetaApiPanel();
}

// ── Save MT5 credentials to backend ──────────────────────────────────────────

async function saveMt5CredsToBackend(login, password, server) {
  try {
    await apiRequest("/mt5/credentials", {
      method: "POST",
      body: JSON.stringify({ login, password, server })
    });
    // Update cached user object
    if (currentUser) {
      currentUser.hasMt5Creds = true;
      currentUser.mt5Login = login;
      currentUser.mt5Server = server;
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token: authToken, user: currentUser }));
    }
    return true;
  } catch (e) {
    return false;
  }
}


document.addEventListener("click", function(e) {
  if (e.target.matches("[data-copy-ea-token]")) {
    const val = document.querySelector("[data-ea-token]")?.value || "";
    if (val) { navigator.clipboard.writeText(val).catch(function(){}); showAppStatus("EA Token copied!", "success"); }
  }
  if (e.target.matches("[data-copy-ea-url]")) {
    const val = document.querySelector("[data-ea-push-url]")?.value || "";
    if (val) { navigator.clipboard.writeText(val).catch(function(){}); showAppStatus("Server URL copied!", "success"); }
  }
});

// ─────────────────────────────────────────────────────────────────────────────

function activateAppPanel(panelName) {
  if (panelName === "mt5" && !supportsMt5Sync()) {
    showAppStatus("MT5 sync is locked on Free. Upgrade to Pro or Elite to connect MT5.", "error");
    panelName = "subscription";
  }
  document.querySelectorAll("[data-app-tab]").forEach((button) => button.classList.toggle("active", button.dataset.appTab === panelName));
  document.querySelectorAll("[data-app-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.appPanel === panelName));
  syncNavGroups(panelName);
  const title = document.querySelector(`[data-app-tab="${panelName}"]`)?.textContent?.trim() || "Dashboard";
  const titleNode = document.querySelector("[data-page-title]");
  if (titleNode) titleNode.textContent = title;
  scrollAppPanelToTop(panelName);
  if (panelName === "mt5") loadEaTokenAndStatus();
  if (panelName === "mt5" && mt5CredentialsReady()) prepareMt5AccountView();
  if (panelName === "tools") showToolsHome();
  if (panelName === "market") renderEconomicCalendar();
}

document.querySelectorAll("[data-app-tab]").forEach((button) => {
  button.addEventListener("click", () => activateAppPanel(button.dataset.appTab));
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-nav-group-toggle]");
  if (!button) return;
  event.preventDefault();
  const groupName = button.dataset.navGroupToggle;
  const group = document.querySelector(`[data-nav-group="${groupName}"]`);
  setNavGroupOpen(groupName, Boolean(group?.hidden));
});

document.querySelectorAll("[data-app-tab-jump]").forEach((button) => {
  button.addEventListener("click", () => activateAppPanel(button.dataset.appTabJump));
});

document.querySelectorAll("[data-plan-select]").forEach((button) => {
  button.addEventListener("click", () => updateUserPlan(button.dataset.planSelect));
});

function formatCurrency(value) {
  const amount = Number(value) || 0;
  return `${amount < 0 ? "-" : ""}$${Math.abs(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatGmtLabel(closedAt, date) {
  if (closedAt) {
    const parsed = new Date(closedAt);
    if (!Number.isNaN(parsed.getTime())) {
      return `${parsed.toLocaleString("en-GB", {
        timeZone: "UTC",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      })} GMT`;
    }
  }
  return date ? `${date} GMT` : "-";
}

function showTradesAndAnalysis() {
  if (!getPerformanceTrades().length) return;

  renderTradeData();
  activateAppPanel("trades");

  window.clearTimeout(mt5AnalysisTimer);
  mt5AnalysisTimer = window.setTimeout(() => {
    activateAppPanel("performance");
    const firstTradeButton = document.querySelector("[data-trade-list] [data-trade-index='0']");
    firstTradeButton?.click();
  }, 800);
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
}

function calculateTradePnl({ direction, entry, exit, lotSize }) {
  const entryPrice = Number(entry || 0);
  const exitPrice = Number(exit || 0);
  const size = Number(lotSize || 0);
  if (!entryPrice || !exitPrice || !size) return 0;
  const priceDifference = String(direction).toLowerCase() === "short"
    ? entryPrice - exitPrice
    : exitPrice - entryPrice;
  return Number((priceDifference * size * 100).toFixed(2));
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
  if (isOpenPosition) return false;
  return Number(trade.entry || 0) > 0 && Number(trade.exit || 0) > 0;
}

function getPerformanceTrades(trades = currentTrades) {
  return (Array.isArray(trades) ? trades : []).filter(isPerformanceTrade);
}

function getLiveMt5Summary() {
  const positions = Array.isArray(liveMt5Positions) ? liveMt5Positions : [];
  const pnl = positions.reduce((sum, position) => sum + Number(position.pnl || 0), 0);
  const winners = positions.filter((position) => Number(position.pnl || 0) > 0).length;
  const losers = positions.filter((position) => Number(position.pnl || 0) < 0).length;
  return { positions, pnl, winners, losers, count: positions.length };
}

function updateMoneyNode(node, amount) {
  if (!node) return;
  node.textContent = formatCurrency(amount);
  node.classList.toggle("profit", amount > 0);
  node.classList.toggle("loss", amount < 0);
  node.classList.toggle("breakeven", amount === 0);
}

function renderDashboardPnlCards(trades = getPerformanceTrades()) {
  const analytics = calculateAnalytics(trades);
  const liveSummary = getLiveMt5Summary();
  const realizedPnl = analytics.totalPnl || 0;
  const unrealizedPnl = liveSummary.pnl || 0;
  const totalPnl = realizedPnl + unrealizedPnl;

  document.querySelectorAll("[data-dashboard-total-pnl]").forEach((node) => updateMoneyNode(node, totalPnl));
  document.querySelectorAll("[data-realized-pnl]").forEach((node) => updateMoneyNode(node, realizedPnl));
  document.querySelectorAll("[data-unrealized-pnl]").forEach((node) => updateMoneyNode(node, unrealizedPnl));
  document.querySelectorAll("[data-dashboard-total-detail]").forEach((node) => {
    node.textContent = `Realized ${formatCurrency(realizedPnl)} + open ${formatCurrency(unrealizedPnl)}`;
  });
  document.querySelectorAll("[data-realized-detail]").forEach((node) => {
    node.textContent = `${trades.length} closed trade${trades.length === 1 ? "" : "s"} - ${analytics.winRate}% win rate`;
  });
  document.querySelectorAll("[data-unrealized-detail]").forEach((node) => {
    node.textContent = liveSummary.count
      ? `${liveSummary.count} live MT5 position${liveSummary.count === 1 ? "" : "s"}`
      : "No live MT5 positions";
  });
  document.querySelectorAll("[data-dashboard-win-rate]").forEach((node) => {
    node.textContent = `${analytics.winRate}%`;
  });
  document.querySelectorAll("[data-dashboard-win-rate-bar]").forEach((node) => {
    node.style.width = `${analytics.winRate}%`;
  });
  document.querySelectorAll("[data-dashboard-win-detail]").forEach((node) => {
    const wins = trades.filter((trade) => Number(trade.pnl || 0) > 0).length;
    node.textContent = `${wins} win${wins === 1 ? "" : "s"} from ${trades.length} closed trade${trades.length === 1 ? "" : "s"}`;
  });
  document.querySelectorAll("[data-open-positions]").forEach((node) => {
    node.textContent = liveSummary.count
      ? `${liveSummary.count} open position${liveSummary.count === 1 ? "" : "s"}`
      : "No open positions";
  });
}

function groupTotals(trades, key) {
  return Object.entries(trades.reduce((acc, trade) => {
    const label = key === "day"
      ? new Date(`${trade.date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" })
      : trade[key] || "-";
    acc[label] = (acc[label] || 0) + Number(trade.pnl || 0);
    return acc;
  }, {})).sort((a, b) => b[1] - a[1]);
}

function bestOf(trades, key) {
  return groupTotals(trades, key)[0]?.[0] || "-";
}

function dayPnlSummary(trades, mode = "best") {
  const totals = groupTotals(trades, "day");
  if (!totals.length) return "-";
  const row = mode === "worst"
    ? [...totals].sort((a, b) => a[1] - b[1])[0]
    : totals[0];
  return `${row[0]} ${formatCurrency(row[1])}`;
}

function calculateAnalytics(trades) {
  trades = getPerformanceTrades(trades);
  const wins = trades.filter((trade) => Number(trade.pnl) > 0);
  const losses = trades.filter((trade) => Number(trade.pnl) < 0);
  const totalPnl = trades.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
  const grossProfit = wins.reduce((sum, trade) => sum + Number(trade.pnl), 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + Number(trade.pnl), 0));
  const winRate = trades.length ? Math.round((wins.length / trades.length) * 100) : 0;
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const biggestWin = wins.reduce((max, trade) => Math.max(max, Number(trade.pnl)), 0);
  const biggestLoss = losses.reduce((min, trade) => Math.min(min, Number(trade.pnl)), 0);
  const profitFactor = grossLoss ? grossProfit / grossLoss : grossProfit ? Infinity : 0;
  return { totalPnl, winRate, avgWin, avgLoss, biggestWin, biggestLoss, profitFactor, expectancy: trades.length ? totalPnl / trades.length : 0 };
}

function populateProfileForm() {
  if (!currentUser) return;
  const form = document.querySelector("[data-profile-form]");
  if (!form) return;
  const nameField   = form.querySelector("[data-profile-name]");
  const emailField  = form.querySelector("[data-profile-email]");
  const mobileField = form.querySelector("[data-profile-mobile]");
  if (nameField   && document.activeElement !== nameField)   nameField.value   = currentUser.name   || "";
  if (emailField  && document.activeElement !== emailField)  emailField.value  = currentUser.email  || "";
  if (mobileField && document.activeElement !== mobileField) mobileField.value = currentUser.mobile || "";
}

document.querySelector("[data-profile-form]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formNode = event.currentTarget;
  const form     = new FormData(formNode);
  const msgNode  = formNode.querySelector("[data-profile-message]");
  const stateNode = document.querySelector("[data-profile-save-state]");
  const submitBtn = formNode.querySelector("[type=submit]");
  if (msgNode) msgNode.textContent = "";
  if (submitBtn) submitBtn.disabled = true;
  try {
    const session = await apiRequest("/auth/profile", {
      method: "PATCH",
      body: JSON.stringify({
        name:            form.get("name"),
        email:           form.get("email"),
        mobile:          form.get("mobile"),
        currentPassword: form.get("currentPassword"),
        newPassword:     form.get("newPassword") || undefined,
        confirmPassword: form.get("confirmPassword") || undefined
      })
    });
    authToken   = session.token;
    currentUser = session.user;
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token: authToken, user: currentUser }));
    formNode.querySelector("[name=currentPassword]").value = "";
    formNode.querySelector("[name=newPassword]").value     = "";
    formNode.querySelector("[name=confirmPassword]").value = "";
    renderSettingsState();
    if (stateNode) { stateNode.textContent = "✓ Saved"; stateNode.style.color = "var(--green, #4ade80)"; }
    if (msgNode)   { msgNode.textContent = session.message || "Profile updated."; msgNode.style.color = "var(--green, #4ade80)"; }
    showAppStatus("Profile updated successfully.", "success");
  } catch (error) {
    if (msgNode)   { msgNode.textContent = error.message; msgNode.style.color = ""; }
    if (stateNode) { stateNode.textContent = "Error"; stateNode.style.color = "var(--red, #f87171)"; }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
});

async function loadTrades() {
  if (!requireLogin()) return;
  const result = await apiRequest(`/trades${getMt5AccountQuery()}`);
  currentTrades = Array.isArray(result.trades) ? result.trades : [];
  renderTradeData();
}

function resetAnalytics() {
  currentTrades = [];
  renderTradeData();
}

function getAiReportCacheKey(trades) {
  return JSON.stringify({
    plan: getCurrentPlan(),
    count: trades.length,
    pnl: trades.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0).toFixed(2),
    latest: trades.slice(0, 8).map((trade) => [
      trade.id,
      trade.date,
      trade.symbol,
      trade.direction,
      trade.entry,
      trade.exit,
      trade.lotSize,
      trade.pnl
    ].join("|"))
  });
}

async function generateAiReport(trades) {
  trades = getPerformanceTrades(trades);

  if (!supportsAiReport()) {
    return {
      source: "locked",
      summary: "Gemini AI Report is locked on Free. Switch to Pro or Elite to generate answers from your saved performance data.",
      riskFocus: [
        "Free users can still add manual trades and view standard performance analytics.",
        "Pro and Elite unlock Gemini analysis based on your saved trade history.",
        "After upgrading, Gemini will review P&L, win rate, best session, strategy quality, and risk behavior."
      ],
      questionBank: [
        "What is my strongest session?",
        "Which strategy should I focus on next?",
        "Where is my risk discipline weakest?"
      ]
    };
  }

  if (!authToken) {
    const analytics = calculateAnalytics(trades);
    const bestSession = bestOf(trades, "session");
    const bestStrategy = bestOf(trades, "strategy");
    const biggestLoss = analytics.biggestLoss || 0;
    const winRate = analytics.winRate || 0;

    return {
      summary: trades.length
        ? `Your current edge is ${analytics.totalPnl >= 0 ? "positive" : "under pressure"}. With ${trades.length} saved trades, win rate is ${winRate}% and the strongest session is ${bestSession}. Best strategy: ${bestStrategy}.`
        : "Add a few manual XAUUSD trades to unlock your AI report, risk focus, and suggested questions.",
      riskFocus: trades.length
        ? [
            biggestLoss ? `Your worst trade loss is ${formatCurrency(biggestLoss)} — keep stop distance and lot sizing strict on losing sessions.` : "No major loss yet — stay disciplined and protect the edge you already have.",
            analytics.profitFactor === Infinity ? "Profit factor is strong, so your setup quality is currently outperforming risk taken." : `Profit factor is ${analytics.profitFactor === 0 ? "0.00" : analytics.profitFactor.toFixed(2)} — review risk/reward consistency if you want better expansion.`,
            analytics.expectancy >= 0 ? "Your expectancy is positive, which means your setup is trending in the right direction." : "Expectancy is still negative — tighten entries and cut poor setups before the next session."
          ]
        : ["No trade history yet — save a few trades to start the AI review."],
      questionBank: trades.length
        ? [
            `Which session produced the best results: ${bestSession || "unknown"}?`,
            `Is ${bestStrategy || "your current strategy"} still the highest-quality setup for your next trade?`,
            `How can you reduce risk after ${formatCurrency(Math.abs(biggestLoss))} of drawdown from your worst trade?`
          ]
        : ["What setup should you test first after saving your first XAUUSD trade?", "Which session should you focus on for better consistency?", "How can you improve your first trade plan with a simple risk rule?"]
    };
  }

  const cacheKey = getAiReportCacheKey(trades);
  if (aiReportCache && aiReportCacheKey === cacheKey) return aiReportCache;

  try {
    const result = await apiRequest("/ai/report", {
      method: "POST",
      body: JSON.stringify({})
    });
    if (result?.report) {
      aiReportCacheKey = cacheKey;
      aiReportCache = { ...result.report, source: result.source || "gemini" };
      return aiReportCache;
    }
  } catch (error) {
    if (error.status === 403) {
      return {
        source: "locked",
        summary: error.message || "Gemini AI Report is available on Pro and Elite.",
        riskFocus: ["Upgrade to Pro or Elite to unlock Gemini analysis from your saved performance data."],
        questionBank: ["Which plan should I choose for AI performance review?"]
      };
    }
    // Fallback to local heuristic below.
  }

  const analytics = calculateAnalytics(trades);
  const bestSession = bestOf(trades, "session");
  const bestStrategy = bestOf(trades, "strategy");
  const biggestLoss = analytics.biggestLoss || 0;
  const winRate = analytics.winRate || 0;

  return {
    summary: trades.length
      ? `Your current edge is ${analytics.totalPnl >= 0 ? "positive" : "under pressure"}. With ${trades.length} saved trades, win rate is ${winRate}% and the strongest session is ${bestSession}. Best strategy: ${bestStrategy}.`
      : "Add a few manual XAUUSD trades to unlock your AI report, risk focus, and suggested questions.",
    riskFocus: trades.length
      ? [
          biggestLoss ? `Your worst trade loss is ${formatCurrency(biggestLoss)} — keep stop distance and lot sizing strict on losing sessions.` : "No major loss yet — stay disciplined and protect the edge you already have.",
          analytics.profitFactor === Infinity ? "Profit factor is strong, so your setup quality is currently outperforming risk taken." : `Profit factor is ${analytics.profitFactor === 0 ? "0.00" : analytics.profitFactor.toFixed(2)} — review risk/reward consistency if you want better expansion.`,
          analytics.expectancy >= 0 ? "Your expectancy is positive, which means your setup is trending in the right direction." : "Expectancy is still negative — tighten entries and cut poor setups before the next session."
        ]
      : ["No trade history yet — save a few trades to start the AI review."],
    questionBank: trades.length
      ? [
          `Which session produced the best results: ${bestSession || "unknown"}?`,
          `Is ${bestStrategy || "your current strategy"} still the highest-quality setup for your next trade?`,
          `How can you reduce risk after ${formatCurrency(Math.abs(biggestLoss))} of drawdown from your worst trade?`
        ]
      : ["What setup should you test first after saving your first XAUUSD trade?", "Which session should you focus on for better consistency?", "How can you improve your first trade plan with a simple risk rule?"]
  };
}

function generateAiAgentResponse(question, trades) {
  trades = getPerformanceTrades(trades);
  const analytics = calculateAnalytics(trades);
  const bestSession = bestOf(trades, "session");
  const bestStrategy = bestOf(trades, "strategy");
  const biggestLoss = analytics.biggestLoss || 0;
  const totalPnl = analytics.totalPnl || 0;
  const winRate = analytics.winRate || 0;
  const text = String(question || "").toLowerCase();

  if (!trades.length) {
    return "To provide a professional review, save a few XAUUSD trades first. Once your history is in place, I can assess win rate, risk exposure, and session quality with real numbers.";
  }

  if (/win rate|performance|how am i doing|am i profitable/i.test(text)) {
    return `Based on your current trade book, the win rate stands at ${winRate}%, with ${formatCurrency(totalPnl)} total P&L. This indicates ${totalPnl >= 0 ? "a positive edge at the moment" : "a need for tighter risk control in the next session"}.`;
  }

  if (/best session|which session/i.test(text)) {
    return `The strongest session in your current record is ${bestSession || "still developing"}. For a more disciplined edge, review the setups that produced your best outcomes during that period.`;
  }

  if (/strategy|setup|best setup/i.test(text)) {
    return `Your most reliable setup so far appears to be ${bestStrategy || "still forming"}. Use this as your professional bias, while tracking what made it work and where it broke down.`;
  }

  if (/risk|drawdown|loss|stop/i.test(text)) {
    return `Your largest recorded loss is ${formatCurrency(Math.abs(biggestLoss))}. The professional approach is to keep stop distance, lot sizing, and execution discipline consistent so the edge remains protected.`;
  }

  if (/next step|suggest|plan|what should i do/i.test(text)) {
    return `A disciplined next step is to prioritize ${bestSession || "your strongest session"}, repeat your ${bestStrategy || "best setup"}, and tighten risk after the ${formatCurrency(Math.abs(biggestLoss))} drawdown already visible in your book.`;
  }

  return `I reviewed your trade history: ${trades.length} trades, ${winRate}% win rate, and ${formatCurrency(totalPnl)} total P&L. Ask me about session strength, strategy quality, risk discipline, or your next-session plan and I will answer in a more structured, professional format.`;
}

async function renderAiReport() {
  const trades = getPerformanceTrades();
  const report = await generateAiReport(trades);

  const summaryNode = document.querySelector("[data-ai-report-summary]");
  const riskList = document.querySelector("[data-ai-risk-list]");
  const questionList = document.querySelector("[data-ai-questions]");
  const sourceNode = document.querySelector("[data-ai-source]");

  if (summaryNode) summaryNode.textContent = report.summary;
  if (riskList) riskList.innerHTML = (report.riskFocus || []).map((item) => `<li>${item}</li>`).join("");
  if (questionList) questionList.innerHTML = (report.questionBank || []).map((item) => `<li>${item}</li>`).join("");
  if (sourceNode) {
    const sourceLabel = report.source === "gemini"
      ? "Gemini AI is analyzing your saved SwanXm performance data."
      : report.source === "locked"
        ? "Gemini AI Report is locked on Free. Switch to Pro or Elite to unlock it."
        : "Gemini is unavailable right now, so SwanXm is showing local performance analysis.";
    sourceNode.textContent = sourceLabel;
  }
}

async function initAiAgent() {
  const form = document.querySelector("[data-ai-agent-form]");
  const input = document.querySelector("[data-ai-agent-input]");
  const list = document.querySelector("[data-ai-chat-messages]");

  if (!form || !input || !list) return;

  const addBubble = (text, role) => {
    const bubble = document.createElement("div");
    bubble.className = `ai-agent-bubble ${role === "user" ? "ai-agent-user" : "ai-agent-bot"}`;
    bubble.textContent = text;
    list.appendChild(bubble);
    list.scrollTop = list.scrollHeight;
  };

  const showTyping = () => {
    const typing = document.createElement("div");
    typing.className = "ai-agent-bubble ai-agent-bot ai-agent-typing";
    typing.textContent = "AI is preparing a professional response…";
    list.appendChild(typing);
    list.scrollTop = list.scrollHeight;
    return typing;
  };

  if (!list.dataset.initialized) {
    addBubble("Ask me anything about your trades, win rate, risk, or next-session plan.", "bot");
    list.dataset.initialized = "true";
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const question = input.value.trim();
    if (!question) return;

    if (!supportsAiReport()) {
      addBubble("Gemini AI chat is locked on Free. Switch to Pro or Elite from Subscription to ask questions from your saved performance data.", "bot");
      activateAppPanel("subscription");
      return;
    }

    addBubble(question, "user");
    input.value = "";

    const typingBubble = showTyping();
    const delay = 900 + Math.floor(Math.random() * 700);

    try {
      const response = await apiRequest("/ai/chat", {
        method: "POST",
        body: JSON.stringify({ question })
      });

      setTimeout(() => {
        typingBubble.remove();
        addBubble(response.answer || "I am ready to help once the Gemini integration is configured.", "bot");
      }, delay);
    } catch (error) {
      setTimeout(() => {
        typingBubble.remove();
        addBubble(error.status === 403 ? "Gemini AI chat is available on Pro and Elite." : "I could not reach Gemini right now. The report panel will fall back to local analysis until the API is available.", "bot");
      }, delay);
    }
  });
}

function countOpenPositions() {
  return getLiveMt5Summary().count;
}

function renderTradeData() {
  const trades = getPerformanceTrades();
  const analytics = calculateAnalytics(trades);
  const openPositions = countOpenPositions(trades);
  const hasTrades = trades.length > 0;
  document.querySelectorAll("[data-analytics-content]").forEach((node) => node.hidden = !hasTrades);
  document.querySelectorAll("[data-analytics-empty]").forEach((node) => node.hidden = hasTrades);
  document.querySelectorAll("[data-total-pnl]").forEach((node) => {
    node.textContent = formatCurrency(analytics.totalPnl);
    node.classList.toggle("profit", analytics.totalPnl >= 0);
    node.classList.toggle("loss", analytics.totalPnl < 0);
  });
  document.querySelectorAll("[data-win-rate]").forEach((node) => node.textContent = `${analytics.winRate}%`);
  document.querySelectorAll("[data-trade-count]").forEach((node) => node.textContent = node.tagName === "EM" ? `${trades.length} trades` : trades.length);
  document.querySelectorAll("[data-open-positions]").forEach((node) => {
    node.textContent = openPositions ? `${openPositions} open position${openPositions === 1 ? "" : "s"}` : "No open positions";
  });
  renderDashboardPnlCards(trades);
  document.querySelectorAll("[data-profit-factor]").forEach((node) => node.textContent = trades.length ? (analytics.profitFactor === Infinity ? "INF" : analytics.profitFactor.toFixed(2)) : "0.00");
  document.querySelectorAll("[data-expectancy]").forEach((node) => node.textContent = formatCurrency(analytics.expectancy));
  document.querySelectorAll("[data-avg-win]").forEach((node) => node.textContent = formatCurrency(analytics.avgWin));
  document.querySelectorAll("[data-avg-loss]").forEach((node) => node.textContent = analytics.avgLoss ? `-${formatCurrency(analytics.avgLoss)}` : formatCurrency(0));
  document.querySelectorAll("[data-biggest-win]").forEach((node) => node.textContent = formatCurrency(analytics.biggestWin));
  document.querySelectorAll("[data-biggest-loss]").forEach((node) => node.textContent = analytics.biggestLoss ? `-${formatCurrency(Math.abs(analytics.biggestLoss))}` : formatCurrency(0));
  document.querySelectorAll("[data-best-session]").forEach((node) => node.textContent = bestOf(trades, "session"));
  document.querySelectorAll("[data-best-strategy]").forEach((node) => node.textContent = bestOf(trades, "strategy"));
  document.querySelectorAll("[data-best-symbol]").forEach((node) => node.textContent = bestOf(trades, "symbol"));
  document.querySelectorAll("[data-best-day]").forEach((node) => node.textContent = bestOf(trades, "day"));
  document.querySelectorAll("[data-best-profit-day]").forEach((node) => {
    node.textContent = dayPnlSummary(trades, "best");
    node.classList.toggle("profit", trades.length > 0);
    node.classList.remove("loss");
  });
  document.querySelectorAll("[data-worst-profit-day]").forEach((node) => {
    node.textContent = dayPnlSummary(trades, "worst");
    node.classList.toggle("loss", trades.length > 0);
    node.classList.remove("profit");
  });
  document.querySelectorAll("[data-win-rate-bar]").forEach((node) => node.style.width = `${analytics.winRate}%`);
  document.querySelectorAll("[data-ai-summary]").forEach((node) => {
    node.textContent = trades.length
      ? `Best session: ${bestOf(trades, "session")}. Best strategy: ${bestOf(trades, "strategy")}. Total P&L: ${formatCurrency(analytics.totalPnl)}.`
      : "No trades yet. Add your first trade to generate analysis.";
  });

  renderTable(trades);
  renderEquity(trades);
  renderCalendar(trades);
  renderRanking("[data-day-ranking]", groupTotals(trades, "day"));
  renderRanking("[data-symbol-ranking]", groupTotals(trades, "symbol"));
  void renderAiReport();
  renderTradeList(trades);
  renderDashboardTrades(trades);
  renderDashboardOpenPositions();
  renderMt5TradePreview();
  renderPlanState();
  void initAiAgent();
}

function renderTable(trades = getPerformanceTrades()) {
  if (!tradeRows) return;
  const empty = document.querySelector("[data-empty-trades]");
  const table = document.querySelector("[data-trade-table]");
  const notice = document.querySelector("[data-trades-notice]");
  const hasTrades = trades.length > 0;
  if (empty) empty.hidden = hasTrades;
  if (table) table.hidden = !hasTrades;
  if (notice) notice.hidden = !hasTrades;
  tradeRows.innerHTML = trades.map((trade) => {
    const pnl = Number(trade.pnl || 0);
    const sessionLabel = trade.source === "mt5" ? `${trade.session} (GMT+0)` : trade.session;
    return `<tr><td>${formatGmtLabel(trade.closedAt, trade.date)}</td><td>${trade.symbol}</td><td>${sessionLabel}</td><td>${trade.strategy}</td><td class="${pnl >= 0 ? "profit" : "loss"}">${formatCurrency(pnl)}</td><td>${trade.source || "manual"}</td></tr>`;
  }).join("");
}

function renderEquity(trades = getPerformanceTrades()) {
  const nodes = document.querySelectorAll("[data-equity-bars]");
  const orderedTrades = [...trades].sort((a, b) => {
    const byDate = new Date(`${a.date}T12:00:00`) - new Date(`${b.date}T12:00:00`);
    if (byDate !== 0) return byDate;
    return String(a.id || "").localeCompare(String(b.id || ""));
  });

  if (!orderedTrades.length) {
    nodes.forEach((node) => {
      node.classList.remove("equity-live");
      node.innerHTML = `<div class="chart-empty">+$0.00</div>`;
    });
    return;
  }

  let running = 0;
  const points = [
    { equity: 0, label: "Start", pnl: 0 },
    ...orderedTrades.map((trade) => {
      const pnl = Number(trade.pnl || 0);
      running += pnl;
      return {
        equity: running,
        label: `${trade.date} ${trade.symbol}`,
        pnl
      };
    })
  ];
  const width = 760;
  const height = 260;
  const padX = 42;
  const padY = 30;
  const equities = points.map((point) => point.equity);
  const min = Math.min(0, ...equities);
  const max = Math.max(0, ...equities);
  const spread = Math.max(1, max - min);
  const xStep = points.length > 1 ? (width - padX * 2) / (points.length - 1) : 0;
  const mapY = (value) => height - padY - ((value - min) / spread) * (height - padY * 2);
  const mapped = points.map((point, index) => ({
    ...point,
    x: padX + index * xStep,
    y: mapY(point.equity)
  }));
  const linePath = mapped.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
  const areaPath = `${linePath} L ${mapped[mapped.length - 1].x.toFixed(2)} ${height - padY} L ${padX} ${height - padY} Z`;
  const zeroY = mapY(0);
  const last = mapped[mapped.length - 1];
  const yTicks = [max, (max + min) / 2, min];
  const xLabels = mapped.filter((_, index) => index === 0 || index === mapped.length - 1 || (mapped.length > 3 && index === Math.floor(mapped.length / 2)));
  const total = running;
  const statusClass = total >= 0 ? "profit" : "loss";
  const statusLabel = total >= 0 ? "Equity rising" : "Drawdown active";

  const buildChartHtml = (chartIndex) => {
    const lineGradientId = `equityLineGradient${chartIndex}`;
    const areaGradientId = `equityAreaGradient${chartIndex}`;
    return `
    <div class="equity-chart-head">
      <div><span>Live Equity Curve</span><strong class="${statusClass}">${formatCurrency(total)}</strong></div>
      <em>${statusLabel}</em>
    </div>
    <svg class="equity-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Real time equity curve">
      <defs>
        <linearGradient id="${lineGradientId}" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#8be9ff" />
          <stop offset="55%" stop-color="#12d8ff" />
          <stop offset="100%" stop-color="#35ffa8" />
        </linearGradient>
        <linearGradient id="${areaGradientId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#12d8ff" stop-opacity="0.28" />
          <stop offset="100%" stop-color="#12d8ff" stop-opacity="0" />
        </linearGradient>
      </defs>
      ${yTicks.map((tick) => `<g class="equity-grid"><line x1="${padX}" y1="${mapY(tick).toFixed(2)}" x2="${width - padX}" y2="${mapY(tick).toFixed(2)}"></line><text x="${width - padX + 8}" y="${mapY(tick).toFixed(2)}">${escapeHtml(formatCurrency(tick))}</text></g>`).join("")}
      <line class="equity-zero" x1="${padX}" y1="${zeroY.toFixed(2)}" x2="${width - padX}" y2="${zeroY.toFixed(2)}"></line>
      <path class="equity-area" d="${areaPath}" fill="url(#${areaGradientId})"></path>
      <path class="equity-line" d="${linePath}" stroke="url(#${lineGradientId})"></path>
      ${mapped.map((point, index) => `<g class="equity-point ${point.pnl >= 0 ? "win" : "loss"}"><circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="${index === mapped.length - 1 ? 5.5 : 4}"></circle><title>${escapeHtml(point.label)} - ${escapeHtml(formatCurrency(point.equity))}</title></g>`).join("")}
      <circle class="equity-pulse" cx="${last.x.toFixed(2)}" cy="${last.y.toFixed(2)}" r="9"></circle>
      ${xLabels.map((point) => `<text class="equity-x-label" x="${point.x.toFixed(2)}" y="${height - 8}">${escapeHtml(point.label.split(" ")[0])}</text>`).join("")}
    </svg>
  `;
  };

  nodes.forEach((node, index) => {
    node.classList.add("equity-live");
    node.innerHTML = buildChartHtml(index);
  });
}

function renderCalendar(trades = getPerformanceTrades()) {
  const node = document.querySelector("[data-calendar-grid]");
  if (!node) return;
  node.classList.remove("calendar-refresh");
  void node.offsetWidth;

  if (!/^\d{4}-\d{2}$/.test(selectedCalendarMonth)) {
    selectedCalendarMonth = getCurrentMonthValue();
  }

  if (calendarMonthInput && calendarMonthInput.value !== selectedCalendarMonth) {
    calendarMonthInput.value = selectedCalendarMonth;
  }

  const [year, month] = selectedCalendarMonth.split("-").map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstWeekday = new Date(year, month - 1, 1).getDay();
  const selectedDate = new Date(year, month - 1, 1);
  const selectedLabel = selectedDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const currentMonthValue = getCurrentMonthValue();
  const today = new Date();
  const todayDay = today.getDate();
  const nowUtcMs = Date.now();
  const monthTrades = trades.filter((trade) => String(trade.date || "").slice(0, 7) === selectedCalendarMonth);
  const monthTotal = monthTrades.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
  const dailyTotals = monthTrades.reduce((totals, trade) => {
    const day = Number(String(trade.date || "").split("-")[2]);
    if (!day) return totals;
    totals[day] = (totals[day] || 0) + Number(trade.pnl || 0);
    return totals;
  }, {});

  document.querySelectorAll("[data-calendar-month-label]").forEach((label) => {
    label.textContent = selectedLabel;
  });
  document.querySelectorAll("[data-calendar-month-total]").forEach((label) => {
    label.textContent = formatCurrency(monthTotal);
    label.classList.toggle("profit", monthTotal >= 0);
    label.classList.toggle("loss", monthTotal < 0);
  });
  document.querySelectorAll("[data-calendar-month-count]").forEach((label) => {
    label.textContent = monthTrades.length;
  });

  const weekDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Weekly"]
    .map((day) => `<div class="calendar-weekday">${day}</div>`);
  const calendarCells = [];
  let weekNumber = 1;
  let day = 1;

  while (day <= daysInMonth) {
    const rowStartDay = day;
    const rowCells = [];
    const rowOffset = weekNumber === 1 ? firstWeekday : 0;

    for (let weekday = 0; weekday < 7; weekday += 1) {
      if (weekday < rowOffset || day > daysInMonth) {
        rowCells.push(`<div class="calendar-blank"></div>`);
        continue;
      }

      const pnl = dailyTotals[day] || 0;
      const stateClass = pnl > 0 ? "profit-cell" : pnl < 0 ? "loss-cell" : "flat-cell";
      const todayClass = selectedCalendarMonth === currentMonthValue && day === todayDay ? " today-cell" : "";
      rowCells.push(`<div class="${stateClass}${todayClass}"><b>${day}</b><span>${pnl ? formatCurrency(pnl) : ""}</span></div>`);
      day += 1;
    }

    const rowEndDay = Math.min(day - 1, daysInMonth);
    const weekTotal = Array.from({ length: rowEndDay - rowStartDay + 1 }, (_, index) => rowStartDay + index)
      .reduce((sum, dayNumber) => sum + Number(dailyTotals[dayNumber] || 0), 0);
    const rowStartDate = new Date(Date.UTC(year, month - 1, rowStartDay));
    rowStartDate.setUTCDate(rowStartDate.getUTCDate() - rowStartDate.getUTCDay());
    const fridayUtc = new Date(rowStartDate);
    fridayUtc.setUTCDate(rowStartDate.getUTCDate() + 5);
    const fridayClosedAtMs = Date.UTC(fridayUtc.getUTCFullYear(), fridayUtc.getUTCMonth(), fridayUtc.getUTCDate() + 1, 0, 0, 0);
    const isWeekClosed = nowUtcMs >= fridayClosedAtMs;
    const weekState = !isWeekClosed ? "weekly-pending" : weekTotal > 0 ? "weekly-profit" : weekTotal < 0 ? "weekly-loss" : "weekly-flat";
    const weekValue = isWeekClosed ? formatCurrency(weekTotal) : "In progress";
    rowCells.push(`
      <div class="weekly-pnl-cell ${weekState}" title="${isWeekClosed ? "Closed after Friday GMT+0" : "Closes after Friday GMT+0"}">
        <b>Week ${weekNumber} P&L</b>
        <strong>${weekValue}</strong>
      </div>
    `);
    calendarCells.push(...rowCells);
    weekNumber += 1;
  }

  node.innerHTML = [...weekDays, ...calendarCells].join("");
  requestAnimationFrame(() => node.classList.add("calendar-refresh"));
}

if (calendarMonthInput) {
  calendarMonthInput.value = selectedCalendarMonth;
  calendarMonthInput.addEventListener("change", () => {
    selectedCalendarMonth = calendarMonthInput.value || getCurrentMonthValue();
    renderCalendar(getPerformanceTrades());
  });
}

function shiftCalendarMonth(offset) {
  if (!/^\d{4}-\d{2}$/.test(selectedCalendarMonth)) {
    selectedCalendarMonth = getCurrentMonthValue();
  }
  const [year, month] = selectedCalendarMonth.split("-").map(Number);
  const nextDate = new Date(year, month - 1 + offset, 1);
  const nextMonth = String(nextDate.getMonth() + 1).padStart(2, "0");
  selectedCalendarMonth = `${nextDate.getFullYear()}-${nextMonth}`;
  if (calendarMonthInput) calendarMonthInput.value = selectedCalendarMonth;
  renderCalendar(getPerformanceTrades());
}

calendarPrevButton?.addEventListener("click", () => shiftCalendarMonth(-1));
calendarNextButton?.addEventListener("click", () => shiftCalendarMonth(1));

document.querySelectorAll("[data-setting-field]").forEach((field) => {
  field.addEventListener("input", () => {
    const key = field.dataset.settingField;
    if (!key) return;
    appSettings[key] = field.value;
    saveAppSettings();
    if (key === "displayName") renderSettingsState();
    if (["preferredSymbol", "defaultSession", "defaultStrategy"].includes(key)) applyJournalDefaults();
  });
  field.addEventListener("change", () => {
    const key = field.dataset.settingField;
    if (!key) return;
    appSettings[key] = field.value;
    saveAppSettings();
    renderSettingsState();
  });
});

document.querySelectorAll("[data-setting-toggle]").forEach((field) => {
  field.addEventListener("change", () => {
    const key = field.dataset.settingToggle;
    if (!key) return;
    appSettings[key] = field.checked;
    saveAppSettings();
    renderSettingsState();
  });
});

document.querySelectorAll("[data-theme-option]").forEach((button) => {
  button.addEventListener("click", () => {
    appSettings.themePreference = button.dataset.themeOption === "light" ? "light" : "dark";
    saveAppSettings();
    applyTheme(appSettings.themePreference);
    renderSettingsState();
  });
});

function renderRanking(selector, rows) {
  const node = document.querySelector(selector);
  if (!node) return;
  node.innerHTML = rows.length
    ? rows.slice(0, 5).map(([label, value]) => `<div class="ranking-item"><b>${label}</b><em class="${value >= 0 ? "profit" : "loss"}">${formatCurrency(value)}</em></div>`).join("")
    : `<div class="ranking-item"><b>No data</b><em>-</em></div>`;
}

function renderTradeList(trades = getPerformanceTrades()) {
  const node = document.querySelector("[data-trade-list]");
  if (!node) return;
  node.innerHTML = trades.length
    ? trades.map((trade, index) => `<button type="button" data-trade-index="${index}"><b>${trade.symbol}</b><span>${trade.session} • ${trade.strategy}</span><em class="${Number(trade.pnl) >= 0 ? "profit" : "loss"}">${formatCurrency(trade.pnl)}</em></button>`).join("")
    : `<div class="empty-state">No trades yet.</div>`;
  node.querySelectorAll("[data-trade-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const trade = trades[Number(button.dataset.tradeIndex)];
      node.querySelectorAll("[data-trade-index]").forEach((item) => {
        item.classList.toggle("is-selected", item === button);
      });
      document.querySelector("[data-selected-trade-title]").textContent = `${trade.symbol} ${Number(trade.pnl) >= 0 ? "Winner" : "Loser"}`;
      document.querySelector("[data-selected-trade]").innerHTML = `<div class="quick-grid"><div><span>Close Time</span><strong>${formatGmtLabel(trade.closedAt, trade.date)}</strong></div><div><span>Session</span><strong>${trade.source === "mt5" ? `${trade.session} (GMT+0)` : trade.session}</strong></div><div><span>Strategy</span><strong>${trade.strategy}</strong></div><div><span>Direction</span><strong>${trade.direction || "-"}</strong></div><div><span>Entry / Exit</span><strong>${trade.entry || "-"} / ${trade.exit || "-"}</strong></div><div><span>Lot Size</span><strong>${trade.lotSize || "-"}</strong></div><div><span>P&L</span><strong class="${Number(trade.pnl) >= 0 ? "profit" : "loss"}">${formatCurrency(trade.pnl)}</strong></div></div><p>${trade.note || "No note added."}</p>`;
    });
  });
}

function renderDashboardTrades(trades = getPerformanceTrades()) {
  const tradesList = document.querySelector("[data-dashboard-trades-list]");
  const tradesNotice = document.querySelector("[data-dashboard-trades-notice]");
  const tradeCount = document.querySelector("[data-dashboard-trade-count]");
  
  if (!tradesList) return;
  
  const hasTrades = trades.length > 0;
  const recentTrades = trades.slice(0, 5);  // Show only 5 most recent trades
  
  if (tradeCount) tradeCount.textContent = trades.length;
  if (tradesNotice) tradesNotice.hidden = hasTrades;
  
  tradesList.innerHTML = hasTrades
    ? recentTrades.map((trade) => {
        const pnl = Number(trade.pnl || 0);
        const pnlClass = pnl > 0 ? "profit" : pnl < 0 ? "loss" : "breakeven";
        const closeDate = formatGmtLabel(trade.closedAt, trade.date);
        const sourceLabel = trade.source === "mt5" ? "(MT5)" : "(Manual)";
        return `<div class="dashboard-trade-item">
          <div class="dashboard-trade-left">
            <span class="dashboard-trade-symbol">${trade.symbol}</span>
            <div class="dashboard-trade-details">
              <span>${trade.session}</span>
              <span>•</span>
              <span>${trade.strategy}</span>
              <span>•</span>
              <span>${sourceLabel}</span>
            </div>
          </div>
          <div class="dashboard-trade-right">
            <span class="dashboard-trade-pnl ${pnlClass}">${formatCurrency(pnl)}</span>
            <div class="dashboard-trade-meta">
              <span>${closeDate}</span>
            </div>
          </div>
        </div>`;
      }).join("")
    : `<div class="dashboard-trades-empty">No trades yet. Start by adding a manual trade or connecting MT5.</div>`;
}

function renderDashboardOpenPositions() {
  const positionsList = document.querySelector("[data-dashboard-open-positions-list]");
  const positionsCard = document.querySelector("[data-dashboard-open-positions-card]");
  const positionsNotice = document.querySelector("[data-dashboard-open-notice]");
  const liveTradesCount = document.querySelector("[data-dashboard-live-trades-count]");
  
  if (!positionsList) return;
  
  const hasPositions = liveMt5Positions.length > 0;
  
  if (liveTradesCount) liveTradesCount.textContent = liveMt5Positions.length;
  if (positionsCard) positionsCard.hidden = !hasPositions;
  if (positionsNotice) positionsNotice.hidden = hasPositions;
  
  positionsList.innerHTML = hasPositions
    ? liveMt5Positions.map((position) => {
        const pnl = Number(position.pnl || 0);
        const entry = Number(position.entry || 0);
        const currentPrice = Number(position.exit || 0);
        const pnlClass = pnl > 0 ? "profit" : pnl < 0 ? "loss" : "breakeven";
        const returnPercent = entry > 0 ? ((pnl / (entry * 100)) * 100).toFixed(2) : 0;
        const pipsMoved = Math.abs(currentPrice - entry).toFixed(2);
        const direction = (position.direction || "LONG").toUpperCase();
        
        return `<div class="dashboard-open-position-item ${pnlClass}">
          <div class="dashboard-open-position-left">
            <span class="dashboard-open-position-symbol">${position.symbol}</span>
            <div class="dashboard-open-position-details">
              <div class="dashboard-open-position-detail-row">
                <span class="dashboard-open-position-detail-item">
                  <span class="dashboard-open-position-detail-label">Direction:</span>
                  <span class="dashboard-open-position-detail-value">${direction}</span>
                </span>
                <span class="dashboard-open-position-detail-item">
                  <span class="dashboard-open-position-detail-label">Entry:</span>
                  <span class="dashboard-open-position-detail-value">${entry.toFixed(2)}</span>
                </span>
                <span class="dashboard-open-position-detail-item">
                  <span class="dashboard-open-position-detail-label">Current:</span>
                  <span class="dashboard-open-position-detail-value">${currentPrice.toFixed(2)}</span>
                </span>
              </div>
              <div class="dashboard-open-position-detail-row">
                <span class="dashboard-open-position-detail-item">
                  <span class="dashboard-open-position-detail-label">Pips:</span>
                  <span class="dashboard-open-position-detail-value">${pipsMoved}</span>
                </span>
                <span class="dashboard-open-position-detail-item">
                  <span class="dashboard-open-position-detail-label">Volume:</span>
                  <span class="dashboard-open-position-detail-value">${(position.volume || position.lotSize || 0).toFixed(2)}</span>
                </span>
              </div>
            </div>
          </div>
          <div class="dashboard-open-position-right">
            <span class="dashboard-open-position-pnl ${pnlClass}">${formatCurrency(pnl)}</span>
            <div class="dashboard-open-position-return ${pnl >= 0 ? '' : 'loss'}">${returnPercent > 0 ? '+' : ''}${returnPercent}%</div>
          </div>
        </div>`;
      }).join("")
    : `<div class="dashboard-open-positions-empty">No open positions. Connect MT5 to sync live trades.</div>`;
}

if (tradeForm) {
  const dateInput = tradeForm.querySelector("input[name='date']");
  const pnlPreview = tradeForm.querySelector("[data-calculated-pnl]");
  const updatePnlPreview = () => {
    if (!pnlPreview) return;
    const form = new FormData(tradeForm);
    const pnl = calculateTradePnl({
      direction: form.get("direction"),
      entry: form.get("entry"),
      exit: form.get("exit"),
      lotSize: form.get("lotSize")
    });
    pnlPreview.textContent = formatCurrency(pnl);
    pnlPreview.classList.toggle("profit", pnl >= 0);
    pnlPreview.classList.toggle("loss", pnl < 0);
  };

  if (dateInput) dateInput.valueAsDate = new Date();
  tradeForm.querySelectorAll("input[name='entry'], input[name='exit'], input[name='lotSize'], select[name='direction']").forEach((field) => {
    field.addEventListener("input", updatePnlPreview);
    field.addEventListener("change", updatePnlPreview);
  });
  updatePnlPreview();

  tradeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!requireLogin()) return;
    const formNode = event.currentTarget;
    const form = new FormData(event.currentTarget);
    const submitButton = formNode.querySelector("button[type='submit']");
    const originalButtonText = submitButton?.textContent;
    const willRollFreeTrade = isFreePlan() && getManualPerformanceTrades().length >= FREE_TRADE_LIMIT;

    if (willRollFreeTrade) {
      const confirmed = await showFreeTradeLimitModal();
      if (!confirmed) return;
    }

    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Saving...";
    }

    try {
      const result = await apiRequest("/trades", {
        method: "POST",
        body: JSON.stringify({
          date: form.get("date"),
          symbol: form.get("symbol"),
          direction: form.get("direction"),
          session: form.get("session"),
          strategy: form.get("strategy"),
          entry: Number(form.get("entry") || 0),
          exit: Number(form.get("exit") || 0),
          lotSize: Number(form.get("lotSize") || 0),
          note: form.get("note") || ""
        })
      });

      await loadTrades();

      formNode.reset();
      if (dateInput) dateInput.valueAsDate = new Date();
      applyJournalDefaults();
      updatePnlPreview();
      activateAppPanel("trades");
      showAppStatus(
        result.freeLimitApplied
          ? `Trade saved. Free plan keeps only ${FREE_TRADE_LIMIT} trades, so your oldest trade was removed.`
          : "Trade saved. It is now visible in Trades.",
        "success"
      );
    } catch (error) {
      showAppStatus(error.message || "Trade could not be saved.", "error");
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = originalButtonText || "Save Trade";
      }
    }
  });
}

[mt5Login, mt5Password, mt5Server].forEach((field) => {
  field?.addEventListener("input", prepareMt5AccountView);
  field?.addEventListener("change", prepareMt5AccountView);
  field?.addEventListener("blur", prepareMt5AccountView);
});

syncDemo?.addEventListener("click", () => {
  lastMt5SyncKey = "";
  syncMt5Trades({ force: true }).catch(() => {});
});

document.querySelector("[data-export-csv]")?.addEventListener("click", () => {
  if (!requireLogin()) return;
  if (!currentTrades || !currentTrades.length) {
    showAppStatus("No trades to export.", "error");
    return;
  }
  const headers = ["Date", "Closed At", "Symbol", "Direction", "Session", "Strategy", "Entry", "Exit", "Lot Size", "P&L", "Source", "Note"];
  const esc = (v) => `"${String(v).replace(/"/g, "'")}"`;
  const rows = currentTrades.map((t) => [
    t.date || "",
    t.closedAt || "",
    t.symbol || "",
    t.direction || "",
    t.session || "",
    t.strategy || "",
    t.entry !== undefined ? t.entry : "",
    t.exit !== undefined ? t.exit : "",
    t.lotSize !== undefined ? t.lotSize : "",
    t.pnl !== undefined ? t.pnl : "",
    t.source || "manual",
    t.note || ""
  ].map(esc).join(","));
  const csv = [headers.map(esc).join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const today = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `swanxm-trades-${today}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showAppStatus(`Exported ${currentTrades.length} trade${currentTrades.length === 1 ? "" : "s"} to CSV.`, "success");
});

document.querySelector("[data-clear-trades]")?.addEventListener("click", () => {
  if (!requireLogin()) return;
  apiRequest("/trades", { method: "DELETE" })
    .then(() => {
      clearMt5Credentials();
      return loadTrades();
    })
    .catch((error) => {
      if (portalMessage) portalMessage.textContent = error.message;
    });
});

function updateLotAssistant() {
  const balanceInput = document.querySelector("[data-lot-balance]");
  const riskInput = document.querySelector("[data-lot-risk-percent]");
  const riskRange = document.querySelector("[data-lot-risk-range]");
  const stopInput = document.querySelector("[data-lot-stop-pips]");
  const customToggle = document.querySelector("[data-custom-pip-toggle]");
  const customField = document.querySelector("[data-custom-pip-field]");
  const pipInput = document.querySelector("[data-lot-pip-value]");
  const balance = Number(balanceInput?.value || 0);
  const riskPercent = Number(riskRange?.value || riskInput?.value || 0);
  const stopPips = Number(stopInput?.value || 0);
  const pipValue = customToggle?.checked ? Number(pipInput?.value || 0) : 10;
  const resultNode = document.querySelector("[data-lot-result]");
  const riskDisplay = document.querySelector("[data-risk-percent-display]");
  const pipLabel = document.querySelector("[data-pip-value-label]");
  const noteNode = document.querySelector("[data-lot-ai-note]");
  const emptyState = document.querySelector("[data-lot-empty]");
  const readyState = document.querySelector("[data-lot-ready]");
  const resultCard = document.querySelector("[data-lot-result-card]");
  if (!resultNode || !noteNode) return;

  const riskAmount = balance * (riskPercent / 100);
  const rawLot = riskAmount && stopPips && pipValue ? riskAmount / (stopPips * pipValue) : 0;
  const suggestedLot = rawLot ? Math.round(rawLot * 100) / 100 : 0;
  const miniLots = rawLot * 10;
  const microLots = rawLot * 100;
  const hasParameters = Boolean(balance > 0 && riskPercent > 0 && stopPips > 0 && pipValue > 0);
  const riskPercentLabel = Number.isInteger(riskPercent) ? riskPercent.toFixed(0) : riskPercent.toFixed(1);
  const stopPipsLabel = stopPips
    ? `${Number.isInteger(stopPips) ? stopPips.toFixed(0) : stopPips.toFixed(1)} pips`
    : "0 pips";
  const trimNumber = (value, decimals = 2) => {
    if (!Number.isFinite(value) || value <= 0) return "0";
    return value.toFixed(decimals).replace(/\.?0+$/, "");
  };

  resultNode.textContent = suggestedLot ? suggestedLot.toFixed(2) : "0.00";
  document.querySelectorAll("[data-risk-amount]").forEach((node) => node.textContent = formatCurrency(riskAmount));
  document.querySelectorAll("[data-stop-pips-result]").forEach((node) => node.textContent = stopPipsLabel);
  document.querySelectorAll("[data-pip-value-result]").forEach((node) => node.textContent = `${formatCurrency(pipValue)}/pip/lot`);
  document.querySelectorAll("[data-lot-mini]").forEach((node) => node.textContent = trimNumber(miniLots, 2));
  document.querySelectorAll("[data-lot-micro]").forEach((node) => node.textContent = trimNumber(microLots, 2));
  document.querySelectorAll("[data-lot-loss-stop]").forEach((node) => node.textContent = formatCurrency(riskAmount));
  document.querySelectorAll("[data-risk-percent-note]").forEach((node) => node.textContent = `${riskPercentLabel}% of balance`);
  document.querySelectorAll("[data-lot-risk-line]").forEach((node) => node.textContent = `Based on ${riskPercentLabel}% risk (${formatCurrency(riskAmount)})`);
  document.querySelectorAll("[data-lot-balance-summary]").forEach((node) => node.textContent = formatCurrency(balance));
  document.querySelectorAll("[data-lot-symbol-summary]").forEach((node) => node.textContent = document.querySelector("[data-lot-symbol]")?.value || "XAUUSD");
  if (riskDisplay) riskDisplay.textContent = riskPercentLabel;
  if (riskInput && Number(riskInput.value) !== riskPercent) riskInput.value = String(riskPercent);
  if (riskRange && Number(riskRange.value) !== riskPercent) riskRange.value = String(Math.min(Math.max(riskPercent, 0.1), 5));
  if (pipLabel) pipLabel.textContent = `${formatCurrency(pipValue)}/lot`;
  if (customField) customField.hidden = !customToggle?.checked;
  if (emptyState) emptyState.hidden = hasParameters;
  if (readyState) readyState.hidden = !hasParameters;
  if (resultCard) resultCard.classList.toggle("has-lot-result", hasParameters);
  document.querySelectorAll("[data-risk-preset]").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.riskPreset) === riskPercent);
  });
  noteNode.textContent = suggestedLot
    ? `= ${formatCurrency(riskAmount)} / (${Number.isInteger(stopPips) ? stopPips.toFixed(0) : stopPips.toFixed(1)} x ${formatCurrency(pipValue)}) = ${suggestedLot.toFixed(2)} lots`
    : "Account Balance x Risk % divided by Stop Loss Pips x Pip Value per Lot.";
}

function setRiskPercent(value) {
  const nextValue = String(value);
  const riskInput = document.querySelector("[data-lot-risk-percent]");
  const riskRange = document.querySelector("[data-lot-risk-range]");
  if (riskInput) riskInput.value = nextValue;
  if (riskRange) riskRange.value = nextValue;
  updateLotAssistant();
}

function resetLotAssistant() {
  const defaults = {
    "[data-lot-balance]": "400",
    "[data-lot-risk-percent]": "2",
    "[data-lot-risk-range]": "2",
    "[data-lot-stop-pips]": "50",
    "[data-lot-pip-value]": "10"
  };
  Object.entries(defaults).forEach(([selector, value]) => {
    const node = document.querySelector(selector);
    if (node) node.value = value;
  });
  const customToggle = document.querySelector("[data-custom-pip-toggle]");
  if (customToggle) customToggle.checked = false;
  updateLotAssistant();
}

function showToolsHome() {
  const home = document.querySelector("[data-tools-home]");
  if (home) home.hidden = false;
  document.querySelectorAll("[data-tool-panel]").forEach((panel) => {
    panel.hidden = true;
    panel.classList.remove("active");
  });
  document.querySelectorAll("[data-tool-open]").forEach((button) => button.classList.remove("active"));
  const titleNode = document.querySelector("[data-page-title]");
  if (titleNode && document.querySelector('[data-app-panel="tools"]')?.classList.contains("active")) titleNode.textContent = "Tools";
}

function openToolPanel(toolName) {
  const home = document.querySelector("[data-tools-home]");
  const selectedButton = document.querySelector(`[data-tool-open="${toolName}"]`);
  if (home) home.hidden = true;
  document.querySelectorAll("[data-tool-open]").forEach((button) => button.classList.toggle("active", button === selectedButton));
  document.querySelectorAll("[data-tool-panel]").forEach((panel) => {
    const active = panel.dataset.toolPanel === toolName;
    panel.hidden = !active;
    panel.classList.toggle("active", active);
  });
  const titleNode = document.querySelector("[data-page-title]");
  const title = selectedButton?.querySelector("h3")?.textContent?.trim();
  if (titleNode && title) titleNode.textContent = title;
  document.querySelector(".sxm-content")?.scrollTo({ top: 0, behavior: "smooth" });
  updateMarketSessions();
  updateLotAssistant();
}

document.querySelectorAll("[data-tool-open]").forEach((button) => {
  button.addEventListener("click", () => openToolPanel(button.dataset.toolOpen));
});

document.querySelectorAll("[data-tools-back]").forEach((button) => {
  button.addEventListener("click", () => {
    showToolsHome();
    document.querySelector(".sxm-content")?.scrollTo({ top: 0, behavior: "smooth" });
  });
});

document.querySelectorAll("[data-lot-balance], [data-lot-risk-percent], [data-lot-risk-range], [data-lot-stop-pips], [data-lot-pip-value], [data-custom-pip-toggle]").forEach((field) => {
  field.addEventListener("input", updateLotAssistant);
  field.addEventListener("change", updateLotAssistant);
});

document.querySelectorAll("[data-risk-preset]").forEach((button) => {
  button.addEventListener("click", () => setRiskPercent(button.dataset.riskPreset));
});

document.querySelector("[data-lot-calculate]")?.addEventListener("click", updateLotAssistant);
document.querySelector("[data-lot-reset]")?.addEventListener("click", resetLotAssistant);

const marketCalendarFilters = {
  range: "all",
  impact: "all",
  currency: "all",
  search: "",
  date: formatLocalDateValue(new Date())
};

function formatLocalDateValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function marketDateOffset(offset) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return formatLocalDateValue(date);
}

const economicCalendarEvents = [
  { offset: -3, time: "05:30", currency: "AUD", impact: "medium", title: "GDP q/q", actual: "0.2%", forecast: "0.3%", previous: "0.6%" },
  { offset: -3, time: "07:15", currency: "CNY", impact: "medium", title: "Caixin Services PMI", actual: "51.1", forecast: "51.4", previous: "50.7" },
  { offset: -2, time: "11:30", currency: "CHF", impact: "medium", title: "CPI m/m", actual: "0.1%", forecast: "0.2%", previous: "0.0%" },
  { offset: -2, time: "14:00", currency: "EUR", impact: "high", title: "ECB Main Refinancing Rate", actual: "4.25%", forecast: "4.25%", previous: "4.50%" },
  { offset: -2, time: "14:30", currency: "EUR", impact: "high", title: "ECB Press Conference", actual: "-", forecast: "-", previous: "-" },
  { offset: -1, time: "18:00", currency: "USD", impact: "high", title: "ADP Non-Farm Employment Change", actual: "152K", forecast: "173K", previous: "188K" },
  { offset: -1, time: "20:30", currency: "USD", impact: "medium", title: "ISM Services PMI", actual: "53.8", forecast: "51.0", previous: "49.4" },
  { offset: 0, time: "Tentative", currency: "USD", impact: "medium", title: "Treasury Currency Report", actual: "-", forecast: "-", previous: "-" },
  { offset: 0, time: "Tentative", currency: "ALL", impact: "high", title: "OPEC-JMMC Meetings", actual: "-", forecast: "-", previous: "-" },
  { offset: 1, time: "06:20", currency: "JPY", impact: "low", title: "Bank Lending y/y", actual: "-", forecast: "3.1%", previous: "3.0%" },
  { offset: 1, time: "12:30", currency: "GBP", impact: "high", title: "GDP m/m", actual: "-", forecast: "0.1%", previous: "0.2%" },
  { offset: 1, time: "17:00", currency: "EUR", impact: "medium", title: "Sentix Investor Confidence", actual: "-", forecast: "-1.5", previous: "-3.6" },
  { offset: 2, time: "18:00", currency: "USD", impact: "high", title: "Core CPI m/m", actual: "-", forecast: "0.3%", previous: "0.2%" },
  { offset: 2, time: "18:00", currency: "USD", impact: "high", title: "CPI y/y", actual: "-", forecast: "3.4%", previous: "3.5%" },
  { offset: 2, time: "20:00", currency: "CAD", impact: "medium", title: "BOC Business Outlook Survey", actual: "-", forecast: "-", previous: "-" },
  { offset: 3, time: "12:30", currency: "GBP", impact: "medium", title: "Claimant Count Change", actual: "-", forecast: "9.5K", previous: "8.9K" },
  { offset: 3, time: "18:00", currency: "USD", impact: "high", title: "PPI m/m", actual: "-", forecast: "0.2%", previous: "0.5%" },
  { offset: 3, time: "20:00", currency: "USD", impact: "medium", title: "Prelim UoM Consumer Sentiment", actual: "-", forecast: "73.0", previous: "72.3" },
  { offset: 4, time: "18:00", currency: "USD", impact: "high", title: "Retail Sales m/m", actual: "-", forecast: "0.3%", previous: "0.0%" },
  { offset: 4, time: "19:45", currency: "USD", impact: "medium", title: "Industrial Production m/m", actual: "-", forecast: "0.2%", previous: "0.1%" },
  { offset: 5, time: "07:00", currency: "AUD", impact: "high", title: "Cash Rate", actual: "-", forecast: "4.35%", previous: "4.35%" },
  { offset: 5, time: "07:00", currency: "AUD", impact: "high", title: "RBA Rate Statement", actual: "-", forecast: "-", previous: "-" },
  { offset: 5, time: "20:00", currency: "USD", impact: "high", title: "Crude Oil Inventories", actual: "-", forecast: "-1.2M", previous: "-2.5M" },
  { offset: 6, time: "18:00", currency: "USD", impact: "high", title: "Unemployment Claims", actual: "-", forecast: "224K", previous: "229K" },
  { offset: 6, time: "20:30", currency: "USD", impact: "medium", title: "FOMC Member Speaks", actual: "-", forecast: "-", previous: "-" },
  { offset: 7, time: "07:20", currency: "JPY", impact: "medium", title: "Trade Balance", actual: "-", forecast: "-0.38T", previous: "-0.46T" },
  { offset: 7, time: "14:30", currency: "EUR", impact: "medium", title: "German Ifo Business Climate", actual: "-", forecast: "89.5", previous: "89.3" },
  { offset: 8, time: "12:30", currency: "GBP", impact: "high", title: "CPI y/y", actual: "-", forecast: "2.2%", previous: "2.3%" },
  { offset: 8, time: "18:00", currency: "USD", impact: "medium", title: "Building Permits", actual: "-", forecast: "1.45M", previous: "1.44M" },
  { offset: 9, time: "18:00", currency: "USD", impact: "high", title: "Final GDP q/q", actual: "-", forecast: "1.3%", previous: "1.3%" },
  { offset: 9, time: "20:30", currency: "USD", impact: "medium", title: "Pending Home Sales m/m", actual: "-", forecast: "0.6%", previous: "-1.0%" },
  { offset: 10, time: "12:30", currency: "EUR", impact: "medium", title: "German Prelim CPI m/m", actual: "-", forecast: "0.2%", previous: "0.1%" },
  { offset: 10, time: "18:00", currency: "USD", impact: "high", title: "Core PCE Price Index m/m", actual: "-", forecast: "0.2%", previous: "0.2%" },
  { offset: 11, time: "06:00", currency: "CNY", impact: "high", title: "Manufacturing PMI", actual: "-", forecast: "50.1", previous: "49.8" },
  { offset: 11, time: "18:00", currency: "CAD", impact: "high", title: "GDP m/m", actual: "-", forecast: "0.1%", previous: "0.0%" },
  { offset: 12, time: "18:00", currency: "USD", impact: "high", title: "Non-Farm Payrolls", actual: "-", forecast: "185K", previous: "175K" },
  { offset: 12, time: "18:00", currency: "USD", impact: "high", title: "Unemployment Rate", actual: "-", forecast: "4.0%", previous: "3.9%" }
].map((event, index) => ({ ...event, id: `market-event-${index}`, date: marketDateOffset(event.offset) }));

function parseMarketDate(value) {
  const [year, month, day] = String(value || "").split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1, 12, 0, 0, 0);
}

function formatMarketDateLabel(value) {
  const date = parseMarketDate(value);
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  if (formatLocalDateValue(date) === formatLocalDateValue(today)) return "Today";
  if (formatLocalDateValue(date) === formatLocalDateValue(tomorrow)) return "Tomorrow";
  return date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

function getMarketWeekWindow(addWeeks = 0) {
  const start = new Date();
  start.setHours(12, 0, 0, 0);
  const day = start.getDay();
  start.setDate(start.getDate() + (day === 0 ? -6 : 1 - day) + (addWeeks * 7));
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { start, end };
}

function isMarketEventInRange(event) {
  const eventDate = parseMarketDate(event.date);
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  if (marketCalendarFilters.range === "today") {
    return formatLocalDateValue(eventDate) === formatLocalDateValue(today);
  }
  if (marketCalendarFilters.range === "tomorrow") {
    return formatLocalDateValue(eventDate) === formatLocalDateValue(tomorrow);
  }
  if (marketCalendarFilters.range === "week") {
    const { start, end } = getMarketWeekWindow(0);
    return eventDate >= start && eventDate <= end;
  }
  if (marketCalendarFilters.range === "next-week") {
    const { start, end } = getMarketWeekWindow(1);
    return eventDate >= start && eventDate <= end;
  }
  if (marketCalendarFilters.range === "date") {
    return event.date === marketCalendarFilters.date;
  }
  return true;
}

function getFilteredEconomicEvents() {
  const search = marketCalendarFilters.search.trim().toLowerCase();
  return economicCalendarEvents
    .filter(isMarketEventInRange)
    .filter((event) => marketCalendarFilters.impact === "all" || event.impact === marketCalendarFilters.impact)
    .filter((event) => marketCalendarFilters.currency === "all" || event.currency === marketCalendarFilters.currency)
    .filter((event) => {
      if (!search) return true;
      return [event.title, event.currency, event.impact, event.actual, event.forecast, event.previous]
        .join(" ")
        .toLowerCase()
        .includes(search);
    })
    .sort((a, b) => {
      const dateOrder = parseMarketDate(a.date) - parseMarketDate(b.date);
      if (dateOrder !== 0) return dateOrder;
      return String(a.time).localeCompare(String(b.time));
    });
}

function renderEconomicCalendar() {
  const list = document.querySelector("[data-economic-calendar]");
  if (!list) return;

  const dateInput = document.querySelector("[data-market-date]");
  if (dateInput && dateInput.value !== marketCalendarFilters.date) {
    dateInput.value = marketCalendarFilters.date;
  }
  document.querySelectorAll("[data-market-range]").forEach((button) => {
    button.classList.toggle("active", button.dataset.marketRange === marketCalendarFilters.range);
  });
  document.querySelector(".market-date-picker")?.classList.toggle("active", marketCalendarFilters.range === "date");

  const events = getFilteredEconomicEvents();
  const grouped = events.reduce((acc, event) => {
    acc[event.date] = acc[event.date] || [];
    acc[event.date].push(event);
    return acc;
  }, {});
  const now = new Date();
  const updatedNode = document.querySelector("[data-market-updated]");
  if (updatedNode) {
    updatedNode.textContent = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  }
  document.querySelectorAll("[data-market-count]").forEach((node) => node.textContent = String(events.length));
  document.querySelectorAll("[data-market-high-count]").forEach((node) => {
    node.textContent = String(events.filter((event) => event.impact === "high").length);
  });
  document.querySelectorAll("[data-market-next]").forEach((node) => {
    const next = events.find((event) => parseMarketDate(event.date) >= parseMarketDate(formatLocalDateValue(now))) || events[0];
    node.textContent = next ? `${next.currency} ${next.time}` : "No match";
  });

  if (!events.length) {
    list.innerHTML = `<div class="market-empty">No events match the selected filters.</div>`;
    return;
  }

  list.innerHTML = Object.entries(grouped).map(([date, rows]) => `
    <div class="market-date-row">
      <strong>${formatMarketDateLabel(date)}</strong>
      <span>${parseMarketDate(date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
    </div>
    ${rows.map((event) => `
      <button class="market-event-row impact-${event.impact}" type="button">
        <span class="market-time">${escapeHtml(event.time)}</span>
        <span class="market-currency">${escapeHtml(event.currency)}</span>
        <span class="market-impact"><i class="impact-dot ${event.impact}"></i>${escapeHtml(event.impact)}</span>
        <span class="market-event-name"><strong>${escapeHtml(event.title)}</strong><em>${event.currency === "USD" ? "Key for XAUUSD volatility" : "Macro calendar event"}</em></span>
        <span class="market-value ${event.actual !== "-" ? "filled" : ""}">${escapeHtml(event.actual)}</span>
        <span class="market-value">${escapeHtml(event.forecast)}</span>
        <span class="market-value">${escapeHtml(event.previous)}</span>
      </button>
    `).join("")}
  `).join("");
}

document.querySelectorAll("[data-market-range]").forEach((button) => {
  button.addEventListener("click", () => {
    marketCalendarFilters.range = button.dataset.marketRange || "all";
    renderEconomicCalendar();
  });
});

document.querySelectorAll("[data-market-impact]").forEach((button) => {
  button.addEventListener("click", () => {
    marketCalendarFilters.impact = button.dataset.marketImpact || "all";
    document.querySelectorAll("[data-market-impact]").forEach((item) => item.classList.toggle("active", item === button));
    renderEconomicCalendar();
  });
});

document.querySelector("[data-market-currency]")?.addEventListener("change", (event) => {
  marketCalendarFilters.currency = event.currentTarget.value || "all";
  renderEconomicCalendar();
});

document.querySelector("[data-market-search]")?.addEventListener("input", (event) => {
  marketCalendarFilters.search = event.currentTarget.value || "";
  renderEconomicCalendar();
});

document.querySelector("[data-market-date]")?.addEventListener("change", (event) => {
  marketCalendarFilters.date = event.currentTarget.value || formatLocalDateValue(new Date());
  marketCalendarFilters.range = "date";
  renderEconomicCalendar();
});

function updateMarketSessions() {
  const now = new Date();
  const istParts = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(now);
  const hour = Number(istParts.find((part) => part.type === "hour")?.value || 0);
  const minute = Number(istParts.find((part) => part.type === "minute")?.value || 0);
  const currentMinutes = hour * 60 + minute;

  document.querySelectorAll("[data-session-card]").forEach((card) => {
    const start = Number(card.dataset.start);
    const end = Number(card.dataset.end);
    const isOpen = start < end
      ? currentMinutes >= start && currentMinutes < end
      : currentMinutes >= start || currentMinutes < end;
    card.classList.toggle("active", isOpen);
    card.dataset.status = isOpen ? "OPEN" : "CLOSED";
  });
}

function updateClock() {
  const clock = document.querySelector("[data-clock]");
  if (!clock) return;

  const now = new Date();
  const time = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const zone = now.toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ").pop();
  clock.innerHTML = `<span>Market Time</span><strong>${time}</strong><em>${zone}</em>`;
}

updateClock();
setInterval(updateClock, 1000);
updateMarketSessions();
setInterval(updateMarketSessions, 60000);
renderEconomicCalendar();
updateLotAssistant();

const todayLabel = document.querySelector("[data-today-label]");
if (todayLabel) todayLabel.textContent = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

resetAnalytics();
if (authGate && appWorkspace) {
  restoreAuthenticatedApp()
    .then((restored) => {
      if (!restored || !document.body.classList.contains("app-authenticated")) showAuth(initialAuthMode);
    })
    .catch(() => showAuth(initialAuthMode));
}
