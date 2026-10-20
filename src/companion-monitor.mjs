import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import process from "node:process";
import { spawn } from "node:child_process";
import { CompanionServer } from "./companion-server.mjs";
import { BlePeripheralBridge, bleHelperCommand, bleState } from "./ble-peripheral.mjs";
import { GradientEstimator } from "./gradient.mjs";
import {
  CREDENTIAL_STORE, clearCredentials, loadCredentials, loadSettings, saveCredentials, saveSettings, savedUsername
} from "./keychain.mjs";
import { startLanStream, LAN_DEFAULT_PORT } from "./lan-stream.mjs";
import { PairingGuard, formatPairingCode, generatePairingCode, isValidPairingCode } from "./pairing.mjs";
import { startLocalServer } from "./local-server.mjs";
import { DEFAULT_LOG_PATH, RouteLogWatcher } from "./route-log.mjs";
import { ZwiftClient } from "./zwift-client.mjs";
import { RouteProfileCatalogue } from "./route-profile.mjs";
import { RideSimulator } from "./simulator.mjs";
import { ProfileCheck } from "./profile-check.mjs";
import { startLogFile } from "./logfile.mjs";

const CSV_FIELDS = [
  "sampledAt", "sampledAtMs", "sourceAgeMs", "dataFresh", "athleteId", "worldTimeMs",
  "elapsedRideSec", "powerW", "heartRateBpm", "cadenceRpm", "speedKmh", "distanceM",
  "ascentM", "altitudeM", "gradientPct", "rawZ", "zwiftGrade", "courseId", "routeId", "routeCheckpointIndex",
  "routeDecisionIndex", "roadTime", "lap", "eventDistanceM", "x", "y", "portal",
  "routeName", "plannedDistanceM", "plannedElevationGainM", "routeDistanceM",
  "remainingDistanceM", "routeCheckpoint", "routeCheckpointCount",
  "terrain", "onClimb", "climbCategory", "distanceToNextClimbM", "distanceToSummitM",
  "remainingElevationGainM", "activeClimbIndex", "activeClimbLengthM",
  "activeClimbAvgGradientPct", "activeClimbGainM", "nextClimbLengthM",
  "nextClimbAvgGradientPct", "nextClimbGainM", "routeProfileVersion"
];

// Virtual adapters (Hyper-V/WSL, VPNs, VMs) are never the address the Zwift game can reach.
const VIRTUAL_INTERFACE = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Loopback|Tailscale|ZeroTier|utun|bridge|docker/i;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArgs(process.argv.slice(2));
const logPath = startLogFile();
const appVersion = await readVersion();
// Routes you recorded yourself come first and win; the generated catalogue (npm run catalog:import) fills in the rest.
const routeProfiles = await RouteProfileCatalogue.loadMany([
  options.routeCatalogue,
  ...(options.importedRoutes ? [join(root, "routes", "imported-zwift-data.json")] : [])
]);
console.log(`Route catalogue: ${routeProfiles.routes.size} routes (${JSON.stringify(routeProfiles.sourceCounts())})`);
const profileCheck = new ProfileCheck();
let settings = await loadSettings();
if (options.advertiseIp) settings.advertiseIp = options.advertiseIp;
if (options.ble === false) settings.bleEnabled = false;
if (options.wifi === false) settings.wifiEnabled = false;
if (!isValidPairingCode(settings.pairingCode)) settings = await saveSettings({ ...settings, pairingCode: generatePairingCode() });
const pairing = new PairingGuard({ code: settings.pairingCode, required: settings.requirePairing });

// Connection state. Everything below the dashboard is started and stopped from the UI.
let phase = "setup"; // setup | idle | connecting | running | error
let lastError = null;
let username = await savedUsername();
let connection = null; // { companion, routeWatcher, profile, address, advertiseIp }
let connectedAtMs = null;
let latestSource = null;
let latestPublished = { status: "waiting", sampledAt: new Date().toISOString() };
let session = null;
let simulator = null;
// "Stop everything" from the dashboard: nothing runs (no Zwift link, phone stream or Bluetooth) until Start again.
let stopped = false;
let stopping = false;
const gradient = new GradientEstimator(5, 5);
const startedAtMs = Date.now();
const sessionsDir = join(root, "sessions");
await mkdir(sessionsDir, { recursive: true });

