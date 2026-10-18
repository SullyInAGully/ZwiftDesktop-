#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(dirname -- "$SCRIPT_DIR")"
SOURCE="$SCRIPT_DIR/ZwiftLivePeripheral.swift"
PREBUILT="$SCRIPT_DIR/prebuilt/CyclingOSZwiftBLE.app/Contents/MacOS/CyclingOSZwiftBLE"
LOCAL_APP="$ROOT_DIR/.build/CyclingOSZwiftBLE.app"
LOCAL="$LOCAL_APP/Contents/MacOS/CyclingOSZwiftBLE"
CURRENT_HASH="$(cat "$SOURCE" "$SCRIPT_DIR/Info.plist" | shasum -a 256 | cut -d' ' -f1)"

# Preferred: the committed universal (Apple Silicon + Intel) build, if it matches the source.
if [ -x "$PREBUILT" ] && [ "$(cat "$SCRIPT_DIR/prebuilt/SOURCE_SHA256" 2>/dev/null)" = "$CURRENT_HASH" ]; then
    exec "$PREBUILT"
fi

# Fallback: the source changed (or no prebuilt), so compile for this Mac. Needs the Command Line Tools.
if ! command -v xcrun >/dev/null 2>&1 || ! xcrun --find swiftc >/dev/null 2>&1; then
    if [ -x "$PREBUILT" ]; then
        echo "Warning: Bluetooth helper source changed but no compiler is installed; using the older prebuilt helper." >&2
        exec "$PREBUILT"
    fi
    echo "Bluetooth helper unavailable: install the Xcode Command Line Tools (xcode-select --install)." >&2
    exit 1
fi
if [ ! -x "$LOCAL" ] || [ "$SOURCE" -nt "$LOCAL" ] || [ "$SCRIPT_DIR/Info.plist" -nt "$LOCAL" ]; then
    mkdir -p "$LOCAL_APP/Contents/MacOS"
    cp "$SCRIPT_DIR/Info.plist" "$LOCAL_APP/Contents/Info.plist"
    xcrun swiftc "$SOURCE" -o "$LOCAL"
fi
exec "$LOCAL"
