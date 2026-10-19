import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { bleHelperCommand } from "../src/ble-peripheral.mjs";
import { defaultLogPath } from "../src/route-log.mjs";

test("BLE helper is chosen per platform", () => {
  assert.deepEqual(bleHelperCommand("/repo", "darwin"), { command: "sh", args: [join("/repo", "mac-ble", "run-helper.sh")] });
  const win = bleHelperCommand("/repo", "win32");
  assert.equal(win.command, process.execPath);
  assert.deepEqual(win.args, [join("/repo", "win-ble", "run-helper.mjs")]);
  assert.equal(bleHelperCommand("/repo", "linux"), null);
});

test("Zwift log path falls back to a OneDrive-redirected Documents folder", () => {
  const home = join("/users", "rider");
  const oneDrive = join(home, "OneDrive");
  const zwiftUnderOneDrive = path => path === join(oneDrive, "Documents", "Zwift");
  assert.equal(defaultLogPath({ OneDrive: oneDrive }, home, zwiftUnderOneDrive),
    join(oneDrive, "Documents", "Zwift", "Logs", "Log.txt"));
  assert.equal(defaultLogPath({}, home, () => false), join(home, "Documents", "Zwift", "Logs", "Log.txt"));
});

test("route log watcher waits for a log file that does not exist yet", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { RouteLogWatcher } = await import("../src/route-log.mjs");
  const dir = await mkdtemp(join(tmpdir(), "zwift-log-"));
  const watcher = new RouteLogWatcher(join(dir, "Log.txt"), 20);
  try {
    await watcher.start();
    assert.equal(watcher.state.routeName, null);
    await writeFile(join(dir, "Log.txt"), "[1:00:00] Setting Route:   Tempus Fugit\n");
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(watcher.state.routeName, "Tempus Fugit");
  } finally {
    watcher.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
