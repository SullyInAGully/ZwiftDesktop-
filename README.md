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

- macOS 11+ or Windows 10 (1809)+ / Windows 11
- Node.js 20 or newer
- Zwift installed on the same computer
- The phone on the same Wi-Fi/LAN as the computer

## Install

```bash
cd ZwiftDesktop-
npm install
npm run credentials
```

The email is saved in a mode-`0600` config file. The password is stored in macOS Keychain under
`CyclingOS Zwift Live Prototype` (on Windows, DPAPI-encrypted for the current user); it is not stored
in this project or written to telemetry logs.

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

The dashboard and control API bind only to `127.0.0.1` by default. Do not bind them to `0.0.0.0` on an
untrusted network. Access and refresh tokens remain in memory and are never printed or persisted.

The Wi-Fi phone stream (port 8788) is the only thing reachable from the network. It is read-only
(GET only), serves the same account-free frames the BLE link carried, and has no control endpoints.
Anyone on the same network can read the live ride frames, as anyone in Bluetooth range could before;
use it on a home network, not public Wi-Fi.

## Wi-Fi link to the CyclingOS phone apps

`npm start` streams one enriched 1 Hz JSON frame per second to the Android and iOS apps over the local
network, on macOS and Windows alike. Frames are the same schema v1 the BLE link carried (`bleState` in
`src/ble-peripheral.mjs`), so account IDs never cross this link. Pass `--no-wifi` to disable it.

- **Discovery:** Bonjour/DNS-SD service `_cyclingos-zwift._tcp`, instance `CyclingOS Zwift (<computer name>)`,
  TXT `v=1`, `schema=1`, `path=/v1/stream`, `ip=<preferred LAN IPv4>`. Phones should connect to the TXT `ip`
  (the resolved host address may belong to a VPN or virtual adapter). The dashboard also shows the
  address for manual entry, e.g. `http://192.168.0.35:8788`.
- **`GET /v1/info`:** `{"service":"cyclingos-zwift","protocolVersion":1,"schemaVersion":1,"name":…,"streamPath":"/v1/stream"}`.
- **`GET /v1/stream`:** Server-Sent Events. Exactly one event per second:
  `event: frame` (with an increasing `id`) carrying the schema v1 frame while riding, otherwise
  `event: status` with `{"schemaVersion":1,"status":"waiting"|"stale","dataFresh":false,"sampledAtMs":…,"sourceAgeMs":…}`.
  More than 5 s without an event means the link is down; reconnect.
- **`GET /v1/state`:** the latest event as JSON, `{"event":"frame"|"status", …}`.

Port 8788 by default (`--lan-port`). Try it with `curl -N http://<computer-ip>:8788/v1/stream`, and turn
on **Simulate a ride** in the dashboard to stream frames without Zwift.

**Windows firewall:** run `npm run firewall:win` once (it asks for administrator approval). It allows
only `node.exe`, only on **Private** networks, on TCP 8788 and UDP 5353 (Bonjour). Make sure Windows
treats your home network as Private (Settings → Network & internet → your connection).
**macOS:** if the firewall is on, allow incoming connections for `node` when asked.

On the phone, open Zwift live and pick “CyclingOS Zwift” (or enter the address), then start a direct
Zwift ride. The phone records the normal Strava-format CSV as before.

### Windows notes

- **Password storage:** the Zwift password is encrypted with Windows DPAPI for the current Windows
  user (`%USERPROFILE%.configcyclingos-zwift-livepassword.dpapi`). It can only be decrypted by
  that user on that PC.
- **Zwift log:** read from `DocumentsZwiftLogsLog.txt`, including OneDrive-redirected Documents
  folders; the monitor waits for it to appear. Pass `--log PATH` if Zwift keeps it elsewhere.

Add routes to `routes/catalog-v1.json` with `npm run route:add -- <recording.csv>` after riding
them. Unknown routes leave climb fields empty rather than guessing.

## Bluetooth link (legacy, opt-in)

With **Also broadcast over Bluetooth (legacy)** turned on in the dashboard, `npm start` also advertises a BLE GATT service (`8E6F1000-7A95-4A7F-A8D9-4F6E9A1C2100`, state
characteristic `8E6F1001-…`, read + notify) carrying one enriched 1 Hz JSON frame per second
(schema v1, chunked with an 11-byte header: `"CZ"`, version, u32 sequence, u16 index, u16 count).
Account IDs never cross this link. It is off by default; Wi-Fi replaced it on both platforms. `--no-ble` forces it off.

The native helper in `mac-ble/` ships as a prebuilt, ad-hoc-signed **universal app**
(`mac-ble/prebuilt/CyclingOSZwiftBLE.app`, Apple Silicon and Intel, macOS 11 or newer), so riders'
Macs need no compiler. A bundle is required so macOS grants CoreBluetooth access; approve the
Bluetooth prompt once. If the helper source changes, `run-helper.sh` compiles a local copy when the
Command Line Tools are installed and otherwise keeps using the prebuilt one with a warning.

