"""
SwanXm MT5 HTTP Bridge
Run this on your Windows PC (where MetaTrader 5 is installed).
Expose it externally with ngrok, then set MT5_BRIDGE_URL in Replit Secrets.

Quick start:
  1. pip install MetaTrader5 psutil
  2. python mt5_http_bridge.py
  3. ngrok http 8765
  4. Copy the ngrok https URL -> Replit Secrets -> MT5_BRIDGE_URL = https://xxxx.ngrok.io/sync
"""
import atexit
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from mt5_core import mt5_bridge_status, shutdown_terminal, sync_account

HOST = os.environ.get("MT5_BRIDGE_HOST", "0.0.0.0")
PORT = int(os.environ.get("MT5_BRIDGE_PORT", "8765"))
API_KEY = os.environ.get("MT5_BRIDGE_API_KEY", "")

atexit.register(shutdown_terminal)


class Mt5BridgeHandler(BaseHTTPRequestHandler):
    server_version = "SwanXmMT5Bridge/2.0"

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-MT5-Key")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _check_api_key(self):
        if not API_KEY:
            return True
        provided = self.headers.get("X-MT5-Key", "")
        return provided == API_KEY

    def do_OPTIONS(self):
        self._send_json(200, {"ok": True})

    def do_GET(self):
        if self.path.rstrip("/") == "/health":
            self._send_json(200, {
                "ok": True,
                "bridge": "mt5-http",
                "version": "2.0",
                "host": HOST,
                "port": PORT,
                "secured": bool(API_KEY),
                **mt5_bridge_status()
            })
            return
        self._send_json(404, {"ok": False, "error": "Not found."})

    def do_POST(self):
        if self.path.rstrip("/") != "/sync":
            self._send_json(404, {"ok": False, "error": "Not found."})
            return

        if not self._check_api_key():
            self._send_json(401, {"ok": False, "error": "Invalid or missing MT5_BRIDGE_API_KEY."})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(length).decode("utf-8") if length else "{}"
            payload = json.loads(raw_body)
        except Exception:
            self._send_json(400, {"ok": False, "error": "Invalid bridge request."})
            return

        login = payload.get("login")
        password = payload.get("password", "")
        server = payload.get("server", "")
        mode = payload.get("mode", "sync")

        if not login or not server:
            self._send_json(200, {"ok": False, "error": "MT5 login and server are required."})
            return

        if mode == "live_trades":
            from mt5_core import fetch_live_trades_formatted
            result = fetch_live_trades_formatted(login, password, server)
        elif mode == "live":
            from mt5_core import fetch_live_positions
            result = fetch_live_positions(login, password, server)
        else:
            result = sync_account(login, password, server)

        self._send_json(200, result)

    def log_message(self, format, *args):
        return


def main():
    bridge = ThreadingHTTPServer((HOST, PORT), Mt5BridgeHandler)
    print(f"", flush=True)
    print(f"  SwanXm MT5 Bridge running at http://0.0.0.0:{PORT}", flush=True)
    print(f"", flush=True)
    print(f"  Next step — expose this to the internet:", flush=True)
    print(f"    ngrok http {PORT}", flush=True)
    print(f"", flush=True)
    print(f"  Then copy the https://xxxx.ngrok.io URL and add it to", flush=True)
    print(f"  Replit Secrets as:  MT5_BRIDGE_URL = https://xxxx.ngrok.io/sync", flush=True)
    print(f"", flush=True)
    bridge.serve_forever()


if __name__ == "__main__":
    main()
