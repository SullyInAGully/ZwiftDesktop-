import { readFile, rename, writeFile } from "node:fs/promises";
import process from "node:process";

const SECTION_UP_PCT = 1.5;
const SECTION_DOWN_PCT = -1.5;
const CLIMB_START_PCT = 2;
const CLIMB_END_PCT = 0.5;
const MIN_CLIMB_GAIN_M = 30;
const MIN_CLIMB_LENGTH_M = 300;
const GRADIENT_WINDOW_M = 100;
const SMOOTH_WINDOW_M = 150;

/** One route's profile. The climb analysis is only computed the first time a route is actually ridden. */
class RouteProfile {
  constructor(route, version) {
    Object.assign(this, route);
    this.version = version;
    this.points = route.points.map(([distanceM, altitudeM]) => ({ distanceM, altitudeM }));
  }

  get smoothed() {
    return this.cachedSmoothed ??= smoothAltitude(this.points, SMOOTH_WINDOW_M);
  }

  get climbs() {
    return this.cachedClimbs ??= detectClimbs(this.smoothed);
  }

  get remainingGain() {
    return this.cachedRemainingGain ??= remainingGain(this.smoothed, this.plannedElevationGainM);
  }
}

/** Versioned Zwift route elevation profiles and deterministic climb context. */
export class RouteProfileCatalogue {
  /**
   * @param document one catalogue, or an array in priority order: when several describe the same route
   *   id, the first wins. Each route remembers which catalogue's version it came from.
   */
  constructor(document = { schemaVersion: 1, catalogueVersion: "empty", routes: [] }) {
    const documents = Array.isArray(document) ? document : [document];
    for (const doc of documents) {
      if (doc.schemaVersion !== 1) throw new Error(`Unsupported route catalogue schema ${doc.schemaVersion}`);
    }
    this.version = documents.map(doc => doc.catalogueVersion).join("+") || "empty";
    this.routes = new Map();
    for (const doc of documents) {
      for (const route of doc.routes) {
        const id = String(route.routeId);
        if (!this.routes.has(id)) this.routes.set(id, new RouteProfile(route, doc.catalogueVersion));
      }
    }
  }

  static async load(path) {
    return new RouteProfileCatalogue(JSON.parse(await readFile(path, "utf8")));
  }

  /** Loads catalogues in priority order. The first must exist; later ones (generated) may be missing. */
  static async loadMany(paths) {
    const documents = [];
    for (const [index, path] of paths.entries()) {
      try {
        documents.push(JSON.parse(await readFile(path, "utf8")));
      } catch (error) {
        if (index === 0 || error.code !== "ENOENT") throw error;
      }
    }
    return new RouteProfileCatalogue(documents);
  }

  /** How many routes each source catalogue contributed, e.g. { "1": 1, "zwift-data-2.1.0": 285 }. */
  sourceCounts() {
    const counts = {};
    for (const route of this.routes.values()) counts[route.version] = (counts[route.version] ?? 0) + 1;
    return counts;
  }

  /** Altitude the catalogue expects at a position along the route, or null if the route is unknown. */
  altitudeAt(routeId, distanceM) {
    const profile = this.routes.get(String(routeId));
    if (!profile || !Number.isFinite(distanceM)) return null;
    const points = profile.points;
    const d = clamp(distanceM, 0, points.at(-1).distanceM);
    let lo = 0;
    let hi = points.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (points[mid].distanceM <= d) lo = mid; else hi = mid;
    }
    const span = points[hi].distanceM - points[lo].distanceM;
    return span <= 0 ? points[lo].altitudeM : points[lo].altitudeM + ((points[hi].altitudeM - points[lo].altitudeM) * (d - points[lo].distanceM)) / span;
  }

  /** @param trusted false switches the climb context off (e.g. the profile disagrees with Zwift's altitude) */
  enrich(row, { trusted = true } = {}) {
    const profile = this.routes.get(String(row.routeId));
    const gradient = finite(row.gradientPct) ?? finite(row.zwiftGrade);
    const fallback = {
      terrain: sectionFor(gradient),
      onClimb: null,
      climbCategory: null,
      distanceToNextClimbM: null,
      distanceToSummitM: null,
      remainingElevationGainM: null,
      activeClimbIndex: null,
      activeClimbLengthM: null,
      activeClimbAvgGradientPct: null,
      activeClimbGainM: null,
      nextClimbLengthM: null,
      nextClimbAvgGradientPct: null,
      nextClimbGainM: null,
      routeProfileVersion: null
    };
    if (!profile || !trusted || !Number.isFinite(row.routeDistanceM)) return { ...row, ...fallback };

    const distanceM = clamp(row.routeDistanceM, 0, profile.plannedDistanceM);
    const profileGradient = gradientAt(profile.smoothed, distanceM, GRADIENT_WINDOW_M);
    const active = profile.climbs.find(c => distanceM >= c.startDistanceM && distanceM <= c.summitDistanceM) ?? null;
    const next = active ? null : profile.climbs.find(c => c.startDistanceM > distanceM) ?? null;

    return {
      ...row,
      terrain: sectionFor(profileGradient),
      // Use the live gradient in the normal field; the profile is deliberately smoothed for
      // terrain/climb boundaries and should not erase short ramps from PlayerState.
      onClimb: Boolean(active),
      climbCategory: active?.category ?? null,
      distanceToNextClimbM: next ? next.startDistanceM - distanceM : null,
      distanceToSummitM: active ? active.summitDistanceM - distanceM : null,
      remainingElevationGainM: interpolateScalar(profile.remainingGain, distanceM),
      activeClimbIndex: active?.index ?? null,
      activeClimbLengthM: active?.lengthM ?? null,
      activeClimbAvgGradientPct: active?.avgGradientPct ?? null,
      activeClimbGainM: active?.gainM ?? null,
      nextClimbLengthM: next?.lengthM ?? null,
      nextClimbAvgGradientPct: next?.avgGradientPct ?? null,
      nextClimbGainM: next?.gainM ?? null,
      routeProfileVersion: profile.version
    };
  }
}

