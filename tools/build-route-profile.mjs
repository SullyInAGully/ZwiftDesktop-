// Deliberately adds a route to the catalogue from a recorded session CSV. It uses the first lap that
// passes the completeness check (start line to finish, no holes, climbing matching Zwift) and refuses
// otherwise unless --force. The live bridge never writes to the catalogue itself.
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { PROFILE_STEP_M, buildRoutePoints, checkRouteRecording, saveRouteToCatalogue } from "../src/route-profile.mjs";

const args = process.argv.slice(2);
const force = args.includes("--force");
const [inputArg, outputArg = "routes/catalog-v1.json"] = args.filter(arg => arg !== "--force");
if (!inputArg) {
  console.error("Usage: npm run route:add -- SESSION.csv [routes/catalog-v1.json] [--force]");
  process.exit(1);
}

const input = resolve(inputArg);
const output = resolve(outputArg);
const lines = (await readFile(input, "utf8")).trim().split(/\r?\n/);
const header = lines.shift().split(",");
const column = name => {
  const value = header.indexOf(name);
  if (value < 0) throw new Error(`${basename(input)} has no ${name} column`);
  return value;
};
const at = { distance: column("routeDistanceM"), altitude: column("altitudeM"), routeId: column("routeId"),
  routeName: column("routeName"), planned: column("plannedDistanceM"), gain: column("plannedElevationGainM") };
const rows = lines.map(line => line.split(","));
const first = rows.find(row => row[at.routeId] && row[at.distance] && row[at.altitude] && Number(row[at.planned]) > 0);
if (!first) {
  console.error("No rows with a route position and altitude. Was the Zwift log being read during this ride?");
  process.exit(1);
}
const routeId = first[at.routeId];
const plannedDistanceM = Number(first[at.planned]);
const plannedElevationGainM = first[at.gain] === "" ? null : Number(first[at.gain]);

// Split into laps where the route position wraps back towards zero. The lead-in reports position 0 for
// every row, so only the last of a run of zeros is kept.
const laps = [];
let lap = [];
let previous = null;
for (const row of rows) {
  if (row[at.routeId] !== routeId || row[at.distance] === "" || row[at.altitude] === "") continue;
  const sample = { distanceM: Number(row[at.distance]), altitudeM: Number(row[at.altitude]) };
  if (previous && sample.distanceM < previous.distanceM - plannedDistanceM / 2) {
    laps.push(lap);
    lap = [];
  }
  if (sample.distanceM === 0 && lap.at(-1)?.distanceM === 0) lap.pop();
  lap.push(sample);
  previous = sample;
}
laps.push(lap);

const checks = laps.map(samples => ({ samples, check: checkRouteRecording(samples, { plannedDistanceM, plannedElevationGainM }) }));
let chosen = checks.find(x => x.check.complete);
if (!chosen) {
  console.error(`No complete lap of ${first[at.routeName] || routeId} in ${basename(input)}:`);
  checks.forEach(({ check }, i) => console.error(`  lap ${i + 1}: ${Math.round(check.coveragePct)}% covered; ${check.problems.join("; ")}`));
  if (!force) {
    console.error("Ride the full route and try again, or pass --force to add the best lap anyway.");
    process.exit(1);
  }
  chosen = checks.reduce((best, x) => x.check.coveragePct > best.check.coveragePct ? x : best);
  console.error("--force: adding the best lap anyway.");
}

const route = {
  routeId,
  routeName: first[at.routeName] || `Route ${routeId}`,
  plannedDistanceM,
  plannedElevationGainM,
  sampleSpacingM: PROFILE_STEP_M,
  source: `direct Companion recording (${basename(input)})`,
  points: buildRoutePoints(chosen.samples, plannedDistanceM)
};
const document = await saveRouteToCatalogue(output, route);
console.log(`Wrote ${route.points.length} points for ${route.routeName} (${route.routeId}) to ${output} (catalogue v${document.catalogueVersion}).`);