const ble = new BlePeripheralBridge({
  helper: bleHelperCommand(root),
  enabled: settings.bleEnabled
});
ble.on("ready", () => console.log("Bluetooth state service: CyclingOS Zwift"));
ble.on("log", line => console.log(`Bluetooth: ${line}`));
ble.on("error", error => console.error(`Bluetooth: ${error.message}`));
ble.start();

// Wi-Fi link to the phone apps: the primary transport on macOS and Windows.
let lan = null;
let lanError = null;
async function startLan() {
  if (lan || !settings.wifiEnabled) return;
  try {
    lan = await startLanStream({
      port: options.lanPort,
      advertiseIp: lanIp(),
      guard: pairing,
      onError: error => { lanError = error.message; console.error(`Wi-Fi stream: ${error.message}`); }
    });
    lanError = null;
    console.log(`Wi-Fi stream: http://${lanIp() ?? "this-computer"}:${lan.port}/v1/stream (Bonjour “${lan.name}”)`);
  } catch (error) {
    lanError = error.code === "EADDRINUSE" ? `Port ${options.lanPort} is in use. Start with --lan-port <other>.` : error.message;
    console.error(`Wi-Fi stream: ${lanError}`);
  }
}
async function stopLan() {
  const current = lan;
  lan = null;
  await current?.close().catch(() => {});
}
function lanIp() {
  return settings.advertiseIp || selectLanIpv4();
}
await startLan();

const actions = {
  /** Disconnects Zwift, the phones and Bluetooth and ends any simulation or recording; the dashboard stays up. */
  async stopEverything() {
    stopped = true;
    simulator = null;
    session = null;
    latestPublished = { status: "waiting", sampledAt: new Date().toISOString() };
    await disconnect();
    await stopLan();
    await ble.close();
    phase = username ? "idle" : "setup";
    lastError = null;
    console.log("\nEverything stopped from the dashboard.");
  },
  async startAgain() {
    stopped = false;
    await startLan();
    if (settings.bleEnabled) ble.start();
    console.log("\nStarted again from the dashboard.");
    if (username) await connect();
  },
  /** Shows the log file in Finder / Explorer so a rider can send it for support. */
  async revealLog() {
    if (!logPath) throw new Error("No log file is available.");
    const [command, args] = process.platform === "win32" ? ["explorer", [`/select,${logPath}`]]
      : process.platform === "darwin" ? ["open", ["-R", logPath]] : ["xdg-open", [dirname(logPath)]];
    spawn(command, args, { stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
  },
  /** Ends the whole program; the main loop notices within a second and shuts down cleanly. */
  async quit() {
    console.log("\nQuit requested from the dashboard.");
    stopping = true;
  },
  async simulate({ enabled, routeId }) {
    if (stopped && enabled) throw new Error("Everything is stopped. Press Start again first.");
    if (enabled && routeId != null && !routeProfiles.routes.has(String(routeId))) throw new Error(`Route ${routeId} is not in the catalogue.`);
    simulator = enabled ? new RideSimulator(routeProfiles, { routeId: routeId ?? null }) : null;
    session = null;
    latestPublished = { status: "waiting", sampledAt: new Date().toISOString() };
  },
  async saveCredentials({ username: name, password }) {
    await saveCredentials(String(name ?? ""), String(password ?? ""));
    username = await savedUsername();
    if (phase === "setup") phase = "idle";
    await connect();
  },
  async forgetCredentials() {
    await disconnect();
    await clearCredentials();
    username = null;
    phase = "setup";
    lastError = null;
  },
  async connect() { await connect(); },
  async disconnect() { await disconnect(); phase = username ? "idle" : "setup"; },
  async regeneratePairingCode() {
    settings = await saveSettings({ ...settings, pairingCode: generatePairingCode() });
    await lan?.setPairing({ code: settings.pairingCode, required: settings.requirePairing });
    if (!lan) pairing.configure({ code: settings.pairingCode, required: settings.requirePairing });
  },
  async saveSettings(body) {
    const next = {
      ...settings,
      ...(body.advertiseIp !== undefined ? { advertiseIp: validIp(body.advertiseIp) } : {}),
      ...(body.bleEnabled !== undefined ? { bleEnabled: Boolean(body.bleEnabled) } : {}),
      ...(body.wifiEnabled !== undefined ? { wifiEnabled: Boolean(body.wifiEnabled) } : {}),
      ...(body.requirePairing !== undefined ? { requirePairing: Boolean(body.requirePairing) } : {}),
      ...(body.autoConnect !== undefined ? { autoConnect: Boolean(body.autoConnect) } : {})
    };
    const addressChanged = next.advertiseIp !== settings.advertiseIp;
    const pairingWasRequired = settings.requirePairing;
    settings = await saveSettings(next);
    ble.enabled = settings.bleEnabled;
    if (settings.bleEnabled && !stopped) ble.start(); else await ble.close();
    if (settings.wifiEnabled && !stopped) await startLan(); else await stopLan();
    await lan?.setAdvertiseIp(lanIp());
    if (settings.requirePairing !== pairingWasRequired) {
      await lan?.setPairing({ required: settings.requirePairing });
      if (!lan) pairing.configure({ required: settings.requirePairing });
    }
    // The Zwift game only learns the receiver address at registration, so re-register on change.
    if (addressChanged && connection) await connect();
  }
};

let api;
try {
  api = await startLocalServer({
    host: options.apiHost,
    port: options.apiPort,
    getState: () => latestPublished,
    getStatus,
    actions,
    onError: error => console.error(`Local API: ${error.message}`)
  });
} catch (error) {
  await ble.close();
  await stopLan();
  throw new Error(`Cannot start local API on ${options.apiHost}:${options.apiPort}: ${error.message}`);
}

const dashboardUrl = `http://${options.apiHost}:${options.apiPort}/`;
console.log(`Dashboard: ${dashboardUrl}`);
if (options.open) openBrowser(dashboardUrl);

if (username) {
  phase = "idle";
  if (settings.autoConnect) connect().catch(() => {});
}

process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });

