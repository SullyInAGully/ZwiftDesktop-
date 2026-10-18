import test from "node:test";
import assert from "node:assert/strict";
import { GradientEstimator } from "../src/gradient.mjs";
import { createRouteState, parseRouteLine } from "../src/route-log.mjs";
import { normalizePlayerState } from "../src/zwift-client.mjs";

test("route log parser extracts exact Zwift route plan", () => {
  const state = createRouteState();
  parseRouteLine(state, "INFO [Route] RouteComputer route-set routeHash=2698009951 worldId=1 route=  The Classic");
  parseRouteLine(state, "INFO [Route] Route stats: 483608.687500cm long with 517.246155cm leadin and 4844.839844cm ascent");
  parseRouteLine(state, '[Route] Hit checkpoint 13 out of 50 on route: "  The Classic"');
  assert.equal(state.routeName, "The Classic");
  assert.equal(state.routeHash, 2698009951);
  assert.equal(state.worldId, 1);
  assert.equal(state.plannedDistanceM, 4836.086875);
  assert.equal(state.leadInDistanceM, 5.17246155);
  assert.equal(state.plannedAscentM, 48.44839844);
  assert.equal(state.checkpoint, 13);
  assert.equal(state.checkpointCount, 50);
});

test("PlayerState conversion uses Zwift wire units", () => {
  const state = normalizePlayerState({
    worldTime: 1234,
    time: 30,
    power: 200,
    cadenceUHz: 1_500_000,
    heartrate: 140,
    speed: 30_000_000,
    distance: 250,
    altitude: 9065.6168,
    climbing: 12,
    calories: 3,
    laps: 0,
    progress: 10,
    roadTime: 20,
    x: 1,
    y: 2,
    heading: 3,
    sport: 0
  }, new Date("2026-10-18T12:00:00Z"));
  assert.equal(state.powerW, 200);
  assert.equal(state.cadenceRpm, 90);
  assert.equal(state.speedKmh, 30);
  assert.equal(state.distanceM, 250);
  assert.equal(state.altitudeM, 10);
  assert.equal(state.ascentM, 12);
});

test("gradient is smoothed over distance and resets on a new ride", () => {
  const estimator = new GradientEstimator(8, 8);
  assert.equal(estimator.update(0, 100, 0), null);
  assert.equal(estimator.update(5, 100.25, 1000), null);
  assert.equal(estimator.update(10, 100.5, 2000), 5);
  assert.equal(estimator.update(0, 50, 3000), null);
});
