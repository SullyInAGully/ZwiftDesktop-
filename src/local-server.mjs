import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const DASHBOARD_PATH = new URL("./dashboard.html", import.meta.url);

export async function startLocalServer({ host = "127.0.0.1", port = 8765, getState, getStatus = () => ({}), actions = {}, onError = () => {} }) {
  const clients = new Set();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
    // Every route can reveal ride data or the pairing code, so a request must name this server as its
    // Host. A web page that rebinds its own DNS name to 127.0.0.1 arrives with a foreign Host and is refused.
    if (!hostAllowed(request.headers.host)) return sendJson(response, 403, { error: "Forbidden" });
    if (url.pathname === "/" || url.pathname === "/index.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return response.end(await readFile(DASHBOARD_PATH));
    }
    if (url.pathname === "/status") return sendJson(response, 200, getStatus());
    if (url.pathname.startsWith("/api/")) return handleAction(request, response, url);
    if (url.pathname === "/health") return sendJson(response, 200, { ok: true });
    if (url.pathname === "/state") return sendJson(response, 200, getState());
    if (url.pathname === "/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });
      response.write(`event: state\ndata: ${JSON.stringify(getState())}\n\n`);
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }
    sendJson(response, 404, { error: "Use /, /status, /state, /events or /health" });
  });

  function hostAllowed(value) {
    const actual = server.address()?.port ?? port;
    return new Set([`127.0.0.1:${actual}`, `localhost:${actual}`, `${host}:${actual}`, `[::1]:${actual}`]).has(value);
  }

  async function handleAction(request, response, url) {
    const action = url.pathname.slice(5);
    if (request.method !== "POST" || !Object.hasOwn(actions, action)) {
      return sendJson(response, 404, { error: "Unknown action" });
    }
    // Control calls change credentials and networking, so reject anything that did not come from this
    // page: a foreign Host (DNS rebinding), a foreign Origin (another website), or a non-JSON body
    // (which would not trigger a CORS preflight).
    const actual = server.address().port;
    const allowed = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`, `${host}:${actual}`]);
    const origin = request.headers.origin;
    if (!allowed.has(request.headers.host) || (origin && !allowed.has(origin.replace(/^https?:\/\//, ""))) ||
        !String(request.headers["content-type"]).startsWith("application/json")) {
      return sendJson(response, 403, { error: "Forbidden" });
    }
    try {
      let raw = "";
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 16_384) return sendJson(response, 413, { error: "Body too large" });
      }
      await actions[action](raw ? JSON.parse(raw) : {});
      sendJson(response, 200, { ok: true, status: getStatus() });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message });
    }
  }

  await new Promise((resolve, reject) => {
    const startupError = error => reject(error);
    server.once("error", startupError);
    server.listen(port, host, () => {
      server.off("error", startupError);
      server.on("error", onError);
      resolve();
    });
  });
  return {
    address() {
      return server.address();
    },
    publish(state) {
      const message = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
      for (const client of clients) client.write(message);
    },
    close() {
      for (const client of clients) client.end();
      clients.clear();
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      return closed;
    }
  };
}

function sendJson(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}
