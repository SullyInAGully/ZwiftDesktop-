import test from "node:test";
import { request } from "node:http";
import assert from "node:assert/strict";
import { startLocalServer } from "../src/local-server.mjs";

test("local API waits for its socket and serves state", async () => {
  const state = { status: "riding", powerW: 250 };
  const server = await startLocalServer({ host: "127.0.0.1", port: 0, getState: () => state });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/state`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), state);
  } finally {
    await server.close();
  }
});

test("serves the setup dashboard and status", async () => {
  const server = await startLocalServer({ port: 0, getState: () => ({}), getStatus: () => ({ ok: 1 }) });
  const { port } = server.address();
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.match(await page.text(), /CyclingOS Zwift Link/);
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/status`)).json(), { ok: 1 });
  await server.close();
});

test("control actions reject foreign origins and non-JSON requests", async () => {
  const calls = [];
  const server = await startLocalServer({
    port: 0, getState: () => ({}), getStatus: () => ({ ok: 1 }),
    actions: { connect: async body => { calls.push(body); } }
  });
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/api/connect`;
  const json = { "Content-Type": "application/json" };
  const post = (headers, body = "{}") => fetch(url, { method: "POST", headers, body });
  assert.equal((await post({ ...json, Origin: "https://evil.example" })).status, 403);
  const rebinding = await new Promise(resolve => {
    const req = request({ port, method: "POST", path: "/api/connect", headers: { ...json, Host: "evil.example" } },
      res => { res.resume(); resolve(res.statusCode); });
    req.end("{}");
  });
  assert.equal(rebinding, 403);
  assert.equal((await post({ "Content-Type": "text/plain" })).status, 403);
  assert.equal((await fetch(url)).status, 404);
  assert.equal((await post({ ...json, Origin: `http://127.0.0.1:${port}` }, '{"a":1}')).status, 200);
  assert.deepEqual(calls, [{ a: 1 }]);
  await server.close();
});

test("dashboard routes refuse a foreign Host header (DNS rebinding)", async () => {
  const server = await startLocalServer({ port: 0, getState: () => ({}), getStatus: () => ({ pairingCode: "SECRET" }) });
  const { port } = server.address();
  const get = host => new Promise(resolve => {
    request({ port, path: "/status", headers: { Host: host } }, res => { res.resume(); resolve(res.statusCode); }).end();
  });
  assert.equal(await get(`127.0.0.1:${port}`), 200);
  assert.equal(await get(`localhost:${port}`), 200);
  assert.equal(await get("evil.example"), 403);
  assert.equal(await get(`evil.example:${port}`), 403);
  await server.close();
});
