/**
 * A clearly labelled synthetic ride along a catalogued route, for testing the Mac → phone → CSV path
 * without Zwift or a trainer. It produces the same fields as a live PlayerState sample, so the real
 * climb engine, BLE link and exporter are all exercised.
 */
export class RideSimulator {
  constructor(catalogue, { routeId = null, powerW = 200, cadenceRpm = 90, heartRateBpm = 140, speedKmh = 30 } = {}) {
    const id = routeId ?? [...catalogue.routes.keys()][0];
    this.route = catalogue.routes.get(String(id));
    if (!this.route) throw new Error("The route catalogue has no routes to simulate");
    this.powerW = powerW;
    this.cadenceRpm = cadenceRpm;
    this.heartRateBpm = heartRateBpm;
    this.speedKmh = speedKmh;
    this.distanceM = 0;
    this.ascentM = 0;
    this.elapsedRideSec = 0;
    this.lastLapPosition = 0;
    this.lastAltitudeM = this.altitudeAt(0);
  }

  altitudeAt(lapPosition) {
    const points = this.route.points;
    const d = Math.min(Math.max(lapPosition, 0), this.route.plannedDistanceM);
    const after = points.findIndex(p => p.distanceM >= d);
    if (after <= 0) return points[Math.max(after, 0)].altitudeM;
    const a = points[after - 1];
    const b = points[after];
    const ratio = b.distanceM === a.distanceM ? 0 : (d - a.distanceM) / (b.distanceM - a.distanceM);
    return a.altitudeM + (b.altitudeM - a.altitudeM) * ratio;
  }

  /** Advances the ride by one second and returns a PlayerState-shaped sample. */
  next(nowMs) {
    const stepM = this.speedKmh / 3.6;
    const planned = this.route.plannedDistanceM;
    this.distanceM += stepM;
    this.elapsedRideSec += 1;
    const lapPosition = this.distanceM % planned;
    const altitudeM = this.altitudeAt(lapPosition);
    const wrapped = lapPosition < this.lastLapPosition;
    if (!wrapped && altitudeM > this.lastAltitudeM) this.ascentM += altitudeM - this.lastAltitudeM;
    const gradientPct = wrapped ? 0 : ((altitudeM - this.lastAltitudeM) / stepM) * 100;
    this.lastLapPosition = lapPosition;
    this.lastAltitudeM = altitudeM;
    return {
      receivedAtMs: nowMs,
      athleteId: "simulated",
      worldTimeMs: nowMs,
      elapsedRideSec: this.elapsedRideSec,
      powerW: this.powerW,
      heartRateBpm: this.heartRateBpm,
      cadenceRpm: this.cadenceRpm,
      speedKmh: this.speedKmh,
      distanceM: this.distanceM,
      ascentM: this.ascentM,
      altitudeM,
      gradientPct,
      eventDistanceM: this.distanceM,
      routeId: Number(this.route.routeId),
      routeName: `${this.route.routeName} (simulated)`,
      plannedDistanceM: planned,
      plannedElevationGainM: this.route.plannedElevationGainM,
      routeDistanceM: lapPosition,
      remainingDistanceM: planned - lapPosition,
      lap: Math.floor(this.distanceM / planned)
    };
  }
}
