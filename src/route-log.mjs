import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_LOG_PATH = defaultLogPath();

/** Zwift writes to Documents/Zwift/Logs; on Windows, Documents is often redirected into OneDrive. */
export function defaultLogPath(env = process.env, home = homedir(), exists = existsSync) {
  const documents = [join(home, "Documents")];
  for (const oneDrive of [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial]) {
    if (oneDrive) documents.push(join(oneDrive, "Documents"));
  }
  const logs = documents.map(dir => join(dir, "Zwift", "Logs", "Log.txt"));
  return logs.find(path => exists(join(path, "..", ".."))) ?? logs[0];
}

export function createRouteState() {
  return {
    routeName: null,
    routeHash: null,
    worldId: null,
    plannedDistanceM: null,
    leadInDistanceM: null,
    plannedAscentM: null,
    checkpoint: null,
    checkpointCount: null,
    leadInComplete: false
  };
}

export function parseRouteLine(state, line) {
  let match;
  if ((match = line.match(/RouteComputer route-set routeHash=(\d+) worldId=(\d+) route=\s*(.+?)\s*$/))) {
    state.routeHash = Number(match[1]);
    state.worldId = Number(match[2]);
    state.routeName = match[3].trim();
  } else if ((match = line.match(/Setting Route:\s+(.+?)\s*$/))) {
    state.routeName = match[1].trim();
  } else if ((match = line.match(/Route stats:\s*([\d.]+)cm long with ([\d.]+)cm leadin and ([\d.]+)cm ascent/))) {
    state.plannedDistanceM = Number(match[1]) / 100;
    state.leadInDistanceM = Number(match[2]) / 100;
    state.plannedAscentM = Number(match[3]) / 100;
  } else if ((match = line.match(/Hit checkpoint (\d+) out of (\d+) on route:\s*"\s*(.+?)\s*"/))) {
    state.checkpoint = Number(match[1]);
    state.checkpointCount = Number(match[2]);
    state.routeName = match[3].trim();
  } else if (/Completed Leadin:/.test(line)) {
    state.leadInComplete = true;
  } else if (/DeleteCurrentActivity|Session data has been successfully reset/.test(line)) {
    state.checkpoint = null;
    state.checkpointCount = null;
    state.leadInComplete = false;
  }
  return state;
}

export class RouteLogWatcher extends EventEmitter {
  constructor(path = DEFAULT_LOG_PATH, pollMs = 500) {
    super();
    this.path = path;
    this.pollMs = pollMs;
    this.state = createRouteState();
    this.offset = 0;
    this.remainder = "";
    this.timer = null;
    this.reading = false;
  }

  async start() {
    await this.readNewBytes(true);
    this.timer = setInterval(() => this.readNewBytes(false).catch(error => this.emit("error", error)), this.pollMs);
    this.timer.unref?.();
    return this.state;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async readNewBytes(initial) {
    if (this.reading) return;
    this.reading = true;
    try {
      let info;
      try {
        info = await stat(this.path);
      } catch (error) {
        // Zwift creates Documents/Zwift/Logs on its first launch; keep polling until the log appears.
        if (error.code !== "ENOENT") throw error;
        this.offset = 0;
        this.remainder = "";
        return;
      }
      if (info.size < this.offset) {
        this.offset = 0;
        this.remainder = "";
      }
      if (info.size === this.offset) return;
      const length = info.size - this.offset;
      const handle = await open(this.path, "r");
      try {
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, this.offset);
        this.offset = info.size;
        const parts = (this.remainder + buffer.toString("utf8")).split(/\r?\n/);
        this.remainder = parts.pop() ?? "";
        for (const line of parts) {
          const before = JSON.stringify(this.state);
          parseRouteLine(this.state, line);
          if (!initial && JSON.stringify(this.state) !== before) this.emit("route", { ...this.state });
        }
      } finally {
        await handle.close();
      }
    } finally {
      this.reading = false;
    }
  }
}
