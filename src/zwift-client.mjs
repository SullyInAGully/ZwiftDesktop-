import protobuf from "protobufjs";

const AUTH_URL = "https://secure.zwift.com/auth/realms/zwift/tokens/access/codes";
const BASE_URL = "https://us-or-rly101.zwift.com";
const CLIENT_ID = "Zwift_Mobile_Link";
const USER_AGENT = "CyclingOS-Zwift-Live-Prototype/0.1";

export class ZwiftHttpError extends Error {
  constructor(status, message, retryAfter = null) {
    super(message);
    this.name = "ZwiftHttpError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export class ZwiftClient {
  constructor({ username, password, protoPath }) {
    this.username = username;
    this.password = password;
    this.protoPath = protoPath;
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiresAt = 0;
    this.playerId = null;
    this.PlayerState = null;
  }

  async initialize() {
    const root = await protobuf.load(this.protoPath);
    this.PlayerState = root.lookupType("PlayerState");
    await this.authenticate();
    const profile = await this.requestJson(`${BASE_URL}/api/profiles/me`);
    this.playerId = profile.id;
    return { id: profile.id, name: [profile.firstName, profile.lastName].filter(Boolean).join(" ") };
  }

  async authenticate() {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: "password",
      username: this.username,
      password: this.password
    });
    const response = await fetch(AUTH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT
      },
      body,
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw await httpError(response, "Zwift authentication failed");
    const token = await response.json();
    this.accessToken = token.access_token;
    this.refreshToken = token.refresh_token;
    this.tokenExpiresAt = Date.now() + Math.max(1, token.expires_in - 60) * 1000;
  }

  async refreshAccessToken() {
    if (!this.refreshToken) return this.authenticate();
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: this.refreshToken
    });
    const response = await fetch(AUTH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT
      },
      body,
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) return this.authenticate();
    const token = await response.json();
    this.accessToken = token.access_token;
    this.refreshToken = token.refresh_token;
    this.tokenExpiresAt = Date.now() + Math.max(1, token.expires_in - 60) * 1000;
  }

  async ensureToken() {
    if (!this.accessToken || Date.now() >= this.tokenExpiresAt) await this.refreshAccessToken();
  }

  /** Returns null when the player is not currently visible in the relay world. */
  async getPlayerState(relayWorld = 1, retryAuth = true) {
    await this.ensureToken();
    const response = await fetch(`${BASE_URL}/relay/worlds/${relayWorld}/players/${this.playerId}`, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/x-protobuf-lite",
        "Accept-Encoding": "gzip",
        "User-Agent": USER_AGENT
      },
      signal: AbortSignal.timeout(10_000)
    });
    if (response.status === 404) return null;
    if (response.status === 401 && retryAuth) {
      await this.authenticate();
      return this.getPlayerState(relayWorld, false);
    }
    if (!response.ok) throw await httpError(response, "Zwift live-state request failed");
    const bytes = new Uint8Array(await response.arrayBuffer());
    return this.PlayerState.toObject(this.PlayerState.decode(bytes), { longs: Number, defaults: true });
  }

  async requestJson(url) {
    await this.ensureToken();
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT
      },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw await httpError(response, "Zwift request failed");
    return response.json();
  }

  async registerCompanionEndpoint(phoneAddress, port, retryAuth = true) {
    await this.ensureToken();
    const response = await fetch(`${BASE_URL}/relay/profiles/me/phone`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT
      },
      body: JSON.stringify({ phoneAddress, port, protocol: "TCP" }),
      signal: AbortSignal.timeout(10_000)
    });
    if (response.status === 401 && retryAuth) {
      await this.authenticate();
      return this.registerCompanionEndpoint(phoneAddress, port, false);
    }
    if (!response.ok) throw await httpError(response, "Zwift Companion registration failed");
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
}

async function httpError(response, prefix) {
  const retryAfter = response.headers.get("retry-after");
  return new ZwiftHttpError(
    response.status,
    `${prefix} (HTTP ${response.status})`,
    retryAfter ? Number(retryAfter) : null
  );
}

export function normalizePlayerState(raw, sampledAt = new Date()) {
  return {
    sampledAt: sampledAt.toISOString(),
    zwiftWorldTime: raw.worldTime,
    elapsedRideSec: raw.time,
    powerW: raw.power,
    cadenceRpm: Math.round((raw.cadenceUHz * 60) / 1_000_000),
    heartRateBpm: raw.heartrate || null,
    speedKmh: Math.round((raw.speed / 1_000_000) * 10) / 10,
    distanceM: raw.distance,
    altitudeM: Math.round((((raw.altitude - 9000) / 2) * 0.3048) * 10) / 10,
    ascentM: Math.round(raw.climbing * 10) / 10,
    calories: raw.calories,
    laps: raw.laps,
    routeProgressRaw: raw.progress,
    roadTimeRaw: raw.roadTime,
    positionX: raw.x,
    positionY: raw.y,
    headingRaw: raw.heading,
    sport: raw.sport
  };
}