while (!stopping) {
  await nextSecond();
  const sampledAtMs = Date.now();
  const simulated = simulator ? simulator.next(sampledAtMs) : null;
  const source = simulated ?? (connection ? latestSource : null);
  const sourceAgeMs = source ? sampledAtMs - source.receivedAtMs : null;
  if (source && sourceAgeMs <= 2500) {
    const base = {
      status: "riding",
      sampledAt: new Date(sampledAtMs).toISOString(),
      sampledAtMs,
      sourceAgeMs,
      dataFresh: true,
      ...source
    };
    const located = simulated ? base : enrichRoute(base, connection.routeWatcher.state);
    // Cross-check the stored profile against the altitude Zwift reports; if they disagree, drop climb context.
    const expectedAltitudeM = routeProfiles.altitudeAt(located.routeId, located.routeDistanceM);
    const wasMismatch = profileCheck.state.state === "mismatch";
    profileCheck.update({
      routeId: located.routeId,
      liveAltitudeM: located.altitudeM,
      expectedAltitudeM,
      active: expectedAltitudeM != null && !located.onLeadIn && (located.speedKmh ?? 0) > 1
    });
    if (!wasMismatch && profileCheck.state.state === "mismatch") {
      console.warn(`Route profile for ${located.routeName ?? located.routeId} does not follow Zwift's altitude (RMS ${profileCheck.state.rmsM} m); climb data is switched off for this route.`);
    }
    const row = routeProfiles.enrich(located, { trusted: profileCheck.state.state !== "mismatch" });
    if (!session) session = await openSession(row);
    latestPublished = row;
    await appendFile(session.csv, `${csvRow(row)}\n`);
    api.publish(row);
    const frame = bleState(row);
    ble.publish(frame);
    lan?.publishFrame(frame);
    show(row);
  } else {
    latestPublished = {
      status: connection?.companion.socket ? "stale" : "waiting",
      sampledAt: new Date(sampledAtMs).toISOString(),
      sourceAgeMs,
      dataFresh: false
    };
    api.publish(latestPublished);
    lan?.publishStatus({ status: latestPublished.status, sampledAtMs, sourceAgeMs });
    show(latestPublished);
  }
  if (options.once && session) stopping = true;
}