export const PROFILE_STEP_M = 25;
/** The first and last sample of a lap must be this close to the route's start and end. */
export const LAP_END_TOLERANCE_M = 50;
/** Larger holes mean dropped samples; 1 Hz at 70 km/h is under 20 m apart. */
export const LAP_MAX_GAP_M = 100;
/** The profile's climbing must match Zwift's planned ascent within 15% or 10 m (The Classic: 48.1 vs 48.4 m). */
const GAIN_TOLERANCE_PCT = 15;
const GAIN_TOLERANCE_M = 10;

/** Resamples {distanceM, altitudeM} samples of one ridden lap into catalogue points every 25 m. */
export function buildRoutePoints(samples, plannedDistanceM, stepM = PROFILE_STEP_M) {
  const sorted = samples
    .filter(x => Number.isFinite(x.distanceM) && Number.isFinite(x.altitudeM))
    .sort((a, b) => a.distanceM - b.distanceM);
  const points = [];
  for (let distanceM = 0; distanceM <= plannedDistanceM; distanceM += stepM) {
    points.push([distanceM, round(interpolateAltitude(sorted, distanceM), 3)]);
  }
  if (points.at(-1)[0] !== plannedDistanceM) {
    points.push([plannedDistanceM, round(interpolateAltitude(sorted, plannedDistanceM), 3)]);
  }
  return points;
}

/**
 * Decides whether samples cover one whole lap of a route well enough to become its catalogue profile:
 * from the start line to the finish with no holes, and climbing that agrees with Zwift's own figure.
 */
export function checkRouteRecording(samples, { plannedDistanceM, plannedElevationGainM }) {
  const problems = [];
  const sorted = samples
    .filter(x => Number.isFinite(x.distanceM) && Number.isFinite(x.altitudeM))
    .sort((a, b) => a.distanceM - b.distanceM);
  if (!(plannedDistanceM > 0)) problems.push("the route length is unknown (Zwift log not read)");
  if (sorted.length < 2) problems.push("too few samples");
  if (problems.length) return { complete: false, problems, coveragePct: 0, maxGapM: null, gainM: null };

  const startGapM = sorted[0].distanceM;
  const endGapM = plannedDistanceM - sorted.at(-1).distanceM;
  let maxGapM = Math.max(startGapM, endGapM);
  let coveredM = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = sorted[i].distanceM - sorted[i - 1].distanceM;
    maxGapM = Math.max(maxGapM, gap);
    if (gap <= LAP_MAX_GAP_M) coveredM += gap;
  }
  const coveragePct = Math.min(100, (coveredM / plannedDistanceM) * 100);
  if (startGapM > LAP_END_TOLERANCE_M) problems.push(`recording starts ${Math.round(startGapM)} m into the route`);
  if (endGapM > LAP_END_TOLERANCE_M) problems.push(`recording stops ${Math.round(endGapM)} m before the finish`);
  if (maxGapM > LAP_MAX_GAP_M) problems.push(`a ${Math.round(maxGapM)} m stretch has no samples`);

  const points = buildRoutePoints(sorted, plannedDistanceM);
  let gainM = 0;
  for (let i = 1; i < points.length; i += 1) gainM += Math.max(0, points[i][1] - points[i - 1][1]);
  if (Number.isFinite(plannedElevationGainM)) {
    const allowed = Math.max(GAIN_TOLERANCE_M, (plannedElevationGainM * GAIN_TOLERANCE_PCT) / 100);
    if (Math.abs(gainM - plannedElevationGainM) > allowed) {
      problems.push(`climbing ${Math.round(gainM)} m does not match Zwift's ${Math.round(plannedElevationGainM)} m`);
    }
  }
  return { complete: problems.length === 0, problems, coveragePct, maxGapM, gainM };
}

