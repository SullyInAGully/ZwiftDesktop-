# Zwift Live Prototype

## Recommended source: direct local Companion stream

This mode registers the Mac as the rider's Zwift Companion endpoint once, then accepts the
game's persistent local TCP connection. It does not poll the rate-limited live-state endpoint and
does not require Sauce or a second Zwift account.

```bash
npm start
```

The receiver writes the exact incoming PlayerState stream to raw JSONL and emits a synchronized
1 Hz CSV under `sessions/`. While it is registered, the official Zwift Companion app cannot own
the same game connection. This is still an unofficial protocol and must be regression-tested after
Zwift updates.

## Exact 1 Hz source (Sauce for Zwift)

The production-direction experiment reads Zwift's decrypted live `PlayerState` from the local
[Sauce for Zwift](https://github.com/SauceLLC/sauce4zwift) API. Sauce must be running and watching
the main rider using a second free Zwift monitor account. Start the collector with:

```bash
npm run start:sauce
```

It samples on exact one-second boundaries and writes both CSV and JSONL under `sessions/`. Each
row includes Zwift power, heart rate, cadence, speed, total distance, cumulative ascent, altitude,
gradient, course/route IDs, route distance, route end and remaining route distance. Samples older
than 2.5 seconds are marked stale and are not written as valid ride rows.

The older `npm run start:relay` command below is retained only as an experiment with Zwift's private web
relay. It is not the source to use for synchronized ML data.

A separate, read-only CyclingOS experiment for testing Zwift ride-state sources on macOS.

It combines:

- Experimental Zwift `PlayerState` polling for power, distance, altitude, cumulative ascent, speed,
  cadence, heart rate and elapsed ride time.
- `~/Documents/Zwift/Logs/Log.txt` parsing for route name/hash, planned distance, lead-in,
  planned ascent and checkpoint progress.
- A local HTTP/SSE interface for a future Android connection.
- One newline-delimited JSON file per detected ride under `sessions/`.

This uses an unofficial Zwift endpoint. Testing on 18 October 2026 showed that one-second polling
is rate-limited and that an active rider may still receive HTTP 404. The endpoint is therefore an
experiment, not a viable 1 Hz production source. The monitor defaults to five seconds, backs off
on HTTP 429, and reduces polling to every 30 seconds after repeated 404 responses.

## Requirements

- macOS
- Node.js 20 or newer
- Zwift installed on the same Mac

## Install

```bash
cd /Users/joshuamilsom/AndroidStudioProjects/ZwiftLivePrototype
npm install
npm run credentials
```

The email is saved in a mode-`0600` config file. The password is stored in macOS Keychain under
`CyclingOS Zwift Live Prototype`; it is not stored in this project or written to telemetry logs.

## Legacy private-relay experiment

Start Zwift and enter a ride, then run:

```bash
npm run start:relay
```

If Zwift exposes the rider through the private relay, the terminal shows live samples. Route-log
updates continue independently. Useful local endpoints are:

```text
http://127.0.0.1:8765/state   latest JSON snapshot
http://127.0.0.1:8765/events  Server-Sent Events stream
http://127.0.0.1:8765/health  process health
```

Example:

```bash
curl http://127.0.0.1:8765/state
curl -N http://127.0.0.1:8765/events
```

Options:

```text
--interval-ms 5000     polling interval; minimum 3000
--relay-world 1        Zwift relay world identifier
--port 8765            local HTTP port
--host 127.0.0.1       local bind address
--log PATH             alternative Zwift Log.txt path
--once                 make one request and exit
```

## Validate the experiment

For a useful test, check that:

- samples arrive without HTTP 429 responses;
- distance never decreases during a ride;
- cumulative ascent tracks Zwift's HUD;
- the route name and planned totals match Zwift;
- the final JSONL distance/ascent match the finalized FIT activity.

If the relay returns `404`, verify that a ride is active. If it continues, the private endpoint may
not expose the account/session and the prototype should not be treated as a production dependency.

## Security

The local server binds only to `127.0.0.1` by default. Do not bind it to `0.0.0.0` on an untrusted
network. Access and refresh tokens remain in memory and are never printed or persisted.

## Bluetooth link to the CyclingOS phone app

`npm start` also advertises a BLE GATT service (`8E6F1000-7A95-4A7F-A8D9-4F6E9A1C2100`, state
characteristic `8E6F1001-…`, read + notify) carrying one enriched 1 Hz JSON frame per second
(schema v1, chunked with an 11-byte header: `"CZ"`, version, u32 sequence, u16 index, u16 count).
Account IDs never cross this link. Pass `--no-ble` to disable it.

The native helper in `mac-ble/` is compiled on first run into `.build/CyclingOSZwiftBLE.app`
(a bundle is required so macOS grants CoreBluetooth access; approve the Bluetooth prompt once).
Run `npm run build:ble` to rebuild it manually.

On the phone, use the Zwift live scan control, then start a direct Zwift ride. The phone's
`ZwiftLiveBleClient` feeds `SessionManager`, and `CsvExporter` writes the normal Strava-format CSV.

Add routes to `routes/catalog-v1.json` with `npm run route:add -- <recording.csv>` after riding
them. Unknown routes leave climb fields empty rather than guessing.

## Setup dashboard

`npm start` opens http://127.0.0.1:8787/ (pass `--no-open` to skip). Everything is configured there,
so `npm run credentials` is no longer needed:

- **Zwift account:** enter your login once (stored in the macOS Keychain), then Connect, Disconnect or Forget.
- **Settings:** Bluetooth on/off, connect-on-launch, and which network address Zwift should send data to.
- **Checklist and live readings:** Zwift connected, data fresh, route in catalogue, Bluetooth advertising,
  phone connected, backup recording, plus the live climb fields.

Settings live in `~/.config/cyclingos-zwift-live/settings.json`. `/status` returns the same data as JSON.
The control endpoints (`POST /api/*`) only accept JSON requests from this page.
