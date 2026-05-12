#!/bin/bash
set -e

# ─── Fix ownership of bind-mounted directories ───
# When users bind-mount host directories (e.g. ./skills/preloaded),
# the mount inherits the host UID/GID which may differ from the
# container's appuser. This entrypoint runs as root, fixes ownership,
# then drops privileges to appuser via gosu — the same pattern used
# by official postgres/redis images.

# Directories that may be bind-mounted and need appuser access
MOUNT_DIRS=(
    /app/skills/preloaded
    /data/files
)

for dir in "${MOUNT_DIRS[@]}"; do
    if [ -d "$dir" ]; then
        chown -R appuser:appuser "$dir" 2>/dev/null || true
    fi
done

# ─── Merge built-in skills into preloaded ───
# Built-in skills are backed up at /app/skills/_builtin during image build.
# After a bind-mount replaces /app/skills/preloaded, copy back any
# missing built-in skills (without overwriting user-provided ones).
BUILTIN_DIR="/app/skills/_builtin"
PRELOADED_DIR="/app/skills/preloaded"

if [ -d "$BUILTIN_DIR" ]; then
    mkdir -p "$PRELOADED_DIR"
    for skill_dir in "$BUILTIN_DIR"/*/; do
        [ -d "$skill_dir" ] || continue
        skill_name="$(basename "$skill_dir")"
        if [ ! -d "$PRELOADED_DIR/$skill_name" ]; then
            cp -r "$skill_dir" "$PRELOADED_DIR/$skill_name"
        fi
    done
    chown -R appuser:appuser "$PRELOADED_DIR"
fi

# ─── Auto-generate AES keys on first boot ───
# TENANT_AES_KEY and SYSTEM_AES_KEY are 32-byte hex strings used for
# API key encryption and secret storage.
#
# Key resolution order:
#   1. Environment variable (if already set and exactly 64 hex chars)
#   2. Persisted file  /data/files/.crypto_state.json  (from a previous run)
#   3. Auto-generate with openssl, persist for future runs
#
# Each deployment gets its own unique key pair. Users can override by
# setting the env var explicitly. The persisted file survives container
# restarts because /data/files is a named Docker volume.
CRYPTO_STATE_FILE="/data/files/.crypto_state.json"

# Portable hex key generator: tries openssl, falls back to /dev/urandom
_generate_hex_key() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 32 2>/dev/null || true
    else
        head -c 32 /dev/urandom | od -A n -t x1 | tr -d ' \n'
    fi
}

# Load a key from the persisted JSON state file (if present and valid)
_load_key_from_state() {
    local key_name="$1"
    [ -f "$CRYPTO_STATE_FILE" ] || return 1
    local val
    val=$(grep -o "\"$key_name\":\"[a-f0-9]\{64\}\"" "$CRYPTO_STATE_FILE" 2>/dev/null | head -1 | cut -d'"' -f4 || true)
    if [ -n "$val" ] && [ ${#val} -eq 64 ]; then
        echo "$val"
        return 0
    fi
    return 1
}

# Persist a key to the state file, creating/updating as needed
_save_key_to_state() {
    local key_name="$1" key_value="$2"
    mkdir -p "$(dirname "$CRYPTO_STATE_FILE")"

    if [ ! -f "$CRYPTO_STATE_FILE" ]; then
        printf '{"%s":"%s"}\n' "$key_name" "$key_value" > "$CRYPTO_STATE_FILE"
    elif grep -q "\"$key_name\":" "$CRYPTO_STATE_FILE" 2>/dev/null; then
        sed -i "s/\"$key_name\":\"[a-f0-9]\{64\}\"/\"$key_name\":\"$key_value\"/" "$CRYPTO_STATE_FILE"
    else
        sed -i "s/}$/,\"$key_name\":\"$key_value\"}/" "$CRYPTO_STATE_FILE"
    fi
    chown appuser:appuser "$CRYPTO_STATE_FILE" 2>/dev/null || true
}

resolve_aes_key() {
    local key_name="$1"
    local current_value
    current_value="$(printenv "$key_name" 2>/dev/null || true)"

    # 1. Environment variable already set (64 hex chars = 32 bytes)
    if [ -n "$current_value" ] && [ ${#current_value} -eq 64 ]; then
        return 0
    fi

    # 2. Load from persisted state file
    local stored_value
    stored_value=$(_load_key_from_state "$key_name" 2>/dev/null || true)
    if [ -n "$stored_value" ]; then
        export "$key_name=$stored_value"
        echo "[entrypoint] Loaded $key_name from $CRYPTO_STATE_FILE"
        return 0
    fi

    # 3. Generate new key and persist
    local new_key
    new_key=$(_generate_hex_key)
    if [ -z "$new_key" ] || [ ${#new_key} -ne 64 ]; then
        echo "[entrypoint] ERROR: Failed to generate $key_name" >&2
        return 1
    fi

    export "$key_name=$new_key"
    _save_key_to_state "$key_name" "$new_key"
    echo "[entrypoint] Generated and persisted $key_name"
}

resolve_aes_key "TENANT_AES_KEY"
resolve_aes_key "SYSTEM_AES_KEY"

# ─── Drop privileges and exec the main process ───
exec gosu appuser "$@"
