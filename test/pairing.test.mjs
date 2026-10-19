import assert from "node:assert/strict";
import test from "node:test";
import {
  PairingGuard, formatPairingCode, generatePairingCode, isValidPairingCode, normalizePairingCode, pairingProof
} from "../src/pairing.mjs";
import { startLanStream } from "../src/lan-stream.mjs";

const CODE = "K7QP3MXD";
const header = (nonce, code = CODE) => `CyclingOS ${nonce}:${pairingProof(code, nonce)}`;

test("generated codes are valid, formatted for reading and tolerant to typing", () => {
  const code = generatePairingCode();
  assert.ok(isValidPairingCode(code));
  assert.match(formatPairingCode(code), /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(normalizePairingCode(" k7qp-3mxd "), CODE);
  assert.ok(!isValidPairingCode("K7QP3MX"), "too short");
  assert.ok(!isValidPairingCode("K7QP3MX0"), "ambiguous character");
  assert.notEqual(generatePairingCode(), generatePairingCode());
});

test("accepts a correct proof once and rejects its replay", () => {
  const guard = new PairingGuard({ code: CODE });
  const { nonce } = guard.issueChallenge();
  assert.deepEqual(guard.check(header(nonce), "10.0.0.5"), { ok: true });
  const replay = guard.check(header(nonce), "10.0.0.5");
  assert.equal(replay.ok, false);
  assert.equal(replay.error, "stale_challenge");
});

test("rejects a wrong code, a missing header and an expired challenge", () => {
  let now = 1_000;
  const guard = new PairingGuard({ code: CODE, now: () => now });
  const a = guard.issueChallenge().nonce;
  assert.equal(guard.check(header(a, "AAAAAAAA"), "10.0.0.5").error, "bad_proof");
  assert.equal(guard.check(undefined, "10.0.0.5").error, "pairing_required");
  assert.equal(guard.check("Bearer abc", "10.0.0.5").error, "pairing_required");
  const b = guard.issueChallenge().nonce;
  now += 31_000;
  assert.equal(guard.check(header(b), "10.0.0.5").error, "stale_challenge");
});

test("locks a sender out after repeated wrong proofs, then lets it back in", () => {
  let now = 0;
  const guard = new PairingGuard({ code: CODE, now: () => now });
  for (let i = 0; i < 5; i += 1) {
    const { nonce } = guard.issueChallenge();
    assert.equal(guard.check(header(nonce, "AAAAAAAA"), "10.0.0.9").status, 401);
  }
  const { nonce } = guard.issueChallenge();
  const locked = guard.check(header(nonce), "10.0.0.9");
  assert.equal(locked.status, 429, "even the right proof is refused while locked");
  assert.ok(locked.retryAfterSec > 0);
  assert.deepEqual(guard.check(header(guard.issueChallenge().nonce), "10.0.0.10"), { ok: true }, "other senders are unaffected");
  now += 61_000;
  assert.deepEqual(guard.check(header(guard.issueChallenge().nonce), "10.0.0.9"), { ok: true });
});

test("does nothing when pairing is not required, and caps outstanding challenges", () => {
  assert.deepEqual(new PairingGuard({ code: CODE, required: false }).check(undefined, "x"), { ok: true });
  const guard = new PairingGuard({ code: CODE });
  for (let i = 0; i < 64; i += 1) assert.ok(guard.issueChallenge());
  assert.equal(guard.issueChallenge(), null);
});

test("the Wi-Fi stream is closed to phones without the code", async () => {
  const guard = new PairingGuard({ code: CODE });
  const lan = await startLanStream({ host: "127.0.0.1", port: 0, announce: false, guard });
  const base = `http://127.0.0.1:${lan.port}`;
  try {
    assert.equal((await (await fetch(`${base}/v1/info`)).json()).pairingRequired, true);
    assert.equal((await fetch(`${base}/v1/stream`)).status, 401);
    assert.equal((await fetch(`${base}/v1/state`)).status, 401);
    assert.equal((await fetch(`${base}/v1/stream`, { headers: { Authorization: header("0".repeat(32)) } })).status, 401);

    const { nonce } = await (await fetch(`${base}/v1/challenge`)).json();
    const ok = await fetch(`${base}/v1/stream`, { headers: { Authorization: header(nonce) } });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("content-type"), /text\/event-stream/);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(lan.clients, 1, "only authenticated phones are counted");
    const replay = await fetch(`${base}/v1/state`, { headers: { Authorization: header(nonce) } });
    assert.equal(replay.status, 401, "a captured proof cannot be reused");

    await lan.setPairing({ code: "ABCD2345" });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(lan.clients, 0, "changing the code disconnects paired phones");
    const fresh = await (await fetch(`${base}/v1/challenge`)).json();
    assert.equal((await fetch(`${base}/v1/state`, { headers: { Authorization: header(fresh.nonce) } })).status, 401, "old code no longer works");
    const again = await (await fetch(`${base}/v1/challenge`)).json();
    assert.equal((await fetch(`${base}/v1/state`, { headers: { Authorization: header(again.nonce, "ABCD2345") } })).status, 200);
    await ok.body.cancel();
  } finally {
    await lan.close();
  }
});

test("matches the test vector published for phone developers", () => {
  assert.equal(
    pairingProof("k7qp-3mxd", "00112233445566778899aabbccddeeff"),
    "cfc77fd341d06d003cf6517ad8b95c2ee77faaae8e9c7f5cf470d5aa6d5fdbb4"
  );
});
