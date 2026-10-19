import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const KEYCHAIN_SERVICE = "CyclingOS Zwift Live Prototype";
export const CONFIG_PATH = join(homedir(), ".config", "cyclingos-zwift-live", "config.json");
const DPAPI_PATH = join(dirname(CONFIG_PATH), "password.dpapi");

/** Where the password lives: the macOS Keychain, or a DPAPI blob only this Windows user can decrypt. */
export const CREDENTIAL_STORE = process.platform === "win32" ? "Windows (DPAPI, this user only)" : "macOS Keychain";

export async function saveCredentials(username, password) {
  const normalized = username.trim();
  if (!normalized || !password) throw new Error("Username and password are required");

  await mkdir(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_PATH, `${JSON.stringify({ username: normalized }, null, 2)}\n`, { mode: 0o600 });
  await chmod(CONFIG_PATH, 0o600);
  if (process.platform === "win32") {
    await writeFile(DPAPI_PATH, `${await dpapi("Protect", Buffer.from(password, "utf8").toString("base64"))}\n`, { mode: 0o600 });
    return;
  }
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
    throw new Error("Credentials are not configured. Enter your Zwift login in the dashboard.");
  }
  if (!config.username) throw new Error("Credential configuration has no username");

  try {
    let password;
    if (process.platform === "win32") {
      const blob = (await readFile(DPAPI_PATH, "utf8")).trim();
      password = Buffer.from(await dpapi("Unprotect", blob), "base64").toString("utf8");
    } else {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", config.username, "-w"
      ]);
      password = stdout.replace(/[\r\n]+$/, "");
    }
    if (!password) throw new Error("empty password");
    return { username: config.username, password };
  } catch {
    throw new Error(`Password not found in ${CREDENTIAL_STORE}. Enter your Zwift login in the dashboard.`);
  }
}

export const SETTINGS_PATH = join(homedir(), ".config", "cyclingos-zwift-live", "settings.json");
// Wi-Fi is the phone link on macOS and Windows; the BLE peripheral is kept as an opt-in legacy transport.
const DEFAULT_SETTINGS = { advertiseIp: null, wifiEnabled: true, bleEnabled: false, autoConnect: true, requirePairing: true, pairingCode: null };

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
    wifiEnabled: settings.wifiEnabled !== false,
    bleEnabled: settings.bleEnabled === true,
    requirePairing: settings.requirePairing !== false,
    pairingCode: settings.pairingCode || null,
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
  if (process.platform === "win32") {
    await rm(DPAPI_PATH, { force: true });
  } else if (username) {
    await execFileAsync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", username]).catch(() => {});
  }
  await writeFile(CONFIG_PATH, "{}\n", { mode: 0o600 }).catch(() => {});
}

/**
 * Windows DPAPI (CurrentUser scope) via the built-in PowerShell. Base64 in and out keeps the
 * secret off the command line and independent of the console code page.
 */
function dpapi(method, base64) {
  const script = "Add-Type -AssemblyName System.Security; " +
    "$in = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); " +
    `$out = [Security.Cryptography.ProtectedData]::${method}($in, $null, 'CurrentUser'); ` +
    "[Console]::Out.Write([Convert]::ToBase64String($out))";
  return new Promise((resolve, reject) => {
    const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
    child.stdin.end(base64);
  });
}
