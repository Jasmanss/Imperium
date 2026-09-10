"""Pairing-token auth for all action endpoints.

The token is generated once on first run and stored in ~/.imperium/token.
The phone pairs by scanning a QR code printed in the Mac terminal; the token
travels in the URL fragment (never sent to the server) and the frontend stores
it in localStorage, sending it back as a Bearer header on every request.
"""

from __future__ import annotations

import hmac
import secrets
import socket
from pathlib import Path

from fastapi.responses import JSONResponse

IMPERIUM_DIR = Path.home() / ".imperium"
TOKEN_FILE = IMPERIUM_DIR / "token"

# Paths reachable without a token: the health check and the static frontend.
# The frontend itself is useless without a paired token.
_PUBLIC_EXACT = {"/", "/favicon.ico", "/meta.json"}
_PUBLIC_PREFIX = "/app"

_token_cache: str | None = None


def get_token() -> str:
    """Load the pairing token, generating it on first run (file mode 0600)."""
    global _token_cache
    if _token_cache:
        return _token_cache
    IMPERIUM_DIR.mkdir(mode=0o700, exist_ok=True)
    if TOKEN_FILE.exists():
        _token_cache = TOKEN_FILE.read_text().strip()
        if _token_cache:
            return _token_cache
    _token_cache = secrets.token_urlsafe(32)
    TOKEN_FILE.touch(mode=0o600, exist_ok=True)
    TOKEN_FILE.write_text(_token_cache)
    return _token_cache


def _is_public(path: str) -> bool:
    return (
        path in _PUBLIC_EXACT
        or path == _PUBLIC_PREFIX
        or path.startswith(_PUBLIC_PREFIX + "/")
    )


async def auth_middleware(request, call_next):
    """Reject any non-public request without a valid Bearer pairing token."""
    if request.method == "OPTIONS" or _is_public(request.url.path):
        return await call_next(request)
    header = request.headers.get("authorization", "")
    supplied = header[7:] if header.lower().startswith("bearer ") else ""
    if not supplied or not hmac.compare_digest(supplied, get_token()):
        return JSONResponse(
            {
                "error": "Unauthorized — this device is not paired. "
                "Scan the QR code shown in the Mac terminal to pair."
            },
            status_code=401,
        )
    return await call_next(request)


def _lan_ip() -> str:
    """Best-effort LAN IP for the pairing URL (no traffic is actually sent)."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
        finally:
            s.close()
    except OSError:
        return "YOUR_MAC_IP"


def print_pairing_info(port: int) -> None:
    """Print the pairing URL (and a QR code if qrcode is installed)."""
    url = f"http://{_lan_ip()}:{port}/app#token={get_token()}"
    print("\n" + "=" * 60)
    print("PAIR YOUR PHONE — scan this QR code or open the URL:")
    print(url)
    print("(The token stays in the URL fragment and is stored on the")
    print(" phone; it is never logged by the server. To revoke access,")
    print(f" delete {TOKEN_FILE} and restart.)")
    try:
        import qrcode

        qr = qrcode.QRCode(border=1)
        qr.add_data(url)
        qr.print_ascii(invert=True)
    except ImportError:
        print("(pip install qrcode for a scannable QR code)")
    print("=" * 60 + "\n")
