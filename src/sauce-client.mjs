export class SauceHttpError extends Error {
  constructor(status, message) {
    super(`Sauce API request failed (HTTP ${status})${message ? `: ${message}` : ""}`);
    this.name = "SauceHttpError";
    this.status = status;
  }
}

export class SauceClient {
  constructor({ baseUrl = "http://127.0.0.1:1080", fetchImpl = fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
  }

  async getWatchingState() {
    const response = await this.fetchImpl(
      `${this.baseUrl}/api/athlete/v2/watching?resource=state`,
      { signal: AbortSignal.timeout(1500) }
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new SauceHttpError(response.status, body.slice(0, 160));
    }
    return response.json();
  }

  async getRoute(routeId) {
    if (!Number.isFinite(Number(routeId))) return null;
    const response = await this.fetchImpl(
      `${this.baseUrl}/api/rpc/v1/getRoute/${encodeURIComponent(routeId)}`,
      { signal: AbortSignal.timeout(3000) }
    );
    if (!response.ok) return null;
    return response.json();
  }
}

export function normalizeSauceState(data, sampledAtMs = Date.now()) {
  const state = data?.state;
  if (!state) return null;

  const sourceAgeMs = finite(data.age);
  const routeDistanceM = finite(state.routeDistance);
  const routeEndM = finite(state.routeEnd);
  return {
    sampledAt: new Date(sampledAtMs).toISOString(),
    sampledAtMs,
    sourceUpdatedAtMs: finite(data.updated),
    sourceAgeMs,
    dataFresh: sourceAgeMs == null || sourceAgeMs <= 2500,
    athleteId: finite(data.athleteId),
    worldTimeMs: finite(state.worldTime),
    elapsedRideSec: finite(state.time),
    powerW: finite(state.power),
    heartRateBpm: finite(state.heartrate),
    cadenceRpm: finite(state.cadence),
    speedKmh: finite(state.speed),
    distanceM: finite(state.distance),
    ascentM: finite(state.climbing),
    altitudeM: finite(state.altitude),
    gradientPct: multiply(finite(state.grade), 100),
    courseId: finite(state.courseId),
    routeId: finite(state.routeId),
    routeDistanceM,
    routeEndM,
    remainingDistanceM: routeDistanceM == null || routeEndM == null
      ? null
      : Math.max(0, routeEndM - routeDistanceM),
    lap: finite(state.laps),
    roadId: finite(state.roadId),
    roadTime: finite(state.roadTime),
    latitude: arrayNumber(state.latlng, 0),
    longitude: arrayNumber(state.latlng, 1)
  };
}

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function multiply(value, factor) {
  return value == null ? null : value * factor;
}

function arrayNumber(value, index) {
  return Array.isArray(value) ? finite(value[index]) : null;
}
