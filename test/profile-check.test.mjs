import assert from "node:assert/strict";
import test from "node:test";
import { ProfileCheck } from "../src/profile-check.mjs";

// A rolling hill: the "expected" profile. Live altitude follows it, possibly shifted along the route.
const hill = distance => 20 * Math.sin(distance / 300);
function ride(check, { routeId = 1, seconds = 120, shiftM = 0, offsetM = 0, active = true }) {
  let last;
  for (let t = 0; t < seconds; t += 1) {
    const d = t * 9; // about 32 km/h
    last = check.update({ routeId, liveAltitudeM: hill(d + shiftM) + offsetM, expectedAltitudeM: hill(d), active });
  }
  return last;
}

test("a profile that follows Zwift's altitude is verified", () => {
  const check = new ProfileCheck();
  assert.equal(check.state.state, "unknown");
  assert.equal(ride(check, { seconds: 20 }).state, "checking");
  assert.equal(ride(check, { seconds: 120 }).state, "ok");
});

test("a constant altitude offset between sources is not a mismatch", () => {
  assert.equal(ride(new ProfileCheck(), { offsetM: 35 }).state, "ok");
});

test("a profile shifted along the route is caught, and stays caught", () => {
  const check = new ProfileCheck();
  const result = ride(check, { shiftM: 250 });
  assert.equal(result.state, "mismatch");
  assert.ok(result.rmsM > 3);
  assert.equal(ride(check, { seconds: 200 }).state, "mismatch", "no flicker back to ok on the same route");
});

test("samples while stopped or on the lead-in say nothing, and a new route starts fresh", () => {
  const check = new ProfileCheck();
  assert.equal(ride(check, { shiftM: 250, active: false }).state, "checking");
  assert.equal(ride(check, { shiftM: 250 }).state, "mismatch");
  assert.equal(ride(check, { routeId: 2 }).state, "ok", "a different route is judged on its own");
});
