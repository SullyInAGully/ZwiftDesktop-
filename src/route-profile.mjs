import { readFile } from "node:fs/promises";

const SECTION_UP_PCT = 1.5;
const SECTION_DOWN_PCT = -1.5;
const CLIMB_START_PCT = 2;
const CLIMB_END_PCT = 0.5;
const MIN_CLIMB_GAIN_M = 30;
const MIN_CLIMB_LENGTH_M = 300;
const GRADIENT_WINDOW_M = 100;
const SMOOTH_WINDOW_M = 150;

/** Versioned Zwift route elevation profiles and deterministic climb context. */
export class RouteProfileCatalogue {
  constructor(document = { schemaVersion: 1, catalogueVersion: "empty", routes: [] }) {
    if (document.schemaVersion !== 1) {
      throw new Error(`Unsupported route catalogue schema ${document.schemaVersion}`);
    }
    this.version = document.catalogueVersion;
    this.routes = new Map(document.routes.map(route => {
      const points = route.points.map(([distanceM, altitudeM]) => ({ distanceM, altitudeM }));
      const smoothed = smoothAltitude(points, SMOOTH_WINDOW_M);
      return [String(route.routeId), {
        ...route,
        points,
        smoothed,
        climbs: detectClimbs(smoothed),
        remainingGain: remainingGain(smoothed, route.plannedElevationGainM)
      }];
    }));
  }

  static async load(path) {
    return new RouteProfileCatalogue(JSON.parse(await readFile(path, "utf8")));
  }

  enrich(row) {
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
    if (!profile || !Number.isFinite(row.routeDistanceM)) return { ...row, ...fallback };

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
      routeProfileVersion: this.version
    };
  }
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
  return points.map(point => {
    const inWindow = points.filter(p => Math.abs(p.distanceM - point.distanceM) <= half);
    return { ...point, altitudeM: inWindow.reduce((sum, p) => sum + p.altitudeM, 0) / inWindow.length };
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
