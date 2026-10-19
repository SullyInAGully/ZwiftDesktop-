import { createServer } from "node:http";
import { hostname } from "node:os";
import { Bonjour } from "bonjour-service";
import { PairingGuard } from "./pairing.mjs";

/** Bonjour/NSD service type: _cyclingos-zwift._tcp (a DNS-SD service label is limited to 15 characters). */
export const LAN_SERVICE_TYPE = "cyclingos-zwift";
export const LAN_PROTOCOL_VERSION = 1;
export const LAN_DEFAULT_PORT = 8788;
export const LAN_STREAM_PATH = "/v1/stream";
const MAX_CLIENTS = 8;

/**
 * Read-only Wi-Fi link to the CyclingOS phone apps (Android and iOS), replacing the BLE peripheral.
 * Streams the same schema-v1 JSON frames as Server-Sent Events and announces itself over Bonjour.
 * Nothing here can change state, and frames carry no account identifiers (see bleState).
 * With a [PairingGuard] that requires pairing, the stream and state endpoints need a challenge/response
 * proof of the pairing code; /v1/info and /v1/challenge stay open so a phone can discover the requirement.
 */
export async function startLanStream({
  host = "0.0.0.0",
  port = LAN_DEFAULT_PORT,
  advertiseIp = null,
  announce = true,
  guard = new PairingGuard({ required: false }),
  name = `CyclingOS Zwift (${hostname().replace(/\.local$/i, "")})`,
  onError = () => {}
}) {
  const clients = new Set();
  let latest = { event: "status", data: { schemaVersion: 1, status: "waiting", dataFresh: false } };
  let sequence = 0;

  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://lan");
    if (request.method !== "GET" && request.method !== "HEAD") return sendJson(response, 405, { error: "Read-only" });
    if (url.pathname === "/v1/info") return sendJson(response, 200, info());
    if (url.pathname === "/v1/challenge") {
      const challenge = guard.issueChallenge();
      return challenge ? sendJson(response, 200, challenge) : sendJson(response, 503, { error: "busy" });
    }
    const protectedPath = url.pathname === "/v1/state" || url.pathname === LAN_STREAM_PATH;
    if (protectedPath) {
      const verdict = guard.check(request.headers.authorization, request.socket.remoteAddress);
      if (!verdict.ok) {
        const headers = { "WWW-Authenticate": "CyclingOS" };
        if (verdict.retryAfterSec) headers["Retry-After"] = String(verdict.retryAfterSec);
        return sendJson(response, verdict.status, { error: verdict.error }, headers);
      }
    }
    if (url.pathname === "/v1/state") return sendJson(response, 200, { event: latest.event, ...latest.data });
    if (url.pathname === LAN_STREAM_PATH) {
      if (clients.size >= MAX_CLIENTS) return sendJson(response, 503, { error: "Too many phones connected" });
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });
      response.socket?.setNoDelay(true);
      response.write(`retry: 2000\n${message(latest)}`);
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }
    sendJson(response, 404, { error: `Use /v1/info, /v1/state or ${LAN_STREAM_PATH}` });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      server.on("error", onError);
      resolve();
    });
  });
  const actualPort = server.address().port;

  let bonjour = null;
  let service = null;
  let announced = false;
  let publishing = Promise.resolve();
  // Re-announcing must wait for the old record's goodbye, or the name probe sees our own record as a conflict.
  const publishService = () => (publishing = publishing.then(republish));
  async function republish() {
    if (!announce) return;
    try {
      bonjour ??= new Bonjour({}, error => onError(error));
      if (service) {
        const old = service;
        service = null;
        announced = false;
        await new Promise(resolve => old.stop(resolve));
      }
      service = bonjour.publish({
        name,
        type: LAN_SERVICE_TYPE,
        protocol: "tcp",
        port: actualPort,
        // Phones should prefer txt.ip: the resolved host address can be a VPN or virtual adapter.
        txt: { v: String(LAN_PROTOCOL_VERSION), schema: "1", path: LAN_STREAM_PATH, auth: guard.required ? "1" : "0", ...(advertiseIp ? { ip: advertiseIp } : {}) }
      });
      service.on("up", () => { announced = true; });
      service.on("error", error => { announced = false; onError(error); });
    } catch (error) {
      announced = false;
      onError(error);
    }
  }
  await publishService();

  function info() {
    return {
      service: LAN_SERVICE_TYPE,
      protocolVersion: LAN_PROTOCOL_VERSION,
      schemaVersion: 1,
      name,
      streamPath: LAN_STREAM_PATH,
      pairingRequired: guard.required
    };
  }

  function message({ event, data, id }) {
    return `event: ${event}\n${id != null ? `id: ${id}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
  }

  function send(event, data) {
    latest = { event, data, id: event === "frame" ? ++sequence : undefined };
    const text = message(latest);
    for (const client of clients) client.write(text);
  }

  return {
    name,
    port: actualPort,
    get clients() { return clients.size; },
    get announced() { return announced; },
    /** A riding sample: the bleState projection, schemaVersion 1. */
    publishFrame(frame) { send("frame", frame); },
    /** No fresh ride data: "waiting" (no game) or "stale" (game connected, no PlayerState). */
    publishStatus(status) { send("status", { schemaVersion: 1, dataFresh: false, ...status }); },
    /** Applies a changed pairing setting: drops every connected phone and re-announces the requirement. */
    setPairing(settings) {
      guard.configure(settings);
      for (const client of clients) client.end();
      clients.clear();
      return publishService();
    },
    setAdvertiseIp(ip) {
      if (ip === advertiseIp) return publishing;
      advertiseIp = ip;
      return publishService();
    },
    async close() {
      for (const client of clients) client.end();
      clients.clear();
      await publishing;
      await new Promise(resolve => {
        if (!bonjour) return resolve();
        bonjour.unpublishAll(() => { bonjour.destroy(); resolve(); });
      });
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await closed;
    }
  };
}

function sendJson(response, status, value, extraHeaders = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache", ...extraHeaders });
  response.end(`${JSON.stringify(value)}\n`);
}
