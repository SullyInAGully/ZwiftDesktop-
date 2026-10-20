/**
 * Checks a catalogue profile against what Zwift itself reports while someone rides.
 *
 * The catalogue says what the altitude should be at each point of a route. If the profile is for the wrong
 * route, or is shifted along the route, the live altitude stops following it. Only the shape is compared
 * (the error minus its average), because a constant offset between data sources is harmless. A mismatch is
 * sticky for the rest of that route, so climb information is not flickered on and off.
 */
export class ProfileCheck {
  constructor({ windowSize = 120, minSamples = 45, rmsLimitM = 3 } = {}) {
    this.windowSize = windowSize;
    this.minSamples = minSamples;
    this.rmsLimitM = rmsLimitM;
    this.reset(null);
  }

  reset(routeId) {
    this.routeId = routeId;
    this.errors = [];
    this.mismatch = false;
    this.rmsM = null;
  }

  /**
   * @param active false while the sample says nothing (stopped, on the lead-in, route unknown)
   */
  update({ routeId, liveAltitudeM, expectedAltitudeM, active }) {
    if (String(routeId ?? "") !== String(this.routeId ?? "")) this.reset(routeId ?? null);
    if (!active || !Number.isFinite(liveAltitudeM) || !Number.isFinite(expectedAltitudeM)) return this.state;
    this.errors.push(liveAltitudeM - expectedAltitudeM);
    if (this.errors.length > this.windowSize) this.errors.shift();
    if (this.errors.length >= this.minSamples) {
      const mean = this.errors.reduce((sum, e) => sum + e, 0) / this.errors.length;
      this.rmsM = Math.sqrt(this.errors.reduce((sum, e) => sum + (e - mean) ** 2, 0) / this.errors.length);
      if (this.rmsM > this.rmsLimitM) this.mismatch = true;
    }
    return this.state;
  }

  /** "unknown" until a route is checked, "checking" while samples build up, then "ok" or "mismatch". */
  get state() {
    if (this.routeId == null) return { state: "unknown", samples: 0, rmsM: null };
    const state = this.mismatch ? "mismatch" : this.errors.length >= this.minSamples ? "ok" : "checking";
    return { state, samples: this.errors.length, rmsM: this.rmsM == null ? null : Math.round(this.rmsM * 100) / 100 };
  }
}
