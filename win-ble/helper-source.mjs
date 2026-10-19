import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const WIN_BLE_DIR = dirname(fileURLToPath(import.meta.url));
export const SOURCES = ["Program.cs", "ZwiftLivePeripheral.csproj"].map(name => join(WIN_BLE_DIR, name));