// disconnect() clears the session, so remember the last recording for the closing message.
const lastSession = session;
await disconnect();
await api.close();
await ble.close();
await stopLan();
console.log(lastSession ? `\nSaved ${lastSession.csv}` : "\nNo live PlayerState rows were recorded.");

async function connect() {
  if (phase === "connecting" || stopped) return;
  await disconnect();
  phase = "connecting";
  lastError = null;
  let companion = null;
  let routeWatcher = null;
  try {
    const advertiseIp = settings.advertiseIp || selectLanIpv4();
    if (!advertiseIp) throw new Error("No LAN IPv4 address found. Pick one in Settings.");
    const credentials = await loadCredentials();
    const zwift = new ZwiftClient({ ...credentials, protoPath: join(root, "proto", "player_state.proto") });
    console.log("Authenticating once to register the local Companion receiver…");
    const profile = await zwift.initialize();

    companion = new CompanionServer({
      protoPath: join(root, "proto", "companion.proto"),
      athleteId: profile.id,
      host: options.listenHost,
      port: options.listenPort
    });
    const address = await companion.start();
    routeWatcher = new RouteLogWatcher(options.logPath);
    routeWatcher.on("error", error => console.error(`\nRoute log: ${error.message}`));
    await routeWatcher.start();

    companion.on("connected", ({ remoteAddress }) => {
      connectedAtMs = Date.now();
      console.log(`\nZwift game connected locally from ${remoteAddress}.`);
    });
    companion.on("disconnected", () => {
      connectedAtMs = null;
      console.log("\nZwift game disconnected; waiting for reconnection…");
    });
    companion.on("socketError", error => console.error(`\nCompanion socket: ${error.message}`));
    companion.on("error", error => console.error(`\nCompanion receiver: ${error.message}`));
    companion.on("playerState", state => {
      const gradientPct = state.altitudeM == null ? null : gradient.update(
        state.eventDistanceM ?? state.distanceM,
        state.altitudeM,
        state.receivedAtMs
      );
      latestSource = { ...state, gradientPct };
      if (session) appendFile(session.raw, `${JSON.stringify(latestSource)}\n`).catch(reportWriteError);
    });

    console.log(`Registering ${advertiseIp}:${address.port} with Zwift…`);
    await zwift.registerCompanionEndpoint(advertiseIp, address.port);
    connection = { companion, routeWatcher, profile, address, advertiseIp };
    phase = "running";
    console.log("Registered. If Zwift does not connect, restart the Zwift game once.");
  } catch (error) {
    await companion?.close().catch(() => {});
    routeWatcher?.stop();
    phase = "error";
    lastError = friendlyError(error);
    console.error(`Connect failed: ${error.message}`);
  }
}

async function disconnect() {
  const current = connection;
  connection = null;
  connectedAtMs = null;
  latestSource = null;
  session = null;
  if (!current) return;
  current.routeWatcher.stop();
  await current.companion.close().catch(() => {});
}

/** True when Zwift wrote to its log in the last 30 s, i.e. the game is most likely running. */
function zwiftLogRecent() {
  try {
    return Date.now() - statSync(options.logPath).mtimeMs < 30_000;
  } catch {
    return false;
  }
}

async function readVersion() {
  try {
    return (await readFile(join(root, "VERSION"), "utf8")).trim() || "dev";
  } catch {
    return "dev";
  }
}

function friendlyError(error) {
  if (error?.status === 401 || error?.status === 403 || error?.code === "invalid_grant") {
    return "Zwift rejected the email or password. If you sign in to Zwift with Google, Apple or Facebook, set a Zwift password first at zwift.com.";
  }
  if (error?.status === 429) return "Zwift is rate limiting logins. Wait a few minutes and try again.";
  if (error?.name === "TimeoutError" || error?.cause?.code === "ENOTFOUND") return "Could not reach Zwift. Check your internet connection.";
  return error?.message || String(error);
}