/** Adds or replaces one route in the catalogue file, bumping its version; written atomically. */
export async function saveRouteToCatalogue(path, route) {
  let document = { schemaVersion: 1, catalogueVersion: "0", generatedAt: null, routes: [] };
  try { document = JSON.parse(await readFile(path, "utf8")); } catch {}
  document.generatedAt = new Date().toISOString();
  document.catalogueVersion = String((Number(document.catalogueVersion) || 0) + 1);
  document.routes = document.routes.filter(item => String(item.routeId) !== String(route.routeId));
  document.routes.push(route);
  document.routes.sort((a, b) => String(a.routeId).localeCompare(String(b.routeId)));
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`);
  await rename(temporary, path);
  return document;
}

function interpolateAltitude(values, distanceM) {
  const afterIndex = values.findIndex(x => x.distanceM >= distanceM);
  if (afterIndex < 0) return values.at(-1).altitudeM;
  if (afterIndex === 0) return values[0].altitudeM;
  const before = values[afterIndex - 1];
  const after = values[afterIndex];
  if (after.distanceM === before.distanceM) return after.altitudeM;
  const ratio = (distanceM - before.distanceM) / (after.distanceM - before.distanceM);
  return before.altitudeM + (after.altitudeM - before.altitudeM) * ratio;
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function detectClimbs(points) {
  if (points.length < 10) return [];
  const gradients = points.map((point, i) => i === 0 ? 0 : slope(points[i - 1], point));
  const climbs = [];
  let start = null;
  let peak = 0;

  const close = () => {
    if (start == null) return;
    const gainM = points[peak].altitudeM - points[start].altitudeM;
    const lengthM = points[peak].distanceM - points[start].distanceM;
    if (gainM >= MIN_CLIMB_GAIN_M && lengthM >= MIN_CLIMB_LENGTH_M) {
      climbs.push({
        index: climbs.length,
        startDistanceM: points[start].distanceM,
        summitDistanceM: points[peak].distanceM,
        lengthM,
        gainM,
        avgGradientPct: (gainM / lengthM) * 100,
        category: categorize(gainM, lengthM)
      });
    }
    start = null;
  };

  for (let i = 0; i < gradients.length; i += 1) {
    if (start == null && gradients[i] >= CLIMB_START_PCT) {
      start = i;
      peak = i;
    } else if (start != null && points[i].altitudeM >= points[peak].altitudeM) {
      peak = i;
    } else if (start != null && gradients[i] < CLIMB_END_PCT) {
      close();
    }
  }
  close();
  return climbs;
}

function remainingGain(points, plannedGainM) {
  const values = new Array(points.length);
  let gain = 0;
  values[points.length - 1] = { distanceM: points.at(-1).distanceM, value: 0 };
  for (let i = points.length - 2; i >= 0; i -= 1) {
    gain += Math.max(0, points[i + 1].altitudeM - points[i].altitudeM);
    values[i] = { distanceM: points[i].distanceM, value: gain };
  }
  const scale = gain > 0 && Number.isFinite(plannedGainM) ? plannedGainM / gain : 1;
  return values.map(x => ({ ...x, value: x.value * scale }));
}

function gradientAt(points, distanceM, windowM) {
  if (points.length < 2) return 0;
  const half = windowM / 2;
  const behind = nearestAtOrBefore(points, distanceM - half) ?? points[0];
  const ahead = nearestAtOrAfter(points, distanceM + half) ?? points.at(-1);
  return slope(behind, ahead);
}

function smoothAltitude(points, windowM) {
  const half = windowM / 2;
  const prefix = new Float64Array(points.length + 1);
  for (let i = 0; i < points.length; i += 1) prefix[i + 1] = prefix[i] + points[i].altitudeM;
  let lo = 0;
  let hi = 0;
  return points.map((point, i) => {
    while (points[lo].distanceM < point.distanceM - half) lo += 1;
    while (hi < points.length && points[hi].distanceM <= point.distanceM + half) hi += 1;
    return { ...point, altitudeM: (prefix[hi] - prefix[lo]) / (hi - lo) };
  });
}

function interpolateScalar(points, distanceM) {
  const before = nearestAtOrBefore(points, distanceM) ?? points[0];
  const after = nearestAtOrAfter(points, distanceM) ?? points.at(-1);
  if (after.distanceM === before.distanceM) return before.value;
  const ratio = (distanceM - before.distanceM) / (after.distanceM - before.distanceM);
  return before.value + (after.value - before.value) * ratio;
}

function nearestAtOrBefore(points, value) {
  for (let i = points.length - 1; i >= 0; i -= 1) if (points[i].distanceM <= value) return points[i];
  return null;
}

function nearestAtOrAfter(points, value) {
  return points.find(p => p.distanceM >= value) ?? null;
}

function slope(a, b) {
  const run = b.distanceM - a.distanceM;
  return run > 0 ? ((b.altitudeM - a.altitudeM) / run) * 100 : 0;
}

function sectionFor(gradient) {
  if (!Number.isFinite(gradient)) return null;
  if (gradient > SECTION_UP_PCT) return "ASCENDING";
  if (gradient < SECTION_DOWN_PCT) return "DESCENDING";
  return "LEVEL";
}

function categorize(gainM, lengthM) {
  const score = (gainM * gainM) / (lengthM / 10);
  if (score > 80_000) return "HC";
  if (score > 64_000) return "Cat 1";
  if (score > 48_000) return "Cat 2";
  if (score > 32_000) return "Cat 3";
  if (score > 16_000) return "Cat 4";
  return "Uncat";
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
