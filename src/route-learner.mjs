import { LAP_END_TOLERANCE_M, buildRoutePoints, checkRouteRecording, PROFILE_STEP_M } from "./route-profile.mjs";

/**
 * Watches live ride rows and hands back one fully ridden lap of a route that is not yet in the
 * catalogue, so it can be added automatically. A lap only counts when it was ridden from the start
 * line (after the lead-in) to the finish without holes and its climbing matches Zwift's own figure;
 * see checkRouteRecording. Laps are tracked by Zwift's event distance, which never goes backwards.
 */
export class RouteLearner {
  constructor({ isKnown }) {
    this.isKnown = isKnown;
    this.lap = null;
    this.lastResult = null; // { routeId, routeName, added, problems, atMs }
  }

  /** Returns a catalogue route object when a lap of an unknown route has just been completed. */
  observe(row) {
    const plannedDistanceM = Number(row.plannedDistanceM);
    const leadInDistanceM = Number(row.leadInDistanceM);
    const eventDistanceM = Number(row.eventDistanceM);
    if (!(plannedDistanceM > 0) || !Number.isFinite(leadInDistanceM) || !Number.isFinite(eventDistanceM) ||
        !Number.isFinite(Number(row.altitudeM)) || row.routeId == null) {
      this.lap = null;
      return null;
    }
    if (this.isKnown(row.routeId)) {
      this.lap = null;
      return null;
    }
    const afterLeadInM = eventDistanceM - leadInDistanceM;
    if (afterLeadInM < 0) {
      this.lap = null; // still on the lead-in
      return null;
    }
    const lapIndex = Math.floor(afterLeadInM / plannedDistanceM);
    const positionM = afterLeadInM - lapIndex * plannedDistanceM;

    let finished = null;
    const sameRoute = this.lap && String(this.lap.routeId) === String(row.routeId) && this.lap.plannedDistanceM === plannedDistanceM;
    if (!sameRoute) {
      this.lap = null;
    } else if (lapIndex !== this.lap.lapIndex) {
      // Crossed the line: judge the lap that just ended (unless it was already accepted at the finish).
      if (lapIndex === this.lap.lapIndex + 1 && !this.lap.submitted) finished = this.lap;
      this.lap = null;
    }
    this.lap ??= {
      routeId: row.routeId,
      routeName: row.routeName ?? null,
      plannedDistanceM,
      plannedElevationGainM: finiteOrNull(row.plannedElevationGainM),
      lapIndex,
      samples: [],
      submitted: false
    };
    this.lap.routeName ??= row.routeName ?? null;
    this.lap.samples.push({ distanceM: positionM, altitudeM: Number(row.altitudeM) });

    if (finished) return this.judge(finished);
    // Reaching the finish is enough; riders often stop there instead of starting another lap.
    if (!this.lap.submitted && plannedDistanceM - positionM <= LAP_END_TOLERANCE_M / 2) {
      const route = this.judge(this.lap, { quiet: true });
      if (route) {
        this.lap.submitted = true;
        return route;
      }
    }
    return null;
  }

  /** Progress through the current lap of an unknown route, for the dashboard. */
  progress() {
    if (!this.lap) return null;
    const check = checkRouteRecording(this.lap.samples, this.lap);
    const fromStart = this.lap.samples.length > 0 && Math.min(...this.lap.samples.map(s => s.distanceM)) <= LAP_END_TOLERANCE_M;
    return {
      routeId: String(this.lap.routeId),
      routeName: this.lap.routeName,
      coveragePct: Math.round(check.coveragePct),
      fromStart
    };
  }

  judge(lap, { quiet = false } = {}) {
    const check = checkRouteRecording(lap.samples, lap);
    if (!check.complete) {
      if (!quiet) this.lastResult = { routeId: String(lap.routeId), routeName: lap.routeName, added: false, problems: check.problems, atMs: Date.now() };
      return null;
    }
    this.lastResult = { routeId: String(lap.routeId), routeName: lap.routeName, added: true, problems: [], atMs: Date.now() };
    return {
      routeId: String(lap.routeId),
      routeName: lap.routeName ?? `Route ${lap.routeId}`,
      plannedDistanceM: lap.plannedDistanceM,
      plannedElevationGainM: lap.plannedElevationGainM,
      sampleSpacingM: PROFILE_STEP_M,
      source: `learned automatically from a full lap on ${new Date().toISOString().slice(0, 10)}`,
      points: buildRoutePoints(lap.samples, lap.plannedDistanceM)
    };
  }
}

function finiteOrNull(value) {
  const number = Number(value);
  return value != null && Number.isFinite(number) ? number : null;
}
