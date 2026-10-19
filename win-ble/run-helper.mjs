// Windows counterpart of mac-ble/run-helper.sh: runs the committed helper when it matches the
// source, otherwise builds a local copy with the .NET SDK. stdin/stdout pass straight through.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { PREBUILT_EXE, PREBUILT_HASH, SOURCES, WIN_BLE_DIR, sourceHash } from "./helper-source.mjs";

const localDir = join(dirname(WIN_BLE_DIR), ".build", "win-ble");
const localExe = join(localDir, "CyclingOSZwiftBLE.exe");

run(resolveHelper());

function resolveHelper() {
  const prebuiltHash = existsSync(PREBUILT_HASH) ? readFileSync(PREBUILT_HASH, "utf8").trim() : null;
  if (existsSync(PREBUILT_EXE) && prebuiltHash === sourceHash()) return PREBUILT_EXE;

  // The source changed (or no prebuilt), so build for this PC. Needs the .NET 8 SDK.
  if (spawnSync("dotnet", ["--list-sdks"], { stdio: "ignore" }).status !== 0) {
    if (existsSync(PREBUILT_EXE)) {
      console.error("Warning: Bluetooth helper source changed but the .NET SDK is not installed; using the older prebuilt helper.");
      return PREBUILT_EXE;
    }
    console.error("Bluetooth helper unavailable: install the .NET 8 SDK (winget install Microsoft.DotNet.SDK.8).");
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
