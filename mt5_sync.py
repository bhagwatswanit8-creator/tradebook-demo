"""One-shot MT5 sync (CLI). Prefer mt5_bridge.py via server for normal use."""
import json
import sys

from mt5_core import shutdown_terminal, sync_account

try:
    login = int(sys.argv[1])
    password = sys.argv[2]
    server = sys.argv[3]
    print(json.dumps(sync_account(login, password, server)))
except Exception as exc:
    print(json.dumps({"ok": False, "error": str(exc)}))
finally:
    shutdown_terminal()
