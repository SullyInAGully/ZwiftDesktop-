Add a Wi-Fi transport for "Zwift live" to this iOS app (CyclingOS), replacing Bluetooth as the default way it receives Zwift data from the desktop bridge. The desktop bridge (ZwiftDesktop, macOS and Windows) no longer advertises over Bluetooth by default; it now streams the same data over the local network. The Android app is getting the identical change, so both apps must implement exactly the protocol below. Everything downstream of the transport must keep working unchanged: decoded frames feed the session/recording pipeline exactly as the existing BLE client's reassembled frames do, and the recorded CSV/activity output must not change.

## Desktop protocol (fixed, already implemented; do not change it)

Discovery: Bonjour service type `_cyclingos-zwift._tcp` in `local.`
- Instance name: `CyclingOS Zwift (<computer name>)`
- TXT: `v=1` (protocol), `schema=1` (frame schema), `path=/v1/stream`, `ip=<preferred LAN IPv4>`
- Connect to `http://<txt ip>:<service port><txt path>`. Prefer the TXT `ip`; the resolved host can belong to a VPN/virtual adapter. Fall back to resolving the endpoint only if `ip` is missing.
- Default port 8788. Users can also type an address manually, e.g. `http://192.168.0.35:8788`.

HTTP endpoints (cleartext HTTP on the LAN, GET only; see Pairing code below):
- `GET /v1/info` → `{"service":"cyclingos-zwift","protocolVersion":1,"schemaVersion":1,"name":"CyclingOS Zwift (HOST)","streamPath":"/v1/stream"}`. Use it to validate a manually entered address (`service` must equal `cyclingos-zwift`, `protocolVersion` must be 1).
- `GET /v1/stream` → Server-Sent Events (`text/event-stream`). The server sends `retry: 2000` first, then exactly one event per second:
  - `event: frame`, `id: <increasing integer>`, `data: <schema v1 JSON>` while the rider is riding. This JSON is the same object the BLE link carried after reassembling the "CZ" chunks: `schemaVersion`, `sampledAtMs`, `sourceAgeMs`, `dataFresh`, `elapsedRideSec`, `powerW`, `heartRateBpm`, `cadenceRpm`, `speedKmh`, `distanceM`, `ascentM`, `altitudeM`, `gradientPct`, `courseId`, `routeId`, `routeName`, `plannedDistanceM`, `plannedElevationGainM`, `routeDistanceM`, `remainingDistanceM`, `terrain`, `onClimb`, `climbCategory`, `distanceToNextClimbM`, `distanceToSummitM`, `remainingElevationGainM`, `activeClimbIndex`, `activeClimbLengthM`, `activeClimbAvgGradientPct`, `activeClimbGainM`, `nextClimbLengthM`, `nextClimbAvgGradientPct`, `nextClimbGainM`, `routeProfileVersion`, `routeCheckpoint`, `routeCheckpointCount`, `lap`. Any field may be null.
  - `event: status`, `data: {"schemaVersion":1,"status":"waiting"|"stale","dataFresh":false,"sampledAtMs":…,"sourceAgeMs":…}` when there is no fresh ride data ("waiting" = Zwift not connected, "stale" = connected but not riding/paused).
  - Treat more than 5 s without any event as a dead link: cancel and reconnect with backoff (2 s, then up to 10 s), resuming automatically.
- `GET /v1/state` → the latest event as one JSON object, `{"event":"frame"|"status", …}`.

## Pairing code (required by default)

The desktop dashboard shows an 8-character pairing code (e.g. `K7QP-3MXD`). Without it `/v1/stream` and `/v1/state` return 401. `/v1/info` and `/v1/challenge` stay open. The code is never sent over the network; the phone proves it knows it with an HMAC over a single-use nonce.

Discovery: `/v1/info` has `"pairingRequired": true|false`, and the Bonjour TXT record has `auth=1|0`. If pairing is not required, skip everything below.

Handshake, repeated for **every** connection and reconnect (a nonce is single use and expires after 30 s):
1. `GET /v1/challenge` → `{"nonce":"<32 lowercase hex chars>","expiresInSec":30}`
2. `proof = lowercase hex of HMAC-SHA256(key = UTF-8 bytes of the normalized code, message = UTF-8 bytes of the nonce string)`. Normalize the code by uppercasing and removing everything except A-Z and 0-9 (so `k7qp-3mxd` and `K7QP3MXD` are the same key). Use the nonce as the 32-character hex *text*, not decoded bytes.
3. `GET /v1/stream` (or `/v1/state`) with header `Authorization: CyclingOS <nonce>:<proof>`.

Responses: `401` with `{"error":"pairing_required"|"bad_proof"|"stale_challenge"}` and `WWW-Authenticate: CyclingOS`; `429` with `Retry-After: <seconds>` after 5 wrong proofs from one address in a minute (locked out for 60 s); `503` `busy` from `/v1/challenge` when too many challenges are outstanding.

