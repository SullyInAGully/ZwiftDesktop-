import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const KEYCHAIN_SERVICE = "CyclingOS Zwift Live Prototype";
export const CONFIG_PATH = join(homedir(), ".config", "cyclingos-zwift-live", "config.json");

export async function saveCredentials(username, password) {
  const normalized = username.trim();
  if (!normalized || !password) throw new Error("Username and password are required");

  await mkdir(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_PATH, `${JSON.stringify({ username: normalized }, null, 2)}\n`, { mode: 0o600 });
  await chmod(CONFIG_PATH, 0o600);
  await execFileAsync("security", [
    "add-generic-password", "-U",
    "-s", KEYCHAIN_SERVICE,
    "-a", normalized,
    "-w", password
  ]);
}

export async function loadCredentials() {
  let config;
  try {
    config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch {
    throw new Error("Credentials are not configured. Run: npm run credentials");
  }
  if (!config.username) throw new Error("Credential configuration has no username");

  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", config.username, "-w"
    ]);
    const password = stdout.replace(/[\r\n]+$/, "");
    if (!password) throw new Error("empty password");
    return { username: config.username, password };
  } catch {
    throw new Error("Password not found in macOS Keychain. Run: npm run credentials");
  }
}

export const SETTINGS_PATH = join(homedir(), ".config", "cyclingos-zwift-live", "settings.json");
const DEFAULT_SETTINGS = { advertiseIp: null, bleEnabled: true, autoConnect: true };

export async function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(await readFile(SETTINGS_PATH, "utf8")) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings) {
  const clean = {
    advertiseIp: settings.advertiseIp || null,
    bleEnabled: settings.bleEnabled !== false,
    autoConnect: settings.autoConnect !== false
  };
  await mkdir(dirname(SETTINGS_PATH), { recursive: true, mode: 0o700 });
  await writeFile(SETTINGS_PATH, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
  return clean;
}

/** Username of the saved account, or null. The password is never read here. */
export async function savedUsername() {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8")).username || null;
  } catch {
    return null;
  }
}

export async function clearCredentials() {
  const username = await savedUsername();
  if (username) {
    await execFileAsync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", username]).catch(() => {});
  }
  await writeFile(CONFIG_PATH, "{}\n", { mode: 0o600 }).catch(() => {});
}
