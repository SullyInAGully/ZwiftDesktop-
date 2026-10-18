#!/bin/sh
# Builds the Bluetooth helper for both Apple Silicon and Intel Macs into mac-ble/prebuilt/.
# Run this on a Mac with Xcode or the Command Line Tools whenever the helper source changes,
# then commit mac-ble/prebuilt so riders' Macs do not need a compiler.
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SOURCE="$SCRIPT_DIR/ZwiftLivePeripheral.swift"
PLIST="$SCRIPT_DIR/Info.plist"
OUT="$SCRIPT_DIR/prebuilt/CyclingOSZwiftBLE.app"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

xcrun swiftc "$SOURCE" -O -target arm64-apple-macos11 -o "$TMP/arm64"
xcrun swiftc "$SOURCE" -O -target x86_64-apple-macos11 -o "$TMP/x86_64"

rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS"
lipo -create "$TMP/arm64" "$TMP/x86_64" -output "$OUT/Contents/MacOS/CyclingOSZwiftBLE"
cp "$PLIST" "$OUT/Contents/Info.plist"
# lipo invalidates the per-slice signatures; Apple Silicon refuses unsigned code, so ad-hoc sign the bundle.
codesign --force --sign - "$OUT"

cat "$SOURCE" "$PLIST" | shasum -a 256 | cut -d' ' -f1 > "$SCRIPT_DIR/prebuilt/SOURCE_SHA256"
lipo -info "$OUT/Contents/MacOS/CyclingOSZwiftBLE"
codesign --verify --verbose=1 "$OUT"
echo "Built $OUT"
