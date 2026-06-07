"""Long-running MT5 bridge: initialize once, reuse connection (no restart per sync)."""
import atexit
import json
import sys

from mt5_core import shutdown_terminal, sync_account

atexit.register(shutdown_terminal)


def handle_request(payload):
    login = payload.get("login")
    password = payload.get("password", "")
    server = payload.get("server", "")
    mode = payload.get("mode", "sync")

    if not login or not server:
        return {"ok": False, "error": "MT5 login and server are required."}

    if mode == "live_trades":
        from mt5_core import fetch_live_trades_formatted
        return fetch_live_trades_formatted(login, password, server)
    
    if mode == "live":
        from mt5_core import fetch_live_positions
        return fetch_live_positions(login, password, server)

    return sync_account(login, password, server)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            print(json.dumps({"ok": False, "error": "Invalid bridge request."}), flush=True)
            continue

        request_id = payload.get("id")
        result = handle_request(payload)
        if request_id is not None:
            result["id"] = request_id
        print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