function validIp(value) {
  if (value == null || value === "") return null;
  const ok = /^(\d{1,3})(\.\d{1,3}){3}$/.test(value) && value.split(".").every(n => Number(n) <= 255);
  if (!ok) throw new Error("That is not a valid IPv4 address.");
  return value;
}

function lanInterfaces() {
  return Object.entries(networkInterfaces()).flatMap(([name, list]) =>
    (list ?? []).filter(x => x.family === "IPv4" && !x.internal && !x.address.startsWith("169.254."))
      .map(x => ({ name, address: x.address })));
}

function getStatus() {
  const live = latestPublished;
  const riding = live.status === "riding";
  return {
    startedAtMs,
    now: Date.now(),
    version: appVersion,
    logPath,
    zwiftLogRecent: zwiftLogRecent(),
    platform: process.platform,
    credentialStore: CREDENTIAL_STORE,
    phase,
    stopped,
    simulating: Boolean(simulator),
    error: lastError,
    username,
    settings,
    interfaces: lanInterfaces(),
    advertiseIp: connection?.advertiseIp ?? null,
    companionPort: connection?.address.port ?? null,
    athleteName: connection?.profile.name || null,
    zwiftConnected: Boolean(connection?.companion.socket),
    zwiftConnectedAtMs: connectedAtMs,
    rideStatus: live.status,
    dataFresh: Boolean(live.dataFresh),
    routeCatalogueVersion: routeProfiles.version,
    catalogueCount: routeProfiles.routes.size,
    catalogueSources: routeProfiles.sourceCounts(),
    profileCheck: profileCheck.state,
    routeName: live.routeName ?? null,
    routeKnown: riding ? routeProfiles.routes.has(String(live.routeId)) : null,
    // The position along the route comes from Zwift's Log.txt; without it climb fields stay empty.
    routePositionKnown: riding ? Number.isFinite(live.routeDistanceM) : null,
    routeLogPath: options.logPath,
    bleEnabled: settings.bleEnabled,
    bleReady: ble.ready,
    blePhones: ble.subscribers,
    bleMessage: ble.lastMessage,
    wifiEnabled: settings.wifiEnabled,
    lanListening: Boolean(lan),
    lanAnnounced: Boolean(lan?.announced),
    lanName: lan?.name ?? null,
    lanUrl: lan ? `http://${lanIp() ?? "this-computer"}:${lan.port}` : null,
    lanPhones: lan?.clients ?? 0,
    pairingRequired: settings.requirePairing,
    pairingCode: formatPairingCode(settings.pairingCode),
    lanError,
    sessionCsv: session ? session.csv : null,
    live: riding ? live : null
  };
}

async function openSession(row) {
  const stem = `${simulator ? "simulated" : "companion_zwift"}_${fileStamp(new Date())}`;
  const csv = join(sessionsDir, `${stem}.csv`);
  const raw = join(sessionsDir, `${stem}_raw.jsonl`);
  await writeFile(csv, `${CSV_FIELDS.join(",")}\n`);
  await writeFile(raw, `${JSON.stringify(simulator ? row : latestSource)}\n`);
  console.log(`\nRide detected for athlete ${row.athleteId}. Recording ${csv}`);
  return { csv, raw };
}

function show(row) {
  let line;
  if (row.status === "riding") {
    line = `${clock()} DIRECT · ${display(row.powerW, "W")} · ${display(row.distanceM, "m")} · ` +
      `${display(row.ascentM, "m ↑")} · ${display(row.altitudeM, "m alt", 1)} · ` +
      `grade ${display(row.gradientPct, "%", 1)} · ` +
      `source age ${row.sourceAgeMs} ms`;
  } else if (row.status === "stale") {
    line = `${clock()} TCP connected, but PlayerState is stale (${row.sourceAgeMs ?? "--"} ms)`;
  } else {
    line = `${clock()} Waiting for Zwift game connection…`;
  }
  if (process.stdout.isTTY) process.stdout.write(`\r\u001b[2K${line}`);
  else process.stdout.write(`${line}\n`);
}

