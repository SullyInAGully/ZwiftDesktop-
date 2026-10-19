import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import process from "node:process";

export const ZWIFT_LIVE_SERVICE_UUID = "8E6F1000-7A95-4A7F-A8D9-4F6E9A1C2100";
export const ZWIFT_LIVE_STATE_UUID = "8E6F1001-7A95-4A7F-A8D9-4F6E9A1C2100";

/** The native peripheral helper for this OS: CoreBluetooth on macOS, WinRT GATT server on Windows. */
export function bleHelperCommand(root, platform = process.platform) {
  if (platform === "darwin") return { command: "sh", args: [join(root, "mac-ble", "run-helper.sh")] };
  if (platform === "win32") return { command: process.execPath, args: [join(root, "win-ble", "run-helper.mjs")] };
  return null;
}

/** Feeds 1 Hz JSON to the native BLE peripheral helper over stdin. */
export class BlePeripheralBridge extends EventEmitter {
  constructor({ helper, enabled = true }) {
    super();
    this.helper = helper;
    this.enabled = enabled;
    this.child = null;
    this.ready = false;
    this.subscribers = 0;
    this.lastMessage = null;
  }

  start() {
    if (!this.enabled || this.child) return;
    if (!this.helper) {
      this.lastMessage = `Bluetooth is not supported on ${process.platform}.`;
      return;
    }
    const child = spawn(this.helper.command, this.helper.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    child.stdout.on("data", chunk => {
      stdout += chunk;
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (line === "READY") {
          this.ready = true;
          this.emit("ready");
        } else if (line.startsWith("SUBSCRIBERS ")) {
          this.subscribers = Number(line.slice(12)) || 0;
          this.emit("subscribers", this.subscribers);
        } else if (line) {
          this.lastMessage = line;
          this.emit("log", line);
        }
      }
    });
    child.stderr.on("data", chunk => this.emit("error", new Error(chunk.trim())));
    child.on("error", error => this.emit("error", error));
    child.on("exit", code => {
      if (this.child === child) this.child = null;
      this.ready = false;
      this.subscribers = 0;
      if (code && code !== 0 && !child.closing) this.emit("error", new Error(`BLE helper exited with code ${code}`));
    });
  }

  publish(value) {
    if (!this.child?.stdin.writable) return false;
    return this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  async close() {
    const child = this.child;
    if (!child) return;
    child.closing = true;
    child.stdin.end();
    await new Promise(resolve => {
      const timeout = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 2000);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
    });
    this.child = null;
  }
}

/** No account id or credentials cross this link; the phone adds its own account metadata. */
export function bleState(row) {
  const allowed = [
    "sampledAtMs", "sourceAgeMs", "dataFresh", "elapsedRideSec", "powerW", "heartRateBpm",
    "cadenceRpm", "speedKmh", "distanceM", "ascentM", "altitudeM", "gradientPct", "courseId",
    "routeId", "routeName", "plannedDistanceM", "plannedElevationGainM", "routeDistanceM",
    "remainingDistanceM", "terrain", "onClimb", "climbCategory", "distanceToNextClimbM",
    "distanceToSummitM", "remainingElevationGainM", "activeClimbIndex", "activeClimbLengthM",
    "activeClimbAvgGradientPct", "activeClimbGainM", "nextClimbLengthM",
    "nextClimbAvgGradientPct", "nextClimbGainM", "routeProfileVersion", "routeCheckpoint",
    "routeCheckpointCount", "lap"
  ];
  return Object.fromEntries([["schemaVersion", 1], ...allowed.map(key => [key, row[key] ?? null])]);
}
