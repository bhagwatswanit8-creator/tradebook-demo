import datetime as dt
import glob
import os
import platform
import subprocess

try:
    import MetaTrader5 as mt5
except ImportError:
    mt5 = None

try:
    import psutil
except ImportError:
    psutil = None

DEAL_ENTRY_IN = 0
DEAL_ENTRY_OUT = 1
DEAL_ENTRY_INOUT = 2
DEAL_ENTRY_OUT_BY = 3
DEAL_TYPE_BUY = 0
DEAL_TYPE_SELL = 1
CLOSE_ENTRIES = {DEAL_ENTRY_OUT, DEAL_ENTRY_INOUT, DEAL_ENTRY_OUT_BY}
TRADE_TYPES = {DEAL_TYPE_BUY, DEAL_TYPE_SELL}

_active_login = None
_active_server = None
_terminal_initialized = False
MT5_TIMEOUT_MS = int(os.environ.get("MT5_TIMEOUT_MS", "30000"))


def terminal_auto_launch_allowed():
    flag = os.environ.get("MT5_ALLOW_TERMINAL_LAUNCH", "1").strip().lower()
    return flag not in {"0", "false", "no", "off"}


def running_terminal_path():
    if platform.system().lower() != "windows" or psutil is None:
        return ""

    try:
        for process in psutil.process_iter(["name", "exe"]):
            name = str(process.info.get("name") or "").lower()
            exe = str(process.info.get("exe") or "").strip()
            if name in {"terminal.exe", "terminal64.exe"} and exe and os.path.exists(exe):
                return exe
    except Exception:
        return ""
    return ""


