"""Platform-specific bridge installer script templates.

Each template is rendered server-side with the agent's freshly-regenerated
API key and the resolved WebSocket server URL baked in, then returned as
an attachment for the user to run locally.

Windows: returns a single `clawith-bridge-setup.exe` — the pristine
PyInstaller binary with a config trailer (JSON + magic) appended at EOF.
The user double-clicks it; the bridge detects the trailer on startup,
runs the install flow, strips the trailer from the installed copy at
%LOCALAPPDATA%\\Clawith\\bin\\, and registers a scheduled task. No ZIP,
no manual extraction, no install.cmd.

macOS/Linux: returns a bash script that pip-installs `clawith-bridge`
and registers launchd/systemd user services.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

Platform = Literal["windows", "macos", "linux"]

# Wire format shared with `bridge/clawith_bridge/baked_config.py`. If you
# change either side, change the other. Structure at end of file:
#   [json utf-8 blob] [4B pristine_len BE] [8B magic]
_TRAILER_MAGIC: bytes = b"CLWB!END"
_TRAILER_LEN_BYTES = 4


# Location of the bundled bridge exe. Kept inside the backend package so
# it ships via the normal Dockerfile `COPY . .` step.
_BRIDGE_STATIC_DIR = (
    Path(__file__).resolve().parent.parent.parent / "static" / "bridge"
)
_BRIDGE_EXE_PATH = _BRIDGE_STATIC_DIR / "clawith-bridge.exe"


def _current_wheel_filename() -> str:
    """Return the filename of the bundled clawith_bridge wheel.

    pip needs the PEP-427 filename (NAME-VERSION-PYTHON-ABI-PLATFORM.whl)
    to parse package metadata at install time, so the installer script
    has to save the download under the real filename — not a sanitised
    temp name. We look it up at render time and bake the name into the
    script.
    """
    matches = sorted(_BRIDGE_STATIC_DIR.glob("clawith_bridge-*-py3-none-any.whl"))
    if not matches:
        raise FileNotFoundError(
            f"no clawith_bridge wheel found under {_BRIDGE_STATIC_DIR}. "
            "Build one via: `cd Clawith/bridge && uv build --wheel && "
            "cp dist/clawith_bridge-*.whl ../backend/app/static/bridge/`."
        )
    # Lexicographic order matches semver for our single-digit 0.x.y versions.
    return matches[-1].name


_UNIX_SH = r"""#!/usr/bin/env bash
# Clawith Bridge Installer (auto-generated)
# Agent: {agent_name}
# Run:  bash install-clawith-bridge.sh

set -euo pipefail

CLAWITH_SERVER="{server_url}"
CLAWITH_TOKEN="{api_key}"
# HTTP(S) base of the Clawith server — used to fetch the bridge wheel.
# The WebSocket URL above is used at bridge *runtime*; this URL is used
# only during install, so if you relocate the server later, you only
# need to re-download and re-run the installer.
CLAWITH_HTTP_BASE="{http_base}"

