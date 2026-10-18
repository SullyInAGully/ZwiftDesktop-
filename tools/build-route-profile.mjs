import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const [inputArg, outputArg = "routes/catalog-v1.json"] = process.argv.slice(2);
if (!inputArg) {
  console.error("Usage: node tools/build-route-profile.mjs SESSION.csv [routes/catalog-v1.json]");
  process.exit(1);
}

const input = resolve(inputArg);
const output = resolve(outputArg);
const lines = (await readFile(input, "utf8")).trim().split(/\r?\n/);
const header = lines.shift().split(",");
const index = name => {
  const value = header.indexOf(name);
  if (value < 0) throw new Error(`${basename(input)} has no ${name} column`);
  return value;
};
const routeDistanceIndex = index("routeDistanceM");
const altitudeIndex = index("altitudeM");
const routeIdIndex = index("routeId");
const routeNameIndex = index("routeName");
const plannedDistanceIndex = index("plannedDistanceM");
const plannedGainIndex = index("plannedElevationGainM");
const rows = lines.map(line => line.split(","));
const first = rows.find(row => row[routeIdIndex] && row[routeDistanceIndex] && row[altitudeIndex]);
if (!first) throw new Error("No complete route-position/altitude rows found");

const samples = rows.map(row => ({
  distanceM: Number(row[routeDistanceIndex]),
  altitudeM: Number(row[altitudeIndex])
})).filter(x => Number.isFinite(x.distanceM) && Number.isFinite(x.altitudeM))
  .sort((a, b) => a.distanceM - b.distanceM);
const plannedDistanceM = Number(first[plannedDistanceIndex]);
const stepM = 25;
const points = [];
for (let distanceM = 0; distanceM <= plannedDistanceM; distanceM += stepM) {
  points.push([distanceM, round(interpolate(samples, distanceM), 3)]);
}
if (points.at(-1)[0] !== plannedDistanceM) {
  points.push([plannedDistanceM, round(interpolate(samples, plannedDistanceM), 3)]);
}

let document = { schemaVersion: 1, catalogueVersion: "1", generatedAt: new Date().toISOString(), routes: [] };
let existing = false;
try { document = JSON.parse(await readFile(output, "utf8")); existing = true; } catch {}
const route = {
  routeId: first[routeIdIndex],
  routeName: first[routeNameIndex],
  plannedDistanceM,
  plannedElevationGainM: Number(first[plannedGainIndex]),
  sampleSpacingM: stepM,
  source: `direct Companion recording (${basename(input)})`,
  points
};
document.generatedAt = new Date().toISOString();
if (existing) document.catalogueVersion = String((Number(document.catalogueVersion) || 0) + 1);
document.routes = document.routes.filter(item => String(item.routeId) !== String(route.routeId));
document.routes.push(route);
document.routes.sort((a, b) => String(a.routeId).localeCompare(String(b.routeId)));
await writeFile(output, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Wrote ${points.length} points for ${route.routeName} (${route.routeId}) to ${output}`);

function interpolate(values, distanceM) {
  const afterIndex = values.findIndex(x => x.distanceM >= distanceM);
  if (afterIndex <= 0) return values[Math.max(0, afterIndex)].altitudeM;
  if (afterIndex < 0) return values.at(-1).altitudeM;
  const before = values[afterIndex - 1];
  const after = values[afterIndex];
  if (after.distanceM === before.distanceM) return after.altitudeM;
  const ratio = (distanceM - before.distanceM) / (after.distanceM - before.distanceM);
  return before.altitudeM + (after.altitudeM - before.altitudeM) * ratio;
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
