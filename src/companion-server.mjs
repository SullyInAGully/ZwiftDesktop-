import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import os from "node:os";
import protobuf from "protobufjs";

export class CompanionServer extends EventEmitter {
  constructor({ protoPath, athleteId, host = "0.0.0.0", port = 0 }) {
    super();
    this.protoPath = protoPath;
    this.athleteId = athleteId;
    this.host = host;
    this.port = port;
    this.server = null;
    this.socket = null;
    this.pending = Buffer.alloc(0);
    this.messageSeq = 1;
    this.commandSeq = 1;
  }

  async start() {
    const root = await protobuf.load(this.protoPath);
    this.GameToCompanion = root.lookupType("GameToCompanion");
    this.CompanionToGame = root.lookupType("CompanionToGame");
    this.server = createServer(socket => this.onConnection(socket));
    this.server.on("error", error => this.emit("error", error));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    return this.server.address();
  }

  onConnection(socket) {
    if (this.socket) this.socket.destroy();
    this.socket = socket;
    this.pending = Buffer.alloc(0);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);
    socket.on("data", chunk => this.onData(chunk));
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      this.emit("disconnected");
    });
    socket.on("error", error => this.emit("socketError", error));
    this.emit("connected", { remoteAddress: socket.remoteAddress });
    this.sendHandshake().catch(error => this.emit("error", error));
  }

  onData(chunk) {
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= 4) {
      const length = this.pending.readUInt32BE(0);
      if (length > 1024 * 1024) {
        this.socket?.destroy(new Error(`Illegal Companion frame length: ${length}`));
        return;
      }
      if (this.pending.length < length + 4) return;
      const body = this.pending.subarray(4, length + 4);
      this.pending = this.pending.subarray(length + 4);
      const decoded = this.GameToCompanion.decode(body);
      const message = this.GameToCompanion.toObject(decoded, {
        longs: Number,
        enums: String,
        defaults: false
      });
      this.emit("message", message);
      if (message.playerState) this.emit("playerState", normalizeCompanionMessage(message));
    }
  }

  async sendHandshake() {
    await this.sendCommand({
      type: "PHONE_TO_GAME_PACKET",
      gamePacket: {
        type: "CLIENT_INFO",
        clientInfo: {
          appVersion: "0.1.0",
          osVersion: os.release(),
          platform: os.platform(),
          deviceModel: os.machine(),
          capabilities: { orientation: false, headphones: false },
          locale: "en-GB"
        }
      }
    });
    await this.sendCommand({ type: "PAIRING_AS", athleteId: this.athleteId });
    await this.sendCommand({
      type: "PHONE_TO_GAME_PACKET",
      gamePacket: {
        type: "CLIENT_ACTION",
        clientAction: { type: "START_CONNECTED_SESSION", athleteId: this.athleteId }
      }
    });
  }

  async sendCommand(command) {
    if (!this.socket) throw new Error("Zwift game is not connected");
    const message = this.CompanionToGame.fromObject({
      athleteId: this.athleteId,
      seqno: this.messageSeq++,
      commands: [{ ...command, seqno: this.commandSeq++ }]
    });
    const body = Buffer.from(this.CompanionToGame.encode(message).finish());
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(body.length);
    await new Promise((resolve, reject) => {
      this.socket.write(Buffer.concat([header, body]), error => error ? reject(error) : resolve());
    });
  }

  async close() {
    this.socket?.destroy();
    if (this.server) await new Promise(resolve => this.server.close(resolve));
  }
}

export function normalizeCompanionMessage(message, receivedAtMs = Date.now()) {
  const state = message.playerState;
  const world = WORLD_METADATA[state.courseId];
  const slopeScale = state.portal ? 1 : (world?.physicsSlopeScale ?? 1);
  const altitudeM = state.z == null ? null : state.portal
    ? (state.z / 100) * slopeScale
    : ((state.z - (world?.seaLevel ?? 0) + (world?.elevationOffset ?? 0)) / 100) * slopeScale;
  return {
    receivedAtMs,
    receivedAt: new Date(receivedAtMs).toISOString(),
    athleteId: number(state.athleteId ?? message.athleteId),
    worldTimeMs: number(state.worldTime ?? message.worldTime),
    elapsedRideSec: number(state.time),
    powerW: number(state.power),
    heartRateBpm: positiveOrNull(state.heartrate),
    cadenceRpm: state.cadenceUHz == null ? null : Math.round((state.cadenceUHz * 60) / 1_000_000),
    speedKmh: state.speedUph == null ? null : state.speedUph / 1_000_000,
    distanceM: number(state.distance),
    ascentM: number(state.climbing),
    altitudeM,
    rawZ: number(state.z),
    zwiftGrade: number(message.grade),
    courseId: number(state.courseId),
    routeId: positiveOrNull(state.routeId),
    routeCheckpointIndex: number(state.routeCheckpointIndex),
    routeDecisionIndex: number(state.routeDecisionIndex),
    roadTime: number(state.roadTime),
    lap: number(state.laps),
    eventDistanceM: state.eventDistanceCm == null ? null : state.eventDistanceCm / 100,
    x: number(state.x),
    y: number(state.y),
    portal: Boolean(state.portal)
  };
}

// PlayerState z uses world-specific physics units. Unknown future courses retain rawZ and can be
// rejected instead of silently producing a false altitude.
const WORLD_METADATA = {
  2:  { physicsSlopeScale: 1,    seaLevel: 9000,  elevationOffset: 0 },
  6:  { physicsSlopeScale: 0.5,  seaLevel: 9000,  elevationOffset: 0 },
  7:  { physicsSlopeScale: 1,    seaLevel: 9000,  elevationOffset: 0 },
  8:  { physicsSlopeScale: 0.75, seaLevel: 2000,  elevationOffset: 0 },
  9:  { physicsSlopeScale: 1,    seaLevel: 9000,  elevationOffset: 22527.800781 },
  10: { physicsSlopeScale: 1,    seaLevel: 9000,  elevationOffset: 22527.8 },
  11: { physicsSlopeScale: 1,    seaLevel: 9000,  elevationOffset: 0 },
  12: { physicsSlopeScale: 1,    seaLevel: 9000,  elevationOffset: 0 },
  13: { physicsSlopeScale: 1,    seaLevel: 15000, elevationOffset: 0 },
  14: { physicsSlopeScale: 1,    seaLevel: 9000,  elevationOffset: 0 },
  15: { physicsSlopeScale: 0.5,  seaLevel: 9000,  elevationOffset: 0 },
  16: { physicsSlopeScale: 0.5,  seaLevel: 17422, elevationOffset: 0 },
  17: { physicsSlopeScale: 0.5,  seaLevel: 8000,  elevationOffset: 0 }
};

export class CompanionFrameDecoder {
  constructor(type) {
    this.type = type;
    this.pending = Buffer.alloc(0);
  }

  push(chunk) {
    this.pending = Buffer.concat([this.pending, chunk]);
    const output = [];
    while (this.pending.length >= 4) {
      const length = this.pending.readUInt32BE(0);
      if (this.pending.length < length + 4) break;
      output.push(this.type.decode(this.pending.subarray(4, length + 4)));
      this.pending = this.pending.subarray(length + 4);
    }
    return output;
  }
}

function number(value) {
  return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
}

function positiveOrNull(value) {
  const parsed = number(value);
  return parsed && parsed > 0 ? parsed : null;
}

