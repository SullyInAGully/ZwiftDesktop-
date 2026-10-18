import { appendFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { GradientEstimator } from "./gradient.mjs";
import { loadCredentials } from "./keychain.mjs";
import { startLocalServer } from "./local-server.mjs";
import { DEFAULT_LOG_PATH, RouteLogWatcher } from "./route-log.mjs";
import { normalizePlayerState, ZwiftClient, ZwiftHttpError } from "./zwift-client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const options = parseArgs(process.argv.slice(2));
let credentials;
try {
  credentials = await loadCredentials();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const client = new ZwiftClient({
  ...credentials,
  protoPath: join(root, "proto", "player_state.proto")
});

console.log("Authenticating with Zwift Mobile Link…");
let profile;
try {
  profile = await client.initialize();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
console.log(`Authenticated as ${profile.name || `player ${profile.id}`}.`);

const routeWatcher = new RouteLogWatcher(options.logPath);
routeWatcher.on("error", error => console.error(`Route log: ${error.message}`));
routeWatcher.on("route", route => console.log(`\nRoute update: ${routeSummary(route)}`));
await routeWatcher.start();
console.log(`Watching route log: ${options.logPath}`);

let latest = {
  status: "waiting",
  sampledAt: new Date().toISOString(),
  route: { ...routeWatcher.state }
};
const localServer = await startLocalServer({
  host: options.host,
  port: options.port,
  getState: () => latest,
  onError: error => console.error(`Local API: ${error.message}`)
});
console.log(`Local state API: http://${options.host}:${options.port}/state`);
console.log(`Polling Zwift every ${options.intervalMs} ms. Press Ctrl-C to stop.\n`);

const sessionsDir = join(root, "sessions");
await mkdir(sessionsDir, { recursive: true });
const gradient = new GradientEstimator();
let sessionPath = null;
let missingCount = 0;
let currentPollDelayMs = options.intervalMs;
let stopping = false;

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

while (!stopping) {
  const tickStarted = Date.now();
  try {
    const raw = await client.getPlayerState(options.relayWorld);
    if (raw) {
      missingCount = 0;
      currentPollDelayMs = options.intervalMs;
      if (!sessionPath) {
        sessionPath = join(sessionsDir, `zwift_${fileStamp(new Date())}.jsonl`);
        gradient.reset();
        console.log(`Ride detected. Recording: ${sessionPath}`);
      }
      const telemetry = normalizePlayerState(raw);
      const gradePct = gradient.update(telemetry.distanceM, telemetry.altitudeM);
      const route = enrichRoute(routeWatcher.state, telemetry);
      latest = { status: "riding", ...telemetry, gradePct, route };
      await appendFile(sessionPath, `${JSON.stringify(latest)}\n`);
      localServer.publish(latest);
      showSample(latest);
    } else {
      missingCount += 1;
      if (missingCount === 3) {
        currentPollDelayMs = Math.max(30_000, options.intervalMs);
        console.log("\nActive state is unavailable from the private relay; reducing probes to every 30 seconds.");
      }
      if (sessionPath && missingCount >= 3) {
        const ended = { status: "ended", sampledAt: new Date().toISOString(), route: { ...routeWatcher.state } };
        await appendFile(sessionPath, `${JSON.stringify(ended)}\n`);
        console.log(`\nRide ended. Saved ${sessionPath}`);
        sessionPath = null;
        gradient.reset();
      }
      latest = { status: "waiting", sampledAt: new Date().toISOString(), route: { ...routeWatcher.state } };
      localServer.publish(latest);
      showWaiting();
    }
  } catch (error) {
    latest = { status: "error", sampledAt: new Date().toISOString(), error: error.message, route: { ...routeWatcher.state } };
    localServer.publish(latest);
    console.error(`\n${error.message}`);
    if (error instanceof ZwiftHttpError && error.status === 429) {
      const seconds = Number.isFinite(error.retryAfter) ? error.retryAfter : 30;
      console.error(`Rate limited by Zwift; pausing for ${seconds} seconds.`);
      await sleep(seconds * 1000);
    }
  }
  if (options.once) break;
  await sleep(Math.max(0, currentPollDelayMs - (Date.now() - tickStarted)));
}

await cleanup();

async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log("\nStopping…");
}

async function cleanup() {
  routeWatcher.stop();
  await localServer.close();
}

function enrichRoute(routeState, telemetry) {
  const route = { ...routeState };
  const leadIn = route.leadInDistanceM ?? 0;
  if (route.plannedDistanceM != null) {
    route.routeDistanceM = Math.max(0, telemetry.distanceM - leadIn);
    route.remainingDistanceM = Math.max(0, route.plannedDistanceM - route.routeDistanceM);
  }
  if (route.plannedAscentM != null) {
    route.remainingAscentM = Math.max(0, route.plannedAscentM - telemetry.ascentM);
  }
  return route;
}

function showSample(state) {
  const route = state.route.routeName ? ` · ${state.route.routeName}` : "";
  const remaining = state.route.remainingDistanceM == null ? "" : ` · ${(state.route.remainingDistanceM / 1000).toFixed(2)} km left`;
  const grade = state.gradePct == null ? "--" : state.gradePct.toFixed(1);
  const line = `${clock()} RIDING · ${state.powerW} W · ${(state.distanceM / 1000).toFixed(3)} km · ` +
    `${state.ascentM.toFixed(1)} m ↑ · ${state.altitudeM.toFixed(1)} m alt · ${grade}%${route}${remaining}`;
  writeStatus(line);
}

function showWaiting() {
  writeStatus(`${clock()} Waiting for an active Zwift ride…`);
}

function writeStatus(line) {
  if (process.stdout.isTTY) {
    process.stdout.write(`\r\u001b[2K${line}`);
  } else {
    console.log(line);
  }
}

function routeSummary(route) {
  const parts = [route.routeName];
  if (route.plannedDistanceM != null) parts.push(`${(route.plannedDistanceM / 1000).toFixed(2)} km`);
  if (route.plannedAscentM != null) parts.push(`${route.plannedAscentM.toFixed(1)} m ascent`);
  if (route.checkpoint != null) parts.push(`checkpoint ${route.checkpoint}/${route.checkpointCount}`);
  return parts.filter(Boolean).join(" · ") || "unknown";
}

function parseArgs(args) {
  const values = {
    intervalMs: 5000,
    relayWorld: 1,
    port: 8765,
    host: "127.0.0.1",
    logPath: DEFAULT_LOG_PATH,
    once: false
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--once") values.once = true;
    else if (arg === "--interval-ms") values.intervalMs = Number(args[++i]);
    else if (arg === "--relay-world") values.relayWorld = Number(args[++i]);
    else if (arg === "--port") values.port = Number(args[++i]);
    else if (arg === "--host") values.host = args[++i];
    else if (arg === "--log") values.logPath = resolve(args[++i]);
    else if (arg === "--help") {
      console.log("Usage: npm start -- [--interval-ms 5000] [--relay-world 1] [--port 8765] [--host 127.0.0.1] [--log PATH] [--once]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(values.intervalMs) || values.intervalMs < 3000) {
    throw new Error("--interval-ms must be at least 3000 to protect the Zwift service");
  }
  return values;
}

function fileStamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function clock() {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