def discover_mt5_terminal_path():
    configured = os.environ.get("MT5_TERMINAL_PATH", "").strip().strip('"')
    if configured and os.path.exists(configured):
        return configured

    active = running_terminal_path()
    if active:
        return active

    if platform.system().lower() != "windows":
        return ""

    candidates = []
    for base in filter(None, [os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")]):
        candidates.extend([
            os.path.join(base, "MetaTrader 5", "terminal64.exe"),
            os.path.join(base, "XM Global MT5", "terminal64.exe"),
            os.path.join(base, "Vantage International MT5", "terminal64.exe"),
            os.path.join(base, "Five Percent Online MetaTrader 5", "terminal64.exe"),
        ])
        candidates.extend(glob.glob(os.path.join(base, "*MT5*", "terminal64.exe")))
        candidates.extend(glob.glob(os.path.join(base, "*MetaTrader*", "terminal64.exe")))

    for candidate in candidates:
        if candidate and os.path.exists(candidate):
            return candidate
    return ""


def mt5_bridge_status():
    return {
        "autoLaunch": terminal_auto_launch_allowed(),
        "terminalRunning": is_mt5_terminal_running(),
        "terminalPath": discover_mt5_terminal_path(),
    }


def is_mt5_terminal_running():
    if platform.system().lower() != "windows":
        return True

    if running_terminal_path():
        return True

    if psutil is not None:
        try:
            for process in psutil.process_iter(["name"]):
                name = str(process.info.get("name") or "").lower()
                if name in {"terminal.exe", "terminal64.exe"}:
                    return True
        except Exception:
            pass

    try:
        result = subprocess.run(
            ["tasklist", "/FO", "CSV", "/NH"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except Exception:
        return False

    output = result.stdout.lower()
    return "terminal64.exe" in output or "terminal.exe" in output


def mt5_error_message(action):
    err = mt5.last_error() if mt5 is not None else None
    if isinstance(err, tuple) and len(err) >= 2:
        code, text = err[0], err[1]
        if int(code) == -10005 or "timeout" in str(text).lower():
            return "MT5 connection timed out. Keep MetaTrader 5 open, logged in to the same account, and try again."
        return f"{action} failed. MT5 error {code}: {text}"
    if err:
        return f"{action} failed. MT5 error: {err}"
    return f"{action} failed. Open MetaTrader 5, log in to the same account, then try again."


def reset_terminal_connection():
    global _terminal_initialized, _active_login, _active_server
    if mt5 is None or not _terminal_initialized:
        return
    try:
        mt5.shutdown()
    except Exception:
        pass
    _terminal_initialized = False
    _active_login = None
    _active_server = None


def deal_timestamp_utc(deal):
    ts = deal.time_msc / 1000 if getattr(deal, "time_msc", 0) else deal.time
    return dt.datetime.fromtimestamp(ts, tz=dt.timezone.utc)


def session_name_gmt(close_utc):
    hour = close_utc.hour
    if hour < 8:
        return "Asia"
    if hour < 16:
        return "London"
    return "New York"


def direction_from_close_deal(deal_type):
    return "long" if int(deal_type) == DEAL_TYPE_SELL else "short"


def is_trade_deal(deal):
    try:
        return (
            int(deal.type) in TRADE_TYPES
            and bool(str(deal.symbol or "").strip())
            and float(getattr(deal, "volume", 0) or 0) > 0
        )
    except (TypeError, ValueError):
        return False


def deal_to_row(deal, entry_price=None):
    close_utc = deal_timestamp_utc(deal)
    exit_price = float(deal.price)
    entry = float(entry_price if entry_price is not None else exit_price)
    ticket = int(deal.ticket)
    gmt_label = close_utc.strftime("%Y-%m-%d %H:%M")
    symbol = str(deal.symbol).strip().upper()

    return {
        "date": close_utc.strftime("%Y-%m-%d"),
        "closedAt": close_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "symbol": symbol,
        "direction": direction_from_close_deal(int(deal.type)),
        "session": session_name_gmt(close_utc),
        "strategy": "MT5 Auto Import",
        "entry": entry,
        "exit": exit_price,
        "lotSize": float(deal.volume),
        "pnl": float(deal.profit),
        "mt5DealId": ticket,
        "note": f"Imported from MT5 deal {ticket} at {gmt_label} GMT+0",
        "source": "mt5"
    }


def load_history_deals():
    from_date = dt.datetime(2020, 1, 1)
    to_date = dt.datetime.now() + dt.timedelta(days=1)

    deals = mt5.history_deals_get(from_date, to_date, group="*")
    if deals is None:
        deals = mt5.history_deals_get(from_date, to_date)

    if deals is None:
        err = mt5.last_error()
        if not err:
            return None, "history_deals_get failed - open MT5, log in, and enable trade history in the terminal."
        return None, str(err) if err else "history_deals_get failed — open MT5, log in, and enable trade history in the terminal."

    return list(deals), None


def position_timestamp_utc(position):
    ts = getattr(position, "time", 0) or getattr(position, "time_msc", 0) / 1000
    if ts:
        return dt.datetime.fromtimestamp(ts, tz=dt.timezone.utc)
    return dt.datetime.now(dt.timezone.utc)


def position_to_row(position):
    try:
        open_utc = position_timestamp_utc(position)
        ticket = int(getattr(position, "ticket", 0) or 0)
        symbol = str(getattr(position, "symbol", "") or "").strip().upper()
        direction = "long" if int(getattr(position, "type", 0)) == DEAL_TYPE_BUY else "short"
        entry_price = float(getattr(position, "price_open", 0) or 0)
        exit_price = float(getattr(position, "price_current", 0) or entry_price or 0)
        lot_size = float(getattr(position, "volume", 0) or 0)
        pnl = float(getattr(position, "profit", 0) or 0)
        
        print(f"Converting position {ticket}: {symbol} {direction} entry={entry_price} exit={exit_price} pnl={pnl}", flush=True)

        row = {
            "date": open_utc.strftime("%Y-%m-%d"),
            "closedAt": None,
            "symbol": symbol,
            "direction": direction,
            "session": session_name_gmt(open_utc),
            "strategy": "MT5 Open Position",
            "entry": entry_price,
            "exit": exit_price,
            "lotSize": lot_size,
            "pnl": pnl,
            "mt5DealId": ticket,
            "note": f"Open MT5 position {ticket} on {symbol} (live unrealized P&L)",
            "source": "mt5"
        }
        print(f"Converted row: {row}", flush=True)
        return row
    except Exception as e:
        print(f"Error converting position: {e}", flush=True)
        raise


def load_open_positions():
    if mt5 is None:
        msg = "MetaTrader5 Python package is not installed. Run: python -m pip install MetaTrader5"
        print(msg, flush=True)
        return None, msg

    try:
        print("Calling mt5.positions_get(group='*')...", flush=True)
        positions = mt5.positions_get(group="*")
        print(f"mt5.positions_get returned: {type(positions)}, {positions}", flush=True)
    except Exception as exc:
        print(f"Exception calling positions_get: {exc}", flush=True)
        return None, str(exc)

    if positions is None:
        err = mt5.last_error()
        msg = str(err) if err else "positions_get failed - open MT5 and log in to view live positions."
        print(f"positions_get returned None, error: {msg}", flush=True)
        return None, msg

    print(f"Got {len(positions)} positions from MT5", flush=True)
    return list(positions), None


def build_trades_from_deals(deals):
    trade_deals = [deal for deal in deals if is_trade_deal(deal)]
    rows = []
    seen_tickets = set()

    by_position = {}
    for deal in trade_deals:
        position_id = int(deal.position_id)
        if position_id <= 0:
            continue
        by_position.setdefault(position_id, []).append(deal)

    for position_deals in by_position.values():
        position_deals.sort(key=lambda item: (item.time, getattr(item, "time_msc", 0)))
        ins = [item for item in position_deals if int(item.entry) == DEAL_ENTRY_IN]
        outs = [item for item in position_deals if int(item.entry) in CLOSE_ENTRIES]

        for out_deal in outs:
            ticket = int(out_deal.ticket)
            if ticket in seen_tickets:
                continue

            entry_price = None
            for in_deal in ins:
                if in_deal.time <= out_deal.time:
                    entry_price = float(in_deal.price)

            seen_tickets.add(ticket)
            rows.append(deal_to_row(out_deal, entry_price=entry_price))

    for deal in trade_deals:
        if int(deal.entry) not in CLOSE_ENTRIES:
            continue
        ticket = int(deal.ticket)
        if ticket in seen_tickets:
            continue
        seen_tickets.add(ticket)
        rows.append(deal_to_row(deal))

    rows.sort(key=lambda item: item.get("closedAt", ""), reverse=True)
    return rows


def ensure_connection(login, password, server):
    global _active_login, _active_server, _terminal_initialized

    if mt5 is None:
        return "MetaTrader5 Python package is not installed. Run: python -m pip install MetaTrader5"

    try:
        login = int(str(login).strip())
    except (TypeError, ValueError):
        return "MT5 login must be only the account number, for example 569233626."

    server = str(server).strip()
    password = str(password or "")

    if _terminal_initialized and _active_login == login and _active_server == server:
        info = mt5.terminal_info()
        account = mt5.account_info()
        if info is not None and account is not None and int(account.login) == login:
            return None

    if _terminal_initialized and (_active_login != login or _active_server != server):
        reset_terminal_connection()

    terminal_path = discover_mt5_terminal_path()
    terminal_running = is_mt5_terminal_running()

    if not _terminal_initialized and not terminal_running and not terminal_auto_launch_allowed():
        return (
            "MT5 terminal is not running and auto-launch is disabled. "
            "Open MT5 once or set MT5_ALLOW_TERMINAL_LAUNCH=1 before starting the bridge."
        )

    if not _terminal_initialized and not terminal_running and terminal_auto_launch_allowed() and not terminal_path:
        return (
            "MT5 terminal is not running and no terminal64.exe path was found. "
            "Install MetaTrader 5 or set MT5_TERMINAL_PATH to your terminal64.exe path."
        )

    credential_init = {
        "login": login,
        "password": password,
        "server": server,
        "timeout": MT5_TIMEOUT_MS,
    }
    path_credential_init = {**credential_init, "path": terminal_path} if terminal_path else credential_init

    if not _terminal_initialized:
        if not mt5.initialize(**path_credential_init):
            first_error = mt5_error_message("Could not connect to MetaTrader 5")
            try:
                mt5.shutdown()
            except Exception:
                pass

            if terminal_path and mt5.initialize(**credential_init):
                _terminal_initialized = True
            else:
                return first_error
        else:
            _terminal_initialized = True

    if _terminal_initialized:
        account = mt5.account_info()
        if account is not None and int(account.login) == login:
            _active_login = login
            _active_server = server
            return None

    if _terminal_initialized:
        reset_terminal_connection()
        if not mt5.initialize(**path_credential_init):
            first_error = mt5_error_message("Could not connect to MetaTrader 5")
            try:
                mt5.shutdown()
            except Exception:
                pass
            if not terminal_path or not mt5.initialize(**credential_init):
                return first_error
        _terminal_initialized = True

    account = mt5.account_info()
    if account is None:
        return mt5_error_message("MT5 account check")

    if int(account.login) != login:
        return f"MT5 connected to account {account.login}, not {login}. Log in to the exact account in MetaTrader 5 and sync again."

    _active_login = login
    _active_server = server
    return None


def fetch_closed_trades():
    deals, history_error = load_history_deals()
    if deals is None:
        deals = []

    trade_deals = [deal for deal in deals if is_trade_deal(deal)]
    rows = build_trades_from_deals(deals)
    rows.sort(key=lambda item: (item.get("closedAt") or item.get("date") or "", item.get("symbol", "")), reverse=True)

    if not rows and trade_deals:
        return {
            "ok": False,
            "error": f"Found {len(trade_deals)} MT5 deals but no closed trade exits. Check History in MT5 terminal.",
            "totalDeals": len(deals),
            "tradeDeals": len(trade_deals),
            "importedDeals": 0,
            "trades": []
        }

    if not rows:
        return {
            "ok": True,
            "status": "connected",
            "trades": [],
            "totalDeals": len(deals),
            "tradeDeals": len(trade_deals),
            "importedDeals": 0,
            "message": "Connected. No trade history in MT5 for this account yet."
        }

    return {
        "ok": True,
        "status": "connected",
        "trades": rows,
        "totalDeals": len(deals),
        "tradeDeals": len(trade_deals),
        "importedDeals": len(rows)
    }


def fetch_live_positions(login, password, server):
    error = ensure_connection(login, password, server)
    if error:
        print(f"Connection error: {error}", flush=True)
        return {"ok": False, "error": error}

    try:
        print("Loading open positions from MT5...", flush=True)
        positions, position_error = load_open_positions()
        print(f"load_open_positions returned: {len(positions) if positions else 0} positions, error: {position_error}", flush=True)
        
        if positions is None:
            positions = []
        
        print(f"Converting {len(positions)} positions to rows...", flush=True)
        rows = [position_to_row(position) for position in positions if getattr(position, "symbol", "")]
        print(f"Converted to {len(rows)} rows", flush=True)
        
        # Calculate total PNL from all positions
        total_pnl = sum(float(trade.get("pnl", 0)) for trade in rows)
        win_count = sum(1 for trade in rows if float(trade.get("pnl", 0)) > 0)
        
        result = {
            "ok": True,
            "status": "connected",
            "positions": rows,
            "count": len(rows),
            "totalPnl": round(total_pnl, 2),
            "winCount": win_count,
            "winRate": round((win_count / len(rows) * 100) if rows else 0, 2),
            "message": "Live MT5 positions refreshed." if rows else "No open MT5 positions at the moment.",
            "error": position_error if not rows else None,
        }
        print(f"Returning result: ok={result['ok']}, count={result['count']}, message={result['message']}", flush=True)
        return result
    except Exception as exc:
        print(f"Exception in fetch_live_positions: {exc}", flush=True)
        return {"ok": False, "error": str(exc)}


def fetch_live_trades_formatted(login, password, server):
    """Fetch live trades with dashboard-friendly formatting"""
    error = ensure_connection(login, password, server)
    if error:
        return {"ok": False, "error": error}

    try:
        positions, position_error = load_open_positions()
        if positions is None:
            positions = []
        
        trades = []
        for position in positions:
            if not getattr(position, "symbol", ""):
                continue
            
            trade = {
                "ticket": int(getattr(position, "ticket", 0) or 0),
                "symbol": str(getattr(position, "symbol", "") or "").strip().upper(),
                "type": "LONG" if int(getattr(position, "type", 0)) == DEAL_TYPE_BUY else "SHORT",
                "volume": round(float(getattr(position, "volume", 0) or 0), 2),
                "priceOpen": round(float(getattr(position, "price_open", 0) or 0), 2),
                "priceCurrent": round(float(getattr(position, "price_current", 0) or 0), 2),
                "pnl": round(float(getattr(position, "profit", 0) or 0), 2),
                "pnlPercent": round((float(getattr(position, "profit_percent", 0) or 0)), 2),
                "commission": round(float(getattr(position, "commission", 0) or 0), 2),
                "swap": round(float(getattr(position, "swap", 0) or 0), 2),
                "timeOpen": int(getattr(position, "time", 0) or 0),
                "status": "WINNING" if float(getattr(position, "profit", 0) or 0) > 0 else "LOSING" if float(getattr(position, "profit", 0) or 0) < 0 else "BREAKEVEN"
            }
            trades.append(trade)
        
        # Calculate statistics
        total_pnl = sum(trade["pnl"] for trade in trades)
        winning_trades = [t for t in trades if t["pnl"] > 0]
        losing_trades = [t for t in trades if t["pnl"] < 0]
        
        stats = {
            "totalTrades": len(trades),
            "winningTrades": len(winning_trades),
            "losingTrades": len(losing_trades),
            "totalPnl": round(total_pnl, 2),
            "winRate": round((len(winning_trades) / len(trades) * 100) if trades else 0, 2),
            "avgWin": round(sum(t["pnl"] for t in winning_trades) / len(winning_trades), 2) if winning_trades else 0,
            "avgLoss": round(sum(t["pnl"] for t in losing_trades) / len(losing_trades), 2) if losing_trades else 0,
            "profitFactor": round((sum(t["pnl"] for t in winning_trades) / abs(sum(t["pnl"] for t in losing_trades))) if losing_trades and sum(t["pnl"] for t in losing_trades) != 0 else 0, 2)
        }
        
        return {
            "ok": True,
            "status": "connected",
            "trades": trades,
            "stats": stats,
            "message": f"{len(trades)} open live trades" if trades else "No open positions",
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def sync_account(login, password, server):
    error = ensure_connection(login, password, server)
    if error:
        return {"ok": False, "error": error}
    try:
        return fetch_closed_trades()
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def shutdown_terminal():
    reset_terminal_connection()
