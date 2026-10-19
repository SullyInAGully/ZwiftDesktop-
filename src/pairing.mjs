import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

// No 0/O, 1/I/L or U/V: the code is read off a screen and typed on a phone.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTWXYZ";
const CODE_LENGTH = 8;
export const AUTH_SCHEME = "CyclingOS";
const NONCE_TTL_MS = 30_000;
const MAX_OUTSTANDING_NONCES = 64;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 60_000;
const LOCKOUT_MS = 60_000;

/** A fresh pairing code: 8 characters from a 29-symbol alphabet (about 39 bits). */
export function generatePairingCode() {
  return Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
}

/** What a rider types is forgiving (case, spaces, dashes); what is hashed is not. */
export function normalizePairingCode(input) {
  return String(input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function formatPairingCode(code) {
  const normalized = normalizePairingCode(code);
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

export function isValidPairingCode(input) {
  const code = normalizePairingCode(input);
  return code.length === CODE_LENGTH && [...code].every(char => ALPHABET.includes(char));
}

/** The proof a phone sends: HMAC-SHA256 keyed with the code over the single-use nonce, as lowercase hex. */
export function pairingProof(code, nonce) {
  return createHmac("sha256", normalizePairingCode(code)).update(nonce).digest("hex");
}

/**
 * Challenge/response check for the Wi-Fi stream. The code itself never crosses the network (the stream is
 * plain HTTP on the LAN): the phone fetches a single-use nonce, then proves it knows the code. A captured
 * proof cannot be replayed because each nonce is consumed on first use, and repeated wrong proofs lock the
 * sender out for a minute.
 *
 * Header: `Authorization: CyclingOS <nonce>:<hex proof>`
 */
export class PairingGuard {
  constructor({ code, required = true, now = () => Date.now() } = {}) {
    this.code = normalizePairingCode(code);
    this.required = required;
    this.now = now;
    this.nonces = new Map();
    this.failures = new Map();
  }

  configure({ code, required }) {
    if (code !== undefined) this.code = normalizePairingCode(code);
    if (required !== undefined) this.required = Boolean(required);
    this.nonces.clear();
    this.failures.clear();
  }

  issueChallenge() {
    this.pruneNonces();
    if (this.nonces.size >= MAX_OUTSTANDING_NONCES) return null;
    const nonce = randomBytes(16).toString("hex");
    this.nonces.set(nonce, this.now() + NONCE_TTL_MS);
    return { nonce, expiresInSec: NONCE_TTL_MS / 1000 };
  }

  /** @returns {{ok: true} | {ok: false, status: number, error: string, retryAfterSec?: number}} */
  check(authorization, remoteAddress) {
    if (!this.required) return { ok: true };
    const now = this.now();
    const record = this.failures.get(remoteAddress);
    if (record?.lockedUntil > now) {
      return { ok: false, status: 429, error: "too_many_attempts", retryAfterSec: Math.ceil((record.lockedUntil - now) / 1000) };
    }

    const match = /^CyclingOS ([0-9a-f]{32}):([0-9a-f]{64})$/.exec(String(authorization ?? "").trim());
    if (!match) return { ok: false, status: 401, error: "pairing_required" };
    const [, nonce, proof] = match;

    const expiry = this.nonces.get(nonce);
    this.nonces.delete(nonce); // single use, whether or not the proof is right
    if (expiry === undefined || expiry < now) return this.fail(remoteAddress, "stale_challenge");

    const expected = Buffer.from(pairingProof(this.code, nonce), "hex");
    const given = Buffer.from(proof, "hex");
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return this.fail(remoteAddress, "bad_proof");
    this.failures.delete(remoteAddress);
    return { ok: true };
  }

  fail(remoteAddress, error) {
    const now = this.now();
    const record = this.failures.get(remoteAddress);
    const recent = record && now - record.firstAt < FAILURE_WINDOW_MS ? record : { firstAt: now, count: 0 };
    recent.count += 1;
    if (recent.count >= MAX_FAILURES) recent.lockedUntil = now + LOCKOUT_MS;
    this.failures.set(remoteAddress, recent);
    return { ok: false, status: 401, error };
  }

  pruneNonces() {
    const now = this.now();
    for (const [nonce, expiry] of this.nonces) if (expiry < now) this.nonces.delete(nonce);
  }
}
