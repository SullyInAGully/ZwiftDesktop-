import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

const MAX_BYTES = 2_000_000;

/** Where a rider can find the log to send for support. */
export function defaultLogFile(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === "darwin") return join(home, "Library", "Logs", "CyclingOS Zwift Link", "monitor.log");
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "CyclingOS Zwift Link", "monitor.log");
  return join(home, ".local", "state", "cyclingos-zwift-link", "monitor.log");
}

/**
 * Copies console.log / console.error to a log file as well as the terminal. The once-a-second status line
 * is written straight to stdout, so it never floods the file. The file restarts when it passes 2 MB.
 * Never throws: a read-only disk must not stop the monitor.
 */
export function startLogFile(path = defaultLogFile()) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    let size = 0;
    try { size = statSync(path).size; } catch {}
    if (size > MAX_BYTES) writeFileSync(path, "");
    const write = (level, args) => {
      try {
        const text = args.map(arg => typeof arg === "string" ? arg : arg?.stack ?? JSON.stringify(arg)).join(" ");
        appendFileSync(path, `${new Date().toISOString()} ${level} ${text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")}\n`);
      } catch {}
    };
    for (const [level, method] of [["INFO", "log"], ["ERROR", "error"]]) {
      const original = console[method].bind(console);
      console[method] = (...args) => { write(level, args); original(...args); };
    }
    write("INFO", [`--- monitor started (${process.platform} ${process.arch}, node ${process.version}) ---`]);
    process.on("uncaughtException", error => { write("ERROR", [error]); throw error; });
    return path;
  } catch {
    return null;
  }
}
