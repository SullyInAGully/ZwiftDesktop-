#!/bin/bash
# Double-click launcher for the CyclingOS Zwift Link (Intel Mac build). Everything it needs is in this folder.
cd "$(dirname "$0")" || exit 1

echo "CyclingOS Zwift Link"
echo "--------------------"
echo "Leave this window open while you ride. Close it (or press Ctrl+C) to stop."
echo

# Files downloaded from the internet are flagged by macOS and some would refuse to run; clear the flag
# for this folder only. (The first launch of this very file needed right-click > Open.)
xattr -dr com.apple.quarantine . 2>/dev/null

NODE="./runtime/node"
if [ ! -x "$NODE" ]; then
    echo "The program files are incomplete (runtime/node is missing)."
    echo "Please unzip the download again into a new folder and try once more."
    read -r -p "Press Return to close." _
    exit 1
fi

echo "Starting… (the very first start can take up to a minute while macOS checks the files)"
if ! "$NODE" --version >/dev/null 2>&1; then
    echo "This build is for Intel Macs and could not start on this computer."
    echo "Tell the person who sent it to you: $(uname -m), macOS $(sw_vers -productVersion 2>/dev/null)"
    read -r -p "Press Return to close." _
    exit 1
fi

"$NODE" src/companion-monitor.mjs "$@"
STATUS=$?

echo
if [ "$STATUS" -ne 0 ]; then
    echo "The program stopped unexpectedly (code $STATUS)."
    echo "The log is at: ~/Library/Logs/CyclingOS Zwift Link/monitor.log (please send it)."
else
    echo "Stopped."
fi
read -r -p "Press Return to close this window." _
exit "$STATUS"
