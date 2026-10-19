import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const WIN_BLE_DIR = dirname(fileURLToPath(import.meta.url));
export const SOURCES = ["Program.cs", "ZwiftLivePeripheral.csproj"].map(name => join(WIN_BLE_DIR, name));
export const PREBUILT_EXE = join(WIN_BLE_DIR, "prebuilt", "CyclingOSZwiftBLE.exe");
export const PREBUILT_HASH = join(WIN_BLE_DIR, "prebuilt", "SOURCE_SHA256");

/** Hash of the helper source, ignoring CRLF/LF so a git autocrlf checkout matches the committed build. */
export function sourceHash() {
  const hash = createHash("sha256");
  for (const path of SOURCES) hash.update(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
  return hash.digest("hex");
}