After editing `mac-ble/ZwiftLivePeripheral.swift` or `Info.plist`, run `npm run build:ble` on a Mac
(Xcode or Command Line Tools) and commit `mac-ble/prebuilt`. Windows cannot build this helper.

### Windows BLE helper

On Windows the same GATT service, characteristic and chunk format are served by `win-ble/`, a C#
WinRT `GattServiceProvider` helper. No executable is committed: the first time Bluetooth is enabled,
`win-ble/run-helper.mjs` builds it into `.build/` with the .NET 8 SDK
(`winget install Microsoft.DotNet.SDK.8`), and rebuilds when the source changes. Wi-Fi, the default,
needs none of this.

BLE on Windows:

- **Advertised name:** Windows does not let apps set the BLE local name, so the PC advertises under
  its own Bluetooth name. The phone must find it by the service UUID, not by the name “CyclingOS Zwift”.
- **Discoverability:** if the adapter refuses general-discoverable GATT advertising, the helper falls
  back to plain connectable advertising, which Android scanners filtering by service UUID still see.
- **Advertising not confirmed:** on some PCs (seen on Windows 11 build 26200 with an Intel AX210) Windows never
  starts GATT advertising for an unpackaged app, so phones cannot see the PC. This is why Wi-Fi is the default.

## Setup dashboard

`npm start` opens http://127.0.0.1:8787/ (pass `--no-open` to skip). Everything is configured there,
so `npm run credentials` is no longer needed:

- **Zwift account:** enter your login once (stored in the macOS Keychain, or DPAPI-encrypted on Windows), then Connect, Disconnect or Forget.
- **Settings:** Wi-Fi stream on/off, legacy Bluetooth on/off, connect-on-launch, and which network address
  Zwift and the phone use.
- **Checklist and live readings:** Zwift connected, data fresh, route in catalogue, Wi-Fi stream (with the
  manual address), phone connected, backup recording, plus the live climb fields.

**Stop everything** (top right) disconnects Zwift, every phone and Bluetooth, and ends any recording or
simulation, while the dashboard stays up. Your settings and saved login are kept. **Start again** brings
everything back; **Quit monitor** exits the program.

Settings live in `~/.config/cyclingos-zwift-live/settings.json`. `/status` returns the same data as JSON.
The control endpoints (`POST /api/*`) only accept JSON requests from this page.

## Phone pairing code

The Wi-Fi stream is closed to anyone without the pairing code shown in the dashboard's **Phone pairing**
card (8 characters, created on first run and kept in `settings.json`, mode `0600`). The phone fetches a
single-use challenge and answers with an HMAC keyed by the code, so the code never crosses the network and a
captured answer cannot be replayed. Five wrong answers lock that address out for a minute. **New code** in the
dashboard disconnects every paired phone; pairing can be switched off there for testing. Details and a test
vector for phone developers are in `docs/phone-prompts/`.

Pairing protects against other devices on the network using the stream. The stream itself is still plain
HTTP, so it does not hide ride data from someone who can already capture traffic on your Wi-Fi.

## Rider package for Intel Macs

`npm run package:mac` builds `dist/CyclingOS-Zwift-Link-Mac-Intel.zip` (about 39 MB): the monitor, its
production dependencies, a pinned and checksum-verified Intel Node.js, a double-click `Start Zwift Link.command`
and a `START HERE.txt` for the rider. Riders install nothing. It needs a Mac with network access to build, and
the pinned Node version is set in `tools/package-mac.mjs`. Share the zip however you like (for example Google
Drive); the rider right-clicks the launcher and chooses Open the first time, and macOS asks once to allow
incoming connections for `node`. The monitor writes a log to `~/Library/Logs/CyclingOS Zwift Link/monitor.log`,
which the dashboard's "Show log file" link reveals so a rider can send it to you. The zip is unsigned and
un-notarised, so macOS shows the "cannot verify the developer" prompt on first open.

## Route catalogue (climb context for every Zwift route)

Climb fields (terrain, distance to next climb or summit, climb length and gradient, elevation left) need each
route's elevation profile. Two sources, in priority order:

1. **Routes you recorded** (`routes/catalog-v1.json`, add with `npm run route:add -- <ride.csv>`). Always win.
2. **Imported profiles** (`routes/imported-zwift-data.json`), built by `npm run catalog:import` from the
   MIT-licensed [`zwift-data`](https://github.com/andipaetzold/zwift-data) package (dev dependency, pinned). Its
   route ids are the same hashes Zwift sends, so routes match directly. About 286 cycling routes pass the
   importer's checks (length within 3% of Zwift's distance, climbing within 10% of Zwift's published total,
   lead-ins trimmed); `routes/import-report.json` lists the rest and why.

The imported profiles were originally derived from Strava segment streams. That file and its report are
**git-ignored on purpose**: they are for internal use (the rider package includes them) and should not be
published in a public repository.

While someone rides, the monitor compares Zwift's live altitude with what the catalogue expects. If the shape
disagrees (wrong route or a shifted profile) climb information is switched off for that route and the dashboard
says so, rather than giving wrong context. Every row's `routeProfileVersion` records which catalogue it came from.
