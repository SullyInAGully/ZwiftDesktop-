import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { startLocalServer } from "./local-server.mjs";
import { SauceClient, normalizeSauceState } from "./sauce-client.mjs";

const CSV_FIELDS = [
  "sampledAt", "sampledAtMs", "sourceUpdatedAtMs", "sourceAgeMs", "dataFresh",
  "athleteId", "worldTimeMs", "elapsedRideSec", "powerW", "heartRateBpm", "cadenceRpm",
  "speedKmh", "distanceM", "ascentM", "altitudeM", "gradientPct", "courseId", "routeId",
  "routeDistanceM", "routeEndM", "remainingDistanceM", "lap", "roadId", "roadTime",
  "latitude", "longitude"
];
const CSV_HEADER = CSV_FIELDS.map(x => x[0].toUpperCase() + x.slice(1));

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArgs(process.argv.slice(2));
const client = new SauceClient({ baseUrl: options.sauceUrl });
const sessionsDir = join(root, "sessions");
await mkdir(sessionsDir, { recursive: true });

let latest = { status: "waiting", sampledAt: new Date().toISOString() };
let session = null;
let stopping = false;
const server = await startLocalServer({
  host: options.host,
  port: options.port,
  getState: () => latest,
  onError: error => console.error(`Local API: ${error.message}`)
});

process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });

console.log(`Reading decrypted Zwift state from Sauce: ${options.sauceUrl}`);
console.log(`Publishing latest synchronized row: http://${options.host}:${options.port}/state`);
console.log("Sampling on exact 1-second boundaries. Press Ctrl-C to stop.\n");

while (!stopping) {
  await nextSecond();
  const sampledAtMs = Date.now();
  try {
    const data = await client.getWatchingState();
    const row = normalizeSauceState(data, sampledAtMs);
    if (!row || !row.dataFresh) {
      latest = {
        status: row ? "stale" : "waiting",
        sampledAt: new Date(sampledAtMs).toISOString(),
        sourceAgeMs: row?.sourceAgeMs ?? null
      };
      server.publish(latest);
      show(latest);
      continue;
    }

    if (!session) session = await openSession(row);
    latest = { status: "riding", ...row };
    await appendFile(session.jsonl, `${JSON.stringify(latest)}\n`);
    await appendFile(session.csv, `${csvRow(row)}\n`);
    server.publish(latest);
    show(latest);
  } catch (error) {
    latest = {
      status: "error",
      sampledAt: new Date(sampledAtMs).toISOString(),
      error: error.cause?.code === "ECONNREFUSED"
        ? `Sauce is not reachable at ${options.sauceUrl}`
        : error.message
    };
    server.publish(latest);
    show(latest);
  }
  if (options.once) break;
}

await server.close();
console.log(session ? `\nSaved ${session.csv}` : "\nNo active ride samples were recorded.");

async function openSession(row) {
  const stem = `sauce_zwift_${fileStamp(new Date())}`;
  const csv = join(sessionsDir, `${stem}.csv`);
  const jsonl = join(sessionsDir, `${stem}.jsonl`);
  await writeFile(csv, `${CSV_HEADER.join(",")}\n`);
  await writeFile(jsonl, "");
  console.log(`Ride detected for Zwift athlete ${row.athleteId}. Recording ${csv}`);
  return { csv, jsonl };
}

function show(row) {
  let line;
  if (row.status === "riding") {
    line = `${clock()} RIDING · ${display(row.powerW, "W")} · ${display(row.distanceM, "m")} · ` +
      `${display(row.ascentM, "m ↑")} · ${display(row.altitudeM, "m alt")} · ` +
      `${display(row.gradientPct, "%", 1)} · route ${display(row.routeDistanceM, "m")}`;
  } else if (row.status === "stale") {
    line = `${clock()} STALE · last Sauce update ${Math.round(row.sourceAgeMs)} ms ago`;
  } else if (row.status === "error") {
    line = `${clock()} ERROR · ${row.error}`;
  } else {
    line = `${clock()} Waiting for Sauce to watch an active Zwift rider…`;
  }
  if (process.stdout.isTTY) process.stdout.write(`\r\u001b[2K${line}`);
  else console.log(line);
}

function csvRow(row) {
  return CSV_FIELDS.map(field => csvValue(row[field])).join(",");
}

function csvValue(value) {
  if (value == null) return "";
  const text = String(value);
  return /[,"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function display(value, suffix, precision = 0) {
  return value == null ? `-- ${suffix}` : `${value.toFixed(precision)} ${suffix}`;
}

function nextSecond() {
  const delay = 1000 - (Date.now() % 1000);
  return new Promise(resolvePromise => setTimeout(resolvePromise, delay));
}

function parseArgs(args) {
  const values = {
    sauceUrl: "http://127.0.0.1:1080",
    port: 8765,
    host: "127.0.0.1",
    once: false
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--once") values.once = true;
    else if (arg === "--sauce-url") values.sauceUrl = args[++i];
    else if (arg === "--port") values.port = Number(args[++i]);
    else if (arg === "--host") values.host = args[++i];
    else if (arg === "--help") {
      console.log("Usage: npm run start:sauce -- [--sauce-url http://127.0.0.1:1080] [--port 8765] [--host 127.0.0.1] [--once]");
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
