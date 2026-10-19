import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";
import { CompanionFrameDecoder, normalizeCompanionMessage } from "../src/companion-server.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

test("decodes length-prefixed Companion frames split across TCP chunks", async () => {
  const root = await protobuf.load(join(rootDir, "proto", "companion.proto"));
  const type = root.lookupType("GameToCompanion");
  const body = Buffer.from(type.encode(type.fromObject({
    athleteId: 42,
    grade: 7.5,
    playerState: { athleteId: 42, power: 250, distance: 1234 }
  })).finish());
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  const frame = Buffer.concat([header, body]);
  const decoder = new CompanionFrameDecoder(type);

  assert.equal(decoder.push(frame.subarray(0, 3)).length, 0);
  assert.equal(decoder.push(frame.subarray(3, 9)).length, 0);
  const output = decoder.push(frame.subarray(9));
  assert.equal(output.length, 1);
  assert.equal(output[0].playerState.power, 250);
});

test("normalizes direct Companion PlayerState units", () => {
  const row = normalizeCompanionMessage({
    athleteId: 42,
    grade: 0.075,
    playerState: {
      athleteId: 42,
      worldTime: 123,
      time: 60,
      power: 300,
      cadenceUHz: 1_500_000,
      speedUph: 35_500_000,
      distance: 5000,
      climbing: 125,
      z: 12345,
      courseId: 6,
      routeId: 99,
      eventDistanceCm: 543210
    }
  }, 1000);

  assert.equal(row.cadenceRpm, 90);
  assert.equal(row.speedKmh, 35.5);
  assert.equal(row.distanceM, 5000);
  assert.equal(row.ascentM, 125);
  assert.equal(row.altitudeM, 16.725);
  assert.equal(row.eventDistanceM, 5432.1);
});

test("a stopped rider is recorded as zeros, not gaps, and no strap stays empty", () => {
  // Protobuf leaves out zero-valued fields, so a coasting rider's message has no power/speed/cadence/distance.
  const row = normalizeCompanionMessage({
    playerState: { athleteId: 42, worldTime: 123, z: 12345, courseId: 6, routeId: 99, eventDistanceCm: 130 }
  }, 1000);

  assert.equal(row.powerW, 0);
  assert.equal(row.speedKmh, 0);
  assert.equal(row.cadenceRpm, 0);
  assert.equal(row.distanceM, 0);
  assert.equal(row.ascentM, 0);
  assert.equal(row.elapsedRideSec, 0);
  assert.equal(row.eventDistanceM, 1.3);
  assert.equal(row.heartRateBpm, null, "0 means no heart rate strap, not 0 bpm");
});
