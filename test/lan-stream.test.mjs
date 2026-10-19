import assert from "node:assert/strict";
import test from "node:test";
import { LAN_STREAM_PATH, startLanStream } from "../src/lan-stream.mjs";

async function readEvents(response, count) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const fields = Object.fromEntries(block.split("\n").filter(line => line.includes(": ")).map(line => [line.slice(0, line.indexOf(": ")), line.slice(line.indexOf(": ") + 2)]));
      if (fields.event) events.push({ event: fields.event, id: fields.id, data: JSON.parse(fields.data) });
    }
  }
  await reader.cancel();
  return events;
}

test("Wi-Fi stream serves info, streams frames and status as SSE, and is read-only", async () => {
  const lan = await startLanStream({ host: "127.0.0.1", port: 0, announce: false });
  const base = `http://127.0.0.1:${lan.port}`;
  try {
    const info = await (await fetch(`${base}/v1/info`)).json();
    assert.equal(info.service, "cyclingos-zwift");
    assert.equal(info.protocolVersion, 1);
    assert.equal(info.streamPath, LAN_STREAM_PATH);

    const response = await fetch(`${base}${LAN_STREAM_PATH}`);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const reading = readEvents(response, 3);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(lan.clients, 1);
    lan.publishFrame({ schemaVersion: 1, powerW: 250 });
    lan.publishStatus({ status: "stale", sampledAtMs: 5, sourceAgeMs: 4000 });
    const events = await reading;
    assert.deepEqual(events.map(e => e.event), ["status", "frame", "status"]);
    assert.equal(events[0].data.status, "waiting");
    assert.equal(events[1].id, "1");
    assert.equal(events[1].data.powerW, 250);
    assert.deepEqual(events[2].data, { schemaVersion: 1, dataFresh: false, status: "stale", sampledAtMs: 5, sourceAgeMs: 4000 });

    assert.equal((await fetch(`${base}/v1/stream`, { method: "POST" })).status, 405);
    assert.deepEqual(await (await fetch(`${base}/v1/state`)).json(),
      { event: "status", schemaVersion: 1, dataFresh: false, status: "stale", sampledAtMs: 5, sourceAgeMs: 4000 });
  } finally {
    await lan.close();
  }
});
