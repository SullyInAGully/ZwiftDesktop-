// Builds the Windows Bluetooth helper as a trimmed, self-contained x64 exe into win-ble/prebuilt/.
// Run this on Windows with the .NET 8 SDK whenever the helper source changes, then commit
// win-ble/prebuilt so riders' PCs need neither the SDK nor the .NET runtime.
import { spawnSync } from "node:child_process";
import { rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PREBUILT_EXE, PREBUILT_HASH, WIN_BLE_DIR, sourceHash } from "./helper-source.mjs";

const out = dirname(PREBUILT_EXE);
rmSync(out, { recursive: true, force: true });
const result = spawnSync("dotnet", [
  "publish", join(WIN_BLE_DIR, "ZwiftLivePeripheral.csproj"),
  "-c", "Release", "-r", "win-x64", "--self-contained",
  "-p:PublishSingleFile=true", "-p:PublishTrimmed=true", "-p:EnableCompressionInSingleFile=true",
  "-p:DebugType=none", "-o", out
], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);

writeFileSync(PREBUILT_HASH, `${sourceHash()}\n`);
console.log(`Built ${PREBUILT_EXE} (${(statSync(PREBUILT_EXE).size / 1e6).toFixed(1)} MB)`);