# ── Locate a suitable Python (>=3.10) ─────────────────────
# We prefer explicitly-named interpreters over the bare `python3` symlink
# because the latter still resolves to Apple's command-line-tools 3.9 on
# many Macs. Falling back to `python3` only after the versioned candidates
# have been ruled out means we won't silently pick a too-old interpreter.
echo "[clawith-bridge] Locating Python >= 3.10..."
CANDIDATES=(python3.14 python3.13 python3.12 python3.11 python3.10 python3)
PY=""
for c in "${{CANDIDATES[@]}}"; do
    if command -v "$c" >/dev/null 2>&1; then
        ver=$("$c" -c 'import sys;print(f"{{sys.version_info.major}}.{{sys.version_info.minor}}")' 2>/dev/null || echo "0.0")
        major=${{ver%%.*}}; minor=${{ver##*.}}
        if [ "$major" = "3" ] && [ "$minor" -ge 10 ] 2>/dev/null; then
            PY=$(command -v "$c")
            echo "[clawith-bridge]   using $PY (Python $ver)"
            break
        fi
    fi
done
if [ -z "$PY" ]; then
    echo "[clawith-bridge] ERROR: no Python >= 3.10 found in PATH." >&2
    echo "   macOS:  brew install python@3.12  (or 3.13/3.14)" >&2
    echo "   Linux:  use your distro's Python 3.10+ package, or pyenv." >&2
    exit 1
fi

# ── Install clawith_bridge into a dedicated venv ─────────
# A per-bridge venv sidesteps Homebrew/Debian PEP-668 "externally managed"
# blocks and avoids dirtying the user's site-packages. The venv is
# disposable — rm -rf ~/.clawith-bridge to uninstall.
VENV_DIR="$HOME/.clawith-bridge/venv"
VPY="$VENV_DIR/bin/python3"
if [ ! -x "$VPY" ]; then
    echo "[clawith-bridge] Creating venv at $VENV_DIR"
    "$PY" -m venv "$VENV_DIR"
fi

echo "[clawith-bridge] Downloading bridge wheel from $CLAWITH_HTTP_BASE"
# `mktemp -t PREFIX` with a suffix is non-portable (macOS leaves the XXXXXX
# literal; GNU mktemp refuses templates without X's). Create a temp dir
# and save under the real PEP-427 wheel filename — pip parses package
# name/version/tags out of the filename, so it can't be renamed.
TMP_DIR=$(mktemp -d)
TMP_WHEEL="$TMP_DIR/{wheel_filename}"
# shellcheck disable=SC2064 — we want $TMP_DIR expanded now, not at trap time.
trap "rm -rf '$TMP_DIR'" EXIT
if ! curl -fsSL "$CLAWITH_HTTP_BASE/api/bridge/wheel" -o "$TMP_WHEEL"; then
    echo "[clawith-bridge] ERROR: failed to fetch wheel from $CLAWITH_HTTP_BASE/api/bridge/wheel" >&2
    echo "   Check that the Clawith server is reachable and that its backend was" >&2
    echo "   started after \`uv build --wheel\` was run in Clawith/bridge/." >&2
    exit 1
fi

echo "[clawith-bridge] Installing wheel into venv"
"$VPY" -m pip install --upgrade pip >/dev/null
"$VPY" -m pip install --upgrade "$TMP_WHEEL"

CONFIG_PATH="$HOME/.clawith-bridge.toml"
echo "[clawith-bridge] Writing config to $CONFIG_PATH"
cat > "$CONFIG_PATH" <<EOF
# Auto-generated by Clawith installer. Do not share this file - it contains your API key.
server = "$CLAWITH_SERVER"
token  = "$CLAWITH_TOKEN"

max_concurrent_sessions = 4

[claude_code]
enabled    = {cc_enabled}
executable = "claude"

[hermes]
enabled  = {hm_enabled}
base_url = "http://127.0.0.1:7890"

[openclaw]
enabled  = {oc_enabled}
base_url = "http://127.0.0.1:9000"
EOF
chmod 600 "$CONFIG_PATH"

UNAME="$(uname -s)"
if [[ "$UNAME" == "Darwin" ]]; then
    # ── macOS: launchctl user agent ─────────────────────
    PLIST_DIR="$HOME/Library/LaunchAgents"
    PLIST="$PLIST_DIR/com.clawith.bridge.plist"
    mkdir -p "$PLIST_DIR"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.clawith.bridge</string>
    <key>ProgramArguments</key>
    <array>
        <string>$VPY</string>
        <string>-m</string>
        <string>clawith_bridge</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$HOME/Library/Logs/clawith-bridge.log</string>
    <key>StandardErrorPath</key><string>$HOME/Library/Logs/clawith-bridge.err.log</string>
</dict>
</plist>
EOF
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo ""
    echo "[clawith-bridge] Done."
    echo "   Config: $CONFIG_PATH"
    echo "   Agent:  com.clawith.bridge (launchd, auto-starts at login)"
    echo "   Logs:   tail -f ~/Library/Logs/clawith-bridge.log"
elif [[ "$UNAME" == "Linux" ]]; then
    # ── Linux: systemd --user ───────────────────────────
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_DIR/clawith-bridge.service" <<EOF
[Unit]
Description=Clawith Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$VPY -m clawith_bridge
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now clawith-bridge.service
    echo ""
    echo "[clawith-bridge] Done."
    echo "   Config:   $CONFIG_PATH"
    echo "   Service:  clawith-bridge.service (systemd --user)"
    echo "   Status:   systemctl --user status clawith-bridge"
    echo "   Logs:     journalctl --user -u clawith-bridge -f"

    # systemd user service only runs while user session is active by default.
    # Enable lingering so it keeps running after logout (optional).
    if ! loginctl show-user "$USER" 2>/dev/null | grep -q "Linger=yes"; then
        echo ""
        echo "   Tip: enable linger so the service runs even when you're not logged in:"
        echo "     sudo loginctl enable-linger $USER"
    fi
else
    echo "[clawith-bridge] Unknown platform: $UNAME — config written, but autostart not configured." >&2
    echo "   Run manually:  $VPY -m clawith_bridge" >&2
fi

echo ""
echo "   If Clawith still shows 'Bridge not connected', ensure 'claude' CLI is installed and logged in:"
echo "     npm install -g @anthropic-ai/claude-code"
echo "     claude login"
"""


_KNOWN_ADAPTERS = ("claude_code", "openclaw", "hermes")


def _adapter_enabled_flags(adapter: str) -> dict[str, str]:
    """Return `{"cc_enabled": ..., "hm_enabled": ..., "oc_enabled": ...}` —
    three TOML bool literals with only `adapter` set to `true`. Unknown
    adapters default to claude_code."""
    if adapter not in _KNOWN_ADAPTERS:
        adapter = "claude_code"
    return {
        "cc_enabled": "true" if adapter == "claude_code" else "false",
        "hm_enabled": "true" if adapter == "hermes" else "false",
        "oc_enabled": "true" if adapter == "openclaw" else "false",
    }


def render_installer(
    platform: Platform,
    *,
    server_url: str,
    http_base: str,
    api_key: str,
    agent_name: str,
    adapter: str = "claude_code",
) -> tuple[bytes, str, str]:
    """Render a platform-specific installer.

    `server_url` is the bridge's *runtime* WebSocket URL (ws://…/wss://…).
    `http_base` is the HTTP(S) base used at *install time* to fetch the
    bundled clawith_bridge wheel (no trailing slash). For the standard
    LaboFlow/Clawith dev setup these point at the same host via different
    schemes.

    `adapter` picks which bridge adapter the generated TOML (or baked
    trailer, on Windows) enables — one of 'claude_code' | 'openclaw' |
    'hermes'.

    Returns (payload_bytes, filename, content_type).
    For Windows, payload is a single self-configuring .exe; for Unix, a
    bash script.
    """
    # Safety: template is a trusted constant, and we only format with values that
    # come from server-controlled sources (agent name, generated token, derived URL).
    # `agent_name` is the only user-controlled string that lands in a comment line.
    safe_name = agent_name.replace("\n", " ").replace("\r", " ")[:200]

    if platform == "windows":
        payload = _render_windows_exe(
            server_url=server_url,
            api_key=api_key,
            agent_name=safe_name,
            adapter=adapter,
        )
        return (
            payload,
            "clawith-bridge-setup.exe",
            "application/vnd.microsoft.portable-executable",
        )

    text = _UNIX_SH.format(
        agent_name=safe_name,
        server_url=server_url,
        http_base=http_base.rstrip("/"),
        api_key=api_key,
        wheel_filename=_current_wheel_filename(),
        **_adapter_enabled_flags(adapter),
    )
    return (
        text.encode("utf-8"),
        "install-clawith-bridge.sh",
        "text/x-shellscript; charset=utf-8",
    )


def _render_windows_exe(*, server_url: str, api_key: str, agent_name: str, adapter: str) -> bytes:
    """Return pristine bridge exe bytes + baked-config trailer at EOF.

    The trailer encodes the server URL, agent token, agent name, and chosen
    adapter as JSON. Bridge startup reads it via
    `baked_config.read_baked_config()` and runs the install flow
    automatically on first double-click.
    """
    if not _BRIDGE_EXE_PATH.exists():
        raise FileNotFoundError(
            f"bundled clawith-bridge.exe is missing at {_BRIDGE_EXE_PATH}. "
            "Build it via: cd bridge/ && pyinstaller clawith-bridge.spec --clean, "
            "then copy dist/clawith-bridge.exe to backend/app/static/bridge/."
        )

    pristine = _BRIDGE_EXE_PATH.read_bytes()
    config = {
        "server": server_url,
        "token": api_key,
        "agent_name": agent_name,
        "adapter": adapter if adapter in _KNOWN_ADAPTERS else "claude_code",
    }
    blob = json.dumps(config, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    pristine_len = len(pristine)
    trailer = blob + pristine_len.to_bytes(_TRAILER_LEN_BYTES, "big") + _TRAILER_MAGIC
    return pristine + trailer


def derive_ws_url(http_base: str) -> str:
    """Convert an HTTP(S) base URL to its WebSocket equivalent.

    `http://host:port`  -> `ws://host:port`
    `https://host:port` -> `wss://host:port`
    """
    if http_base.startswith("https://"):
        return "wss://" + http_base[len("https://"):]
    if http_base.startswith("http://"):
        return "ws://" + http_base[len("http://"):]
    # Already ws(s)?:// — return as-is
    return http_base