Client behaviour:
- Ask for the code the first time (one field, tolerant of case, spaces and a dash; valid characters are `23456789ABCDEFGHJKMNPQRSTWXYZ`, 8 long) and store it in the Keystore-backed encrypted preferences, alongside the remembered computer.
- `bad_proof` right after entering the code means a wrong code: clear it and ask again, with a clear message. Do **not** keep retrying a wrong code, because repeated failures lock the phone out for a minute.
- `bad_proof` on a stored code means the desktop generated a new code ("New code" in its dashboard): ask for the new one.
- `stale_challenge` just means the nonce expired or was reused: fetch a fresh challenge and retry once.
- On `429`, wait for `Retry-After` and show "Too many attempts".
- A silent reconnect (watchdog, Wi-Fi drop) repeats steps 1-3 with the stored code and needs no input from the rider.

Test vector (unit-test your HMAC against it): code `K7QP3MXD`, nonce `00112233445566778899aabbccddeeff` → proof `cfc77fd341d06d003cf6517ad8b95c2ee77faaae8e9c7f5cf470d5aa6d5fdbb4`.

## What to build

1. Find the existing BLE path (the CoreBluetooth Zwift live client, its scan UI, and where reassembled frames enter the session pipeline). Introduce a small transport protocol (e.g. `ZwiftLiveSource` publishing decoded frames plus connection state, via AsyncStream or Combine, whichever the app already uses) so the pipeline does not care whether data came from BLE or Wi-Fi. Reuse the existing `Codable` frame model; do not duplicate it.
2. `ZwiftLiveWiFiClient`:
   - Discovery with `NWBrowser(for: .bonjourWithTXTRecord(type: "_cyclingos-zwift._tcp", domain: "local."), using: .tcp)`. Read TXT from the result's `.bonjour(NWTXTRecord)` metadata.
   - Streaming with `URLSession.bytes(for:)` and `AsyncBytes.lines`, parsing SSE (`event:`, `id:`, `data:`, blank line terminates an event; ignore `retry:` and `:` comments). Use a long `timeoutIntervalForRequest` for the stream and rely on the 5 s watchdog instead.
   - Publish: discovered computers, connection state (searching / connecting / connected / waiting for Zwift / reconnecting / failed), and frames.
3. UI: a picker listing discovered "CyclingOS Zwift (…)" computers plus "Enter address manually" (validate with `/v1/info`). Remember the last-used computer and auto-connect to it next time. Show the status events ("Waiting for Zwift", "Zwift connected – start pedalling") in the existing live UI.
4. Keep the BLE client compiling and available as a hidden/legacy option if that is cheap, but Wi-Fi is the default and the documented path.
5. Info.plist:
   - `NSLocalNetworkUsageDescription`: e.g. "Finds the CyclingOS Zwift bridge on your computer to receive live ride data."
   - `NSBonjourServices`: `["_cyclingos-zwift._tcp"]` (browsing fails silently without it).
   - `NSAppTransportSecurity` → `NSAllowsLocalNetworking = true` (allows cleartext HTTP to LAN IPs and `.local` without disabling ATS globally).
   - Do NOT use UDP broadcast/multicast sockets directly; that requires Apple's multicast entitlement. Bonjour via `NWBrowser` does not.
   - Handle the local-network permission: the first browse triggers the system prompt; if denied, `NWBrowser` reports a `.waiting`/policy-denied error. Show a clear message pointing to Settings → Privacy & Security → Local Network.
6. Background behaviour (important difference from BLE): there is no background mode for a local HTTP stream, so iOS suspends the connection when the app is backgrounded or the screen locks, unlike the `bluetooth-central` background mode BLE had. During a Zwift live session, set `UIApplication.shared.isIdleTimerDisabled = true` so the screen stays on, and show a short note telling the rider to keep the app open. On returning to the foreground, reconnect immediately. If the app already holds another legitimate background mode during rides (e.g. workout or location), reuse it, but do not add one only to keep the socket alive.
7. Gaps: if the link drops mid-ride, keep the session open, reconnect, and handle missing seconds the same way the BLE path handled dropped frames. Do not invent data.

## Acceptance

- On the same Wi-Fi as a computer running `npm start` (ZwiftDesktop), after allowing Local Network access, the computer appears in the picker within a few seconds; selecting it shows live data at 1 Hz.
- With "Simulate a ride" on in the desktop dashboard (http://127.0.0.1:8787 on the computer), the app records a full session whose output matches a BLE-recorded session's fields.
- The desktop dashboard's "Phone connected" check turns green while the app is connected.
- Stopping `npm start` mid-ride shows "reconnecting"; restarting it resumes the same session without a crash. Backgrounding and returning reconnects within a few seconds.
- Manual address entry works when Bonjour is blocked, and a wrong address fails with a clear message rather than hanging.
- Unit tests for SSE parsing (frame, status, `id`, multi-line `data`, comments/`retry` lines) and the 5 s watchdog.

Quick check from a Mac on the same network: `curl -N http://<computer-ip>:8788/v1/stream`, or `dns-sd -B _cyclingos-zwift._tcp` to see the announcement.
