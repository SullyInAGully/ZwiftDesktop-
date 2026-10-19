Replace the Bluetooth (BLE) transport for "Zwift live" in this Android app (PolarSDKTest / CyclingOS) with a Wi-Fi transport. The desktop bridge (ZwiftDesktop, macOS and Windows) no longer advertises over Bluetooth by default; it now streams the same data over the local network. Everything downstream of the transport must keep working unchanged: the frames feed `SessionManager` exactly as `ZwiftLiveBleClient`'s reassembled frames did, and `CsvExporter` still writes the same Strava-format CSV.

## Desktop protocol (fixed, already implemented; do not change it)

Discovery: DNS-SD/Bonjour service type `_cyclingos-zwift._tcp` in `local.`
- Instance name: `CyclingOS Zwift (<computer name>)`
- TXT: `v=1` (protocol), `schema=1` (frame schema), `path=/v1/stream`, `ip=<preferred LAN IPv4>`
- Connect to `http://<txt ip>:<service port><txt path>`. Prefer the TXT `ip`; the resolved host address can belong to a VPN/virtual adapter. Fall back to the resolved address only if `ip` is missing.
- Default port 8788. Users can also type an address manually, e.g. `http://192.168.0.35:8788`.

HTTP endpoints (cleartext HTTP on the LAN, GET only):
- `GET /v1/info` → `{"service":"cyclingos-zwift","protocolVersion":1,"schemaVersion":1,"name":"CyclingOS Zwift (HOST)","streamPath":"/v1/stream"}`. Use it to validate a manually entered address (`service` must equal `cyclingos-zwift`, `protocolVersion` must be 1).
- `GET /v1/stream` → Server-Sent Events (`text/event-stream`). The server sends `retry: 2000` first, then exactly one event per second:
  - `event: frame`, `id: <increasing integer>`, `data: <schema v1 JSON>` while the rider is riding. This JSON is byte-for-byte the same object the BLE link carried after reassembling the "CZ" chunks: `schemaVersion`, `sampledAtMs`, `sourceAgeMs`, `dataFresh`, `elapsedRideSec`, `powerW`, `heartRateBpm`, `cadenceRpm`, `speedKmh`, `distanceM`, `ascentM`, `altitudeM`, `gradientPct`, `courseId`, `routeId`, `routeName`, `plannedDistanceM`, `plannedElevationGainM`, `routeDistanceM`, `remainingDistanceM`, `terrain`, `onClimb`, `climbCategory`, `distanceToNextClimbM`, `distanceToSummitM`, `remainingElevationGainM`, `activeClimbIndex`, `activeClimbLengthM`, `activeClimbAvgGradientPct`, `activeClimbGainM`, `nextClimbLengthM`, `nextClimbAvgGradientPct`, `nextClimbGainM`, `routeProfileVersion`, `routeCheckpoint`, `routeCheckpointCount`, `lap`. Any field may be null.
  - `event: status`, `data: {"schemaVersion":1,"status":"waiting"|"stale","dataFresh":false,"sampledAtMs":…,"sourceAgeMs":…}` when there is no fresh ride data ("waiting" = Zwift not connected, "stale" = connected but not riding/paused).
  - Treat more than 5 s without any event as a dead link: close and reconnect with backoff (2 s, then up to 10 s), resuming automatically.
- `GET /v1/state` → the latest event as one JSON object, `{"event":"frame"|"status", …}`.

## What to build

1. Find the existing BLE path (`ZwiftLiveBleClient`, the Zwift live scan control, and wherever frames reach `SessionManager`). Introduce a small transport interface (e.g. `ZwiftLiveSource` emitting decoded frames plus connection state) so `SessionManager` does not care whether data came from BLE or Wi-Fi. Reuse the existing frame model/JSON parsing; do not duplicate it.
2. `ZwiftLiveWifiClient`:
   - Discovery with `NsdManager` (`discoverServices("_cyclingos-zwift._tcp", NsdManager.PROTOCOL_DNS_SD, …)`). Resolve each found service (on API 34+ use `registerServiceInfoCallback`; below that, `resolveService` one at a time because it fails with FAILURE_ALREADY_ACTIVE when concurrent). Read TXT from `NsdServiceInfo.attributes` (byte arrays, UTF-8). Hold a `WifiManager.MulticastLock` while discovering.
   - Streaming with OkHttp (`okhttp-sse` `EventSources`) or a plain `HttpURLConnection` line reader on `Dispatchers.IO`. Disable the call/read timeout for the stream and rely on the 5 s watchdog instead.
   - Expose a flow/state of: discovered computers, connection state (searching / connecting / connected / waiting for Zwift / reconnecting / failed), and frames.
3. UI: replace the Zwift live Bluetooth scan control with a picker listing discovered "CyclingOS Zwift (…)" computers, plus "Enter address manually" (validate with `/v1/info`). Remember the last-used computer (instance name and address) and auto-connect to it next time. Show the status events ("Waiting for Zwift", "Zwift connected – start pedalling") in the existing live UI.
4. Keep the BLE client compiling and reachable as a hidden/legacy option if that is cheap, but Wi-Fi is the default and the documented path.
5. Manifest and config:
   - Permissions: `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`, `CHANGE_WIFI_MULTICAST_STATE`.
   - Cleartext HTTP to LAN IPs: Network Security Config cannot whitelist IP ranges, so allow cleartext in `base-config` (or, if the app already relies on blocking cleartext elsewhere, scope it as narrowly as you can and explain the trade-off in the PR).
   - During a live ride: keep using the app's existing foreground service if it has one, and take a `WifiManager.WifiLock` (low-latency / high-perf mode) so Wi-Fi power saving doesn't drop the 1 Hz stream with the screen off.
6. Gaps: if the link drops mid-ride, keep the session open, reconnect, and handle the missing seconds the same way the BLE path handled dropped frames. Do not invent data.

## Acceptance

- On the same Wi-Fi as a computer running `npm start` (ZwiftDesktop), the computer appears in the picker within a few seconds; selecting it shows live data at 1 Hz.
- With "Simulate a ride" on in the desktop dashboard (http://127.0.0.1:8787 on the computer), the app records a full session and `CsvExporter` produces the same columns as a BLE-recorded session.
- The desktop dashboard's "Phone connected" check turns green while the app is connected.
- Killing `npm start` mid-ride shows "reconnecting"; restarting it resumes the same session without a crash.
- Manual address entry works when discovery is blocked (e.g. a guest network with client isolation fails with a clear message, not a hang).
- Unit tests for SSE parsing (frame, status, `id`, multi-line `data`, comments/`retry` lines) and for the 5 s watchdog.

Quick check from a laptop on the same network: `curl -N http://<computer-ip>:8788/v1/stream`.
