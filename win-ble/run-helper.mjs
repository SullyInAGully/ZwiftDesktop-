// Windows counterpart of mac-ble/run-helper.sh: builds the Bluetooth helper with the .NET 8 SDK on first
// use (and when its source changes), then runs it. stdin/stdout pass straight through. Bluetooth is an
// optional legacy transport on Windows; the Wi-Fi stream needs none of this.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { SOURCES, WIN_BLE_DIR } from "./helper-source.mjs";

const localDir = join(dirname(WIN_BLE_DIR), ".build", "win-ble");
const localExe = join(localDir, "CyclingOSZwiftBLE.exe");

run(resolveHelper());

function resolveHelper() {
  if (spawnSync("dotnet", ["--list-sdks"], { stdio: "ignore" }).status !== 0) {
    console.error("Bluetooth helper unavailable: install the .NET 8 SDK (winget install Microsoft.DotNet.SDK.8), or use the Wi-Fi link instead.");
    process.exit(1);
  }
  const stale = !existsSync(localExe) || SOURCES.some(path => statSync(path).mtimeMs > statSync(localExe).mtimeMs);
  if (stale) {
    // Build output goes to stderr so it never mixes with the READY/SUBSCRIBERS protocol on stdout.
    const build = spawnSync("dotnet", [
      "build", join(WIN_BLE_DIR, "ZwiftLivePeripheral.csproj"), "-c", "Release", "-o", localDir, "--nologo", "-v", "q"
    ], { stdio: ["ignore", process.stderr, process.stderr] });
    if (build.status !== 0) process.exit(build.status ?? 1);
  }
  return localExe;
}

function run(exe) {
  const child = spawn(exe, [], { stdio: "inherit", windowsHide: true });
  child.on("error", error => { console.error(`Bluetooth helper failed to start: ${error.message}`); process.exit(1); });
  child.on("exit", code => process.exit(code ?? 1));
}
