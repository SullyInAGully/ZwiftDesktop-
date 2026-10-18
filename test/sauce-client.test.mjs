import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSauceState, SauceClient } from "../src/sauce-client.mjs";

test("normalizes Sauce PlayerState into synchronized SI telemetry", () => {
  const row = normalizeSauceState({
    age: 211,
    updated: 123456,
    athleteId: 1234567,
    state: {
      worldTime: 999000,
      time: 75,
      power: 301,
      heartrate: 171,
      cadence: 94,
      speed: 42.5,
      distance: 5000,
      climbing: 123,
      altitude: 88.4,
      grade: 0.061,
      courseId: 1,
      routeId: 7,
      routeDistance: 1200,
      routeEnd: 4800,
      laps: 0,
      roadId: 12,
      roadTime: 345678,
      latlng: [51.5, -0.1]
    }
  }, 1_700_000_000_000);

  assert.equal(row.dataFresh, true);
  assert.equal(row.powerW, 301);
  assert.equal(row.distanceM, 5000);
  assert.equal(row.ascentM, 123);
  assert.equal(row.gradientPct, 6.1);
  assert.equal(row.remainingDistanceM, 3600);
});

test("marks an old Sauce state stale", () => {
  const row = normalizeSauceState({ age: 3000, state: { distance: 10 } });
  assert.equal(row.dataFresh, false);
});

test("requests only the watched rider state", async () => {
  let requested;
  const client = new SauceClient({
    fetchImpl: async url => {
      requested = url;
      return new Response(JSON.stringify({ state: { power: 200 } }), { status: 200 });
    }
  });
  const data = await client.getWatchingState();
  assert.match(requested, /\/api\/athlete\/v2\/watching\?resource=state$/);
  assert.equal(data.state.power, 200);
});
