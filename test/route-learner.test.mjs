import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { RouteLearner } from "../src/route-learner.mjs";
import { RouteProfileCatalogue, checkRouteRecording, saveRouteToCatalogue } from "../src/route-profile.mjs";

// A 3 km loop with one 30 m climb over the first half and a 500 m lead-in.
const ROUTE = { routeId: 1234, routeName: "Test Loop", plannedDistanceM: 3000, leadInDistanceM: 500, plannedElevationGainM: 30 };
const altitudeAt = position => 10 + 30 * (1 - Math.cos((2 * Math.PI * position) / ROUTE.plannedDistanceM)) / 2;

/** Rows as the monitor produces them, every `stepM` of event distance from `fromM` to `toM`. */
function ride({ fromM = 0, toM, stepM = 8, skip = null, route = ROUTE }) {
  const rows = [];
  for (let eventDistanceM = fromM; eventDistanceM <= toM; eventDistanceM += stepM) {
    if (skip && eventDistanceM > skip[0] && eventDistanceM < skip[1]) continue;
    const after = Math.max(0, eventDistanceM - route.leadInDistanceM);
    rows.push({
      routeId: route.routeId,
      routeName: route.routeName,
      plannedDistanceM: route.plannedDistanceM,
      plannedElevationGainM: route.plannedElevationGainM,
      leadInDistanceM: route.leadInDistanceM,
      eventDistanceM,
      routeDistanceM: after % route.plannedDistanceM,
      altitudeM: altitudeAt(after % route.plannedDistanceM)
    });
  }
  return rows;
}

function learnAll(rows, known = new Set()) {
  const learner = new RouteLearner({ isKnown: id => known.has(String(id)) });
  const learned = rows.map(row => learner.observe(row)).filter(Boolean);
  return { learner, learned };
}

test("a full lap from the start line is learned once, at the finish", () => {
  const { learned } = learnAll(ride({ toM: 500 + 3000 + 200 }));
  assert.equal(learned.length, 1);
  const [route] = learned;
  assert.equal(route.routeId, "1234");
  assert.equal(route.routeName, "Test Loop");
  assert.equal(route.points[0][0], 0);
  assert.equal(route.points.at(-1)[0], 3000);
  const summit = route.points.find(([d]) => d === 1500)[1];
  assert.ok(Math.abs(summit - 40) < 0.5, `summit ${summit}`);
});

test("riding only to the finish, without starting another lap, still counts", () => {
  assert.equal(learnAll(ride({ toM: 500 + 3000 - 5 })).learned.length, 1);
});

test("a lap joined partway round is not learned, but the next full lap is", () => {
  const { learner, learned } = learnAll(ride({ fromM: 500 + 1200, toM: 500 + 3000 + 3000 + 100 }));
  assert.equal(learned.length, 1);
  assert.equal(learner.lastResult.added, true);
  const first = learnAll(ride({ fromM: 500 + 1200, toM: 500 + 3000 + 50 }));
  assert.equal(first.learned.length, 0);
  assert.match(first.learner.lastResult.problems.join(), /starts 1200 m into the route/);
});

test("a dropout mid-lap is rejected", () => {
  const { learner, learned } = learnAll(ride({ toM: 500 + 3000 + 50, skip: [500 + 1000, 500 + 1300] }));
  assert.equal(learned.length, 0);
  assert.match(learner.lastResult.problems.join(), /m stretch has no samples/);
});

test("climbing that disagrees with Zwift's figure is rejected", () => {
  const wrong = { ...ROUTE, plannedElevationGainM: 120 };
  const { learner, learned } = learnAll(ride({ toM: 500 + 3000 + 50, route: wrong }));
  assert.equal(learned.length, 0);
  assert.match(learner.lastResult.problems.join(), /climbing 30 m does not match Zwift's 120 m/);
});

test("stopping partway, the lead-in alone, and catalogued routes are never learned", () => {
  assert.equal(learnAll(ride({ toM: 500 + 2000 })).learned.length, 0);
  assert.equal(learnAll(ride({ toM: 480 })).learned.length, 0);
  assert.equal(learnAll(ride({ toM: 500 + 3000 + 50 }), new Set(["1234"])).learned.length, 0);
});

test("rows without the Zwift log's route data are ignored", () => {
  const rows = ride({ toM: 500 + 3000 + 50 }).map(row => ({ ...row, plannedDistanceM: null, leadInDistanceM: null }));
  assert.equal(learnAll(rows).learned.length, 0);
});

test("a learned route saves into a catalogue the climb engine can load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "route-cat-"));
  try {
    const path = join(dir, "catalog.json");
    await writeFile(path, JSON.stringify({ schemaVersion: 1, catalogueVersion: "3", routes: [] }));
    const [route] = learnAll(ride({ toM: 500 + 3000 + 50 })).learned;
    await saveRouteToCatalogue(path, route);
    const catalogue = await RouteProfileCatalogue.load(path);
    assert.equal(catalogue.version, "4");
    const enriched = catalogue.enrich({ routeId: 1234, routeDistanceM: 300, gradientPct: 3 });
    assert.equal(enriched.onClimb, false);
    assert.ok(enriched.distanceToNextClimbM >= 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checkRouteRecording reports coverage and the largest hole", () => {
  const samples = [0, 25, 50, 400, 425].map(d => ({ distanceM: d, altitudeM: 0 }));
  const result = checkRouteRecording(samples, { plannedDistanceM: 450, plannedElevationGainM: null });
  assert.equal(result.complete, false);
  assert.equal(result.maxGapM, 350);
});

test("route:add refuses a recording without a complete lap and accepts a full one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "route-add-"));
  const run = promisify(execFile);
  const columns = ["routeId", "routeName", "plannedDistanceM", "plannedElevationGainM", "routeDistanceM", "altitudeM"];
  const csv = rows => [columns.join(","), ...rows.map(r => columns.map(c => r[c] ?? "").join(","))].join("\n");
  try {
    const catalogue = join(dir, "catalog.json");
    const partial = join(dir, "partial.csv");
    await writeFile(partial, csv(ride({ toM: 500 + 2000 })));
    await assert.rejects(run(process.execPath, ["tools/build-route-profile.mjs", partial, catalogue]), /No complete lap/);

    const full = join(dir, "full.csv");
    await writeFile(full, csv(ride({ toM: 500 + 3000 + 600 })));
    await run(process.execPath, ["tools/build-route-profile.mjs", full, catalogue]);
    const saved = JSON.parse(await readFile(catalogue, "utf8"));
    assert.equal(saved.routes.length, 1);
    assert.equal(saved.routes[0].routeName, "Test Loop");
    assert.ok(Math.abs(saved.routes[0].points.find(([d]) => d === 0)[1] - 10) < 0.01, "lead-in rows must not distort the start");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
