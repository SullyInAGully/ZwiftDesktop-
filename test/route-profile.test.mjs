import test from "node:test";
import assert from "node:assert/strict";
import { RouteProfileCatalogue } from "../src/route-profile.mjs";
import { bleState } from "../src/ble-peripheral.mjs";

const catalogue = new RouteProfileCatalogue({
  schemaVersion: 1,
  catalogueVersion: "test-1",
  routes: [{
    routeId: "99",
    routeName: "Test climb",
    plannedDistanceM: 1000,
    plannedElevationGainM: 80,
    points: Array.from({ length: 21 }, (_, i) => {
      const distance = i * 50;
      const altitude = distance < 200 ? 100 : distance <= 800 ? 100 + (distance - 200) * 0.1 : 160;
      return [distance, altitude];
    })
  }]
});

test("route catalogue produces the complete climb context", () => {
  const before = catalogue.enrich({ routeId: 99, routeDistanceM: 100, gradientPct: 0 });
  assert.equal(before.onClimb, false);
  assert.ok(before.distanceToNextClimbM > 0);
  assert.ok(before.nextClimbGainM > 50 && before.nextClimbGainM <= 60);
  assert.equal(before.routeProfileVersion, "test-1");

  const active = catalogue.enrich({ routeId: 99, routeDistanceM: 500, gradientPct: 10 });
  assert.equal(active.terrain, "ASCENDING");
  assert.equal(active.onClimb, true);
  assert.equal(active.activeClimbIndex, 0);
  assert.ok(active.distanceToSummitM > 0);
  assert.ok(active.remainingElevationGainM > 0);
});

test("unknown routes are explicit and never fabricate climb context", () => {
  const state = catalogue.enrich({ routeId: 404, routeDistanceM: 100, gradientPct: -3 });
  assert.equal(state.terrain, "DESCENDING");
  assert.equal(state.onClimb, null);
  assert.equal(state.activeClimbIndex, null);
  assert.equal(state.routeProfileVersion, null);
});

test("BLE projection excludes athlete/account identifiers", () => {
  const state = bleState({ athleteId: 123, sampledAtMs: 1, powerW: 250, routeName: "Test" });
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.powerW, 250);
  assert.equal(state.routeName, "Test");
  assert.equal("athleteId" in state, false);
});

test("simulated ride follows the catalogued route and produces climb fields", async () => {
  const { RideSimulator } = await import("../src/simulator.mjs");
  const catalogue = await RouteProfileCatalogue.load(new URL("../routes/catalog-v1.json", import.meta.url).pathname);
  const sim = new RideSimulator(catalogue);
  let row;
  for (let t = 0; t < 120; t += 1) row = catalogue.enrich({ ...sim.next(1000 + t * 1000), status: "riding" });
  assert.match(row.routeName, /simulated/);
  assert.equal(row.athleteId, "simulated");
  assert.ok(row.distanceM > 900 && row.ascentM > 5);
  assert.equal(typeof row.onClimb, "boolean");
  assert.ok(row.routeProfileVersion);
});