function openBrowser(url) {
  const [command, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(command, args, { stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
}

function selectLanIpv4() {
  const all = networkInterfaces();
  const preferred = ["en0", "en1", "Wi-Fi", "WLAN", "Ethernet"];
  const physical = Object.keys(all).filter(name => !VIRTUAL_INTERFACE.test(name));
  for (const name of [...preferred, ...physical, ...Object.keys(all)]) {
    const candidate = all[name]?.find(x => x.family === "IPv4" && !x.internal && !x.address.startsWith("169.254."));
    if (candidate) return candidate.address;
  }
  return null;
}

function enrichRoute(row, route) {
  if (!route?.routeHash || Number(route.routeHash) !== Number(row.routeId)) return row;
  const plannedDistanceM = route.plannedDistanceM;
  const leadInDistanceM = route.leadInDistanceM ?? 0;
  let routeDistanceM = null;
  let remainingDistanceM = null;
  if (plannedDistanceM > 0 && row.eventDistanceM != null) {
    const afterLeadIn = Math.max(0, row.eventDistanceM - leadInDistanceM);
    routeDistanceM = afterLeadIn % plannedDistanceM;
    remainingDistanceM = Math.max(0, plannedDistanceM - routeDistanceM);
  }
  return {
    ...row,
    routeName: route.routeName,
    plannedDistanceM,
    plannedElevationGainM: route.plannedAscentM,
    leadInDistanceM: route.leadInDistanceM,
    routeDistanceM,
    remainingDistanceM,
    onLeadIn: leadInDistanceM > 0 && row.eventDistanceM != null && row.eventDistanceM < leadInDistanceM,
    routeCheckpoint: route.checkpoint,
    routeCheckpointCount: route.checkpointCount
  };
}

function nextSecond() {
  return new Promise(resolvePromise => setTimeout(resolvePromise, 1000 - (Date.now() % 1000)));
}

function csvRow(row) {
  return CSV_FIELDS.map(field => row[field] == null ? "" : String(row[field])).join(",");
}

function display(value, suffix, precision = 0) {
  return value == null ? `--${suffix}` : `${Number(value).toFixed(precision)}${suffix}`;
}

function reportWriteError(error) {
  console.error(`Raw stream write failed: ${error.message}`);
}

function parseArgs(args) {
  const values = {
    listenHost: "0.0.0.0",
    listenPort: 0,
    advertiseIp: null,
    apiHost: "127.0.0.1",
    apiPort: 8787,
    logPath: DEFAULT_LOG_PATH,
    routeCatalogue: join(root, "routes", "catalog-v1.json"),
    importedRoutes: true,
    lanPort: LAN_DEFAULT_PORT,
    ble: true,
    wifi: true,
    open: true,
    once: false
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--listen-host") values.listenHost = args[++i];
    else if (arg === "--listen-port") values.listenPort = Number(args[++i]);
    else if (arg === "--advertise-ip") values.advertiseIp = args[++i];
    else if (arg === "--api-host") values.apiHost = args[++i];
    else if (arg === "--api-port") values.apiPort = Number(args[++i]);
    else if (arg === "--log") values.logPath = resolve(args[++i]);
    else if (arg === "--route-catalogue") { values.routeCatalogue = resolve(args[++i]); values.importedRoutes = false; }
    else if (arg === "--lan-port") values.lanPort = Number(args[++i]);
    else if (arg === "--no-ble") values.ble = false;
    else if (arg === "--no-wifi") values.wifi = false;
    else if (arg === "--no-open") values.open = false;
    else if (arg === "--once") values.once = true;
    else if (arg === "--help") {
      console.log("Usage: npm start -- [--advertise-ip IP] [--listen-port PORT] [--api-port 8787] [--lan-port 8788] [--route-catalogue PATH] [--no-wifi] [--no-ble] [--no-open] [--once]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return values;
}

function fileStamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function clock() {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}
