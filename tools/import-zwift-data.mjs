// Builds routes/imported-zwift-data.json: an elevation profile for (almost) every Zwift route, from the
// MIT-licensed `zwift-data` package. Its route ids are the same hashes Zwift sends in PlayerState, so the
// monitor can match them directly. The profiles it carries were derived from Strava segment streams.
//
//   npm run catalog:import              write routes/imported-zwift-data.json and routes/import-report.json
//   npm run catalog:import -- --stats   only print the quality distribution
//
// Routes you record yourself (routes/catalog-v1.json, via `npm run route:add`) always take priority.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SAMPLE_SPACING_M = 25;
// A profile may differ from Zwift's route distance by this much (alignment drifts at most that far at the end).
export const LENGTH_TOLERANCE = 0.03;
const NOTE_LENGTH_DIFF = 0.01;

/** Strictly increasing (distance, altitude) pairs; the source repeats distances at standstills. */
export function cleanStream(distance, altitude) {
  const pairs = [];
  for (let i = 0; i < Math.min(distance.length, altitude.length); i += 1) {
    if (Number.isFinite(distance[i]) && Number.isFinite(altitude[i])) pairs.push([distance[i], altitude[i]]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  return pairs.filter((pair, i) => i === 0 || pair[0] > pairs[i - 1][0]);
}

function interpolate(pairs, x) {
  if (x <= pairs[0][0]) return pairs[0][1];
  const last = pairs[pairs.length - 1];
  if (x >= last[0]) return last[1];
  let lo = 0;
  let hi = pairs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pairs[mid][0] <= x) lo = mid; else hi = mid;
  }
  const [x0, y0] = pairs[lo];
  const [x1, y1] = pairs[hi];
  return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
}

/** Total climbing of the raw stream. Across Zwift's routes this matches the published figure to within 2%. */
export function rawAscent(pairs) {
  let ascent = 0;
  for (let i = 1; i < pairs.length; i += 1) ascent += Math.max(0, pairs[i][1] - pairs[i - 1][1]);
  return ascent;
}

/**
 * Converts one route to a catalogue entry, or says why it cannot be trusted.
 * @returns {{entry: object, flags: string[]} | {skip: string}}
 */
export function convertRoute(route, distance, altitude, version) {
  if (!Number.isFinite(route.id)) return { skip: "no Zwift route id" };
  if (!route.sports?.includes("cycling")) return { skip: "not a cycling route" };
  const pairs = cleanStream(distance ?? [], altitude ?? []);
  if (pairs.length < 10) return { skip: "no usable altitude profile" };

  const plannedM = route.distance * 1000;
  const streamM = pairs[pairs.length - 1][0];
  const flags = [];
  let trimM = 0;
  if (Math.abs(streamM / plannedM - 1) > LENGTH_TOLERANCE) {
    // Some streams include the lead-in before the lap; Zwift's route distance excludes it.
    const leadIns = [route.leadInDistance, route.leadInDistanceFreeRide, route.leadInDistanceMeetups]
      .filter(value => value > 0).map(value => value * 1000);
    const match = leadIns.find(leadIn => Math.abs(streamM / (plannedM + leadIn) - 1) <= LENGTH_TOLERANCE);
    if (match === undefined) {
      return { skip: `length mismatch: profile ${(streamM / 1000).toFixed(2)} km, Zwift ${(plannedM / 1000).toFixed(2)} km` };
    }
    trimM = match;
    flags.push(`lead-in of ${(match / 1000).toFixed(2)} km trimmed`);
  }
  const lengthRatio = (streamM - trimM) / plannedM;
  if (Math.abs(lengthRatio - 1) > NOTE_LENGTH_DIFF) {
    flags.push(`profile is ${((lengthRatio - 1) * 100).toFixed(1)}% ${lengthRatio < 1 ? "shorter" : "longer"} than Zwift's distance`);
  }

  const points = [];
  for (let d = 0; d < plannedM; d += SAMPLE_SPACING_M) {
    points.push([d, Math.round(interpolate(pairs, d + trimM) * 100) / 100]);
  }
  points.push([Math.round(plannedM * 1000) / 1000, Math.round(interpolate(pairs, plannedM + trimM) * 100) / 100]);

  const published = route.elevation ?? 0;
  const ascent = rawAscent(pairs.filter(pair => pair[0] >= trimM && pair[0] <= trimM + plannedM));
  if (published > 0 && Math.abs(ascent - published) > Math.max(6, 0.1 * published)) {
    return { skip: `climbing mismatch: profile ${ascent.toFixed(0)} m, Zwift ${published} m` };
  }

  return {
    flags,
    entry: {
      routeId: String(route.id),
      routeName: route.name,
      plannedDistanceM: plannedM,
      plannedElevationGainM: published,
      sampleSpacingM: SAMPLE_SPACING_M,
      source: version,
      points
    }
  };
}

async function main() {
  const statsOnly = process.argv.includes("--stats");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const [{ routes }, { routes: altitudes }, { routes: distances }, pkg] = await Promise.all([
    import("zwift-data"),
    import("zwift-data/streams/altitude"),
    import("zwift-data/streams/distance"),
    import("zwift-data/package.json", { with: { type: "json" } })
  ]);
  const version = `zwift-data-${pkg.default.version}`;

  const entries = [];
  const flagged = [];
  const skipped = [];
  for (const route of routes) {
    const result = convertRoute(route, distances[route.slug], altitudes[route.slug], version);
    if (result.skip) {
      skipped.push({ routeId: route.id ?? null, name: route.name, world: route.world, reason: result.skip });
    } else {
      entries.push(result.entry);
      if (result.flags.length) flagged.push({ routeId: route.id, name: route.name, notes: result.flags });
    }
  }

  const cyclingSkipped = skipped.filter(item => item.reason !== "not a cycling route");
  console.log(`${routes.length} routes in ${version}`);
  console.log(`  imported:                 ${entries.length}`);
  console.log(`  of those, with a note:    ${flagged.length}`);
  console.log(`  skipped, not cycling:     ${skipped.length - cyclingSkipped.length}`);
  console.log(`  skipped, cycling routes:  ${cyclingSkipped.length}`);
  const reasons = {};
  for (const item of cyclingSkipped) {
    const key = item.reason.split(":")[0];
    reasons[key] = (reasons[key] ?? 0) + 1;
  }
  for (const [reason, count] of Object.entries(reasons)) console.log(`    ${String(count).padStart(3)}  ${reason}`);
  if (statsOnly) return;

  const document = {
    schemaVersion: 1,
    catalogueVersion: version,
    generatedAt: new Date().toISOString(),
    routes: entries
  };
  const out = resolve(root, "routes", "imported-zwift-data.json");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(document)}\n`);
  await writeFile(resolve(root, "routes", "import-report.json"), `${JSON.stringify({ version, flagged, skipped: cyclingSkipped }, null, 2)}\n`);
  console.log(`Wrote ${out} (${entries.length} routes). See routes/import-report.json for what was skipped and why.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
