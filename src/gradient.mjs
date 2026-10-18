export class GradientEstimator {
  constructor(windowSeconds = 8, minimumDistanceM = 8) {
    this.windowMs = windowSeconds * 1000;
    this.minimumDistanceM = minimumDistanceM;
    this.points = [];
  }

  reset() {
    this.points = [];
  }

  update(distanceM, altitudeM, timeMs = Date.now()) {
    const last = this.points.at(-1);
    if (last && distanceM < last.distanceM) this.reset();
    this.points.push({ distanceM, altitudeM, timeMs });
    const cutoff = timeMs - this.windowMs;
    while (this.points.length > 2 && this.points[0].timeMs < cutoff) this.points.shift();
    const first = this.points[0];
    const current = this.points.at(-1);
    const deltaDistance = current.distanceM - first.distanceM;
    if (deltaDistance < this.minimumDistanceM) return null;
    const value = ((current.altitudeM - first.altitudeM) / deltaDistance) * 100;
    return Math.round(Math.max(-50, Math.min(50, value)) * 10) / 10;
  }
}
