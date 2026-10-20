import assert from "node:assert/strict";
import test from "node:test";
import { RouteProfileCatalogue } from "../src/route-profile.mjs";
import { cleanStream, convertRoute, rawAscent } from "../tools/import-zwift-data.mjs";

const ramp = (lengthM, gainM, stepM = 20) => {
  const distance = [];
  const altitude = [];
  for (let d = 0; d <= lengthM; d += stepM) { distance.push(d); altitude.push((gainM * d) / lengthM); }
  return { distance, altitude };
};
const route = (extra = {}) => ({ id: 1234, name: "Test Route", slug: "test-route", distance: 2, elevation: 20, sports: ["cycling"], ...extra });

test("converts a clean profile to 25 m samples ending exactly at Zwift's distance", () => {
  const { distance, altitude } = ramp(2000, 20);
  const { entry, flags } = convertRoute(route(), distance, altitude, "zwift-data-test");
  assert.equal(entry.routeId, "1234");
  assert.equal(entry.plannedDistanceM, 2000);
  assert.equal(entry.points[0][0], 0);
  assert.equal(entry.points[1][0], 25);
  assert.equal(entry.points.at(-1)[0], 2000);
  assert.ok(Math.abs(entry.points.at(-1)[1] - 20) < 0.01);
  assert.equal(entry.source, "zwift-data-test");
  assert.deepEqual(flags, []);
});

test("trims a lead-in that the profile includes but Zwift's route distance excludes", () => {
  // 1 km flat lead-in, then a 2 km ramp climbing 20 m: Zwift calls the route 2 km.
  const lead = ramp(1000, 0);
  const lap = ramp(2000, 20);
  const distance = [...lead.distance, ...lap.distance.slice(1).map(d => d + 1000)];
  const altitude = [...lead.altitude, ...lap.altitude.slice(1)];
  const { entry, flags } = convertRoute(route({ leadInDistance: 1 }), distance, altitude, "v");
  assert.ok(flags.some(flag => flag.includes("lead-in")));
  assert.equal(entry.points[0][1], 0);
  assert.ok(Math.abs(entry.points.at(-1)[1] - 20) < 0.01, "profile restarts at the lap, not the lead-in");
});

test("tolerates a small length difference but says so, and refuses a large one", () => {
  const near = ramp(1950, 20, 10); // 2.5% short
  const { entry, flags } = convertRoute(route(), near.distance, near.altitude, "v");
  assert.ok(entry);
  assert.ok(flags.some(flag => flag.includes("shorter")));
  const far = ramp(1500, 20);
  assert.match(convertRoute(route(), far.distance, far.altitude, "v").skip, /length mismatch/);
});

test("refuses a profile whose climbing disagrees with Zwift's published total", () => {
  const { distance, altitude } = ramp(2000, 60);
  assert.match(convertRoute(route({ elevation: 20 }), distance, altitude, "v").skip, /climbing mismatch/);
});

test("skips routes it cannot use", () => {
  const { distance, altitude } = ramp(2000, 20);
  assert.match(convertRoute(route({ id: undefined }), distance, altitude, "v").skip, /no Zwift route id/);
  assert.match(convertRoute(route({ sports: ["running"] }), distance, altitude, "v").skip, /not a cycling route/);
  assert.match(convertRoute(route(), undefined, undefined, "v").skip, /no usable altitude profile/);
});

test("cleans repeated and out-of-order distances", () => {
  const pairs = cleanStream([0, 10, 10, 5, 20, Number.NaN], [1, 2, 3, 9, 4, 5]);
  assert.deepEqual(pairs, [[0, 1], [5, 9], [10, 2], [20, 4]]);
  assert.equal(rawAscent([[0, 0], [1, 5], [2, 3], [3, 8]]), 10);
});

test("a catalogue you recorded wins over the generated one, and each route keeps its own version", () => {
  const recorded = { schemaVersion: 1, catalogueVersion: "recorded", routes: [
    { routeId: "1", routeName: "Mine", plannedDistanceM: 2000, plannedElevationGainM: 20, points: [[0, 0], [1000, 10], [2000, 20]] }
  ] };
  const generated = { schemaVersion: 1, catalogueVersion: "generated", routes: [
    { routeId: "1", routeName: "Theirs", plannedDistanceM: 2000, plannedElevationGainM: 99, points: [[0, 0], [2000, 99]] },
    { routeId: "2", routeName: "Other", plannedDistanceM: 2000, plannedElevationGainM: 20, points: [[0, 0], [2000, 20]] }
  ] };
  const catalogue = new RouteProfileCatalogue([recorded, generated]);
  assert.equal(catalogue.routes.size, 2);
  assert.equal(catalogue.routes.get("1").routeName, "Mine");
  assert.deepEqual(catalogue.sourceCounts(), { recorded: 1, generated: 1 });
  assert.equal(catalogue.enrich({ routeId: 2, routeDistanceM: 100, gradientPct: 1 }).routeProfileVersion, "generated");
  assert.ok(Math.abs(catalogue.altitudeAt(1, 500) - 5) < 1e-9);
  assert.equal(catalogue.altitudeAt(404, 500), null);
});

test("untrusted profiles give no climb context but keep the live terrain", () => {
  const doc = { schemaVersion: 1, catalogueVersion: "v", routes: [
    { routeId: "1", routeName: "R", plannedDistanceM: 4000, plannedElevationGainM: 100,
      points: Array.from({ length: 161 }, (_, i) => [i * 25, i * 25 * 0.025]) }
  ] };
  const catalogue = new RouteProfileCatalogue(doc);
  const trusted = catalogue.enrich({ routeId: 1, routeDistanceM: 1000, gradientPct: 2.5 });
  assert.equal(trusted.onClimb, true);
  const untrusted = catalogue.enrich({ routeId: 1, routeDistanceM: 1000, gradientPct: 2.5 }, { trusted: false });
  assert.equal(untrusted.onClimb, null);
  assert.equal(untrusted.routeProfileVersion, null);
  assert.equal(untrusted.terrain, "ASCENDING");
});
