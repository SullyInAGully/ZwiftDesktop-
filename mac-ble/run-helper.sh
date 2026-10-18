#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(dirname -- "$SCRIPT_DIR")"
APP_DIR="$ROOT_DIR/.build/CyclingOSZwiftBLE.app"
EXECUTABLE="$APP_DIR/Contents/MacOS/CyclingOSZwiftBLE"
SOURCE="$SCRIPT_DIR/ZwiftLivePeripheral.swift"

if [ ! -x "$EXECUTABLE" ] || [ "$SOURCE" -nt "$EXECUTABLE" ] || [ "$SCRIPT_DIR/Info.plist" -nt "$EXECUTABLE" ]; then
    mkdir -p "$APP_DIR/Contents/MacOS"
    cp "$SCRIPT_DIR/Info.plist" "$APP_DIR/Contents/Info.plist"
    xcrun swiftc "$SOURCE" -o "$EXECUTABLE"
fi

exec "$EXECUTABLE"
