// Builds the zip a non-technical rider receives: the monitor, its dependencies, a pinned Intel Node.js and a
// double-click launcher. Run on any Mac with network access:  npm run package:mac
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NODE_VERSION = "22.23.0"; // pinned: the version this code is tested on
const NODE_TARBALL = `node-v${NODE_VERSION}-darwin-x64.tar.gz`;
const NODE_BASE = `https://nodejs.org/dist/v${NODE_VERSION}`;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const cache = join(root, ".build", "cache");
const appName = "CyclingOS Zwift Link";
const stage = join(dist, "stage", appName);
const zipPath = join(dist, "CyclingOS-Zwift-Link-Mac-Intel.zip");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status})`);
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

async function nodeTarball() {
  mkdirSync(cache, { recursive: true });
  const sums = join(cache, `SHASUMS256-${NODE_VERSION}.txt`);
  if (!existsSync(sums)) await download(`${NODE_BASE}/SHASUMS256.txt`, sums);
  const expected = readFileSync(sums, "utf8").split("\n").map(line => line.trim().split(/\s+/))
    .find(([, name]) => name === NODE_TARBALL)?.[0];
  if (!expected) throw new Error(`No checksum for ${NODE_TARBALL}`);
  const tarball = join(cache, NODE_TARBALL);
  if (!existsSync(tarball)) {
    console.log(`Downloading Node.js ${NODE_VERSION} (Intel)…`);
    await download(`${NODE_BASE}/${NODE_TARBALL}`, tarball);
  }
  const actual = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  if (actual !== expected) {
    rmSync(tarball);
    throw new Error(`Checksum mismatch for ${NODE_TARBALL}: expected ${expected}, got ${actual}`);
  }
  return tarball;
}

const tarball = await nodeTarball();

rmSync(join(dist, "stage"), { recursive: true, force: true });
rmSync(zipPath, { force: true });
mkdirSync(stage, { recursive: true });

// Program files. The tests, docs, Windows helper and Mac Bluetooth source are not needed by a rider.
for (const entry of ["src", "proto", "routes", "package.json", "package-lock.json"]) {
  cpSync(join(root, entry), join(stage, entry), { recursive: true });
}
cpSync(join(root, "mac-ble"), join(stage, "mac-ble"), { recursive: true });

if (existsSync(join(root, "routes", "imported-zwift-data.json"))) {
  console.log("Including the imported route catalogue (routes/imported-zwift-data.json).");
} else {
  console.warn("WARNING: routes/imported-zwift-data.json is missing, so riders will only get your recorded routes. Run: npm run catalog:import");
}

console.log("Installing production dependencies…");
run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--silent"], { cwd: stage });

// Node.js runtime for Intel Macs.
const extract = join(dist, "stage", "node-extract");
mkdirSync(extract, { recursive: true });
run("tar", ["-xzf", tarball, "-C", extract, "--strip-components=1"]);
mkdirSync(join(stage, "runtime"), { recursive: true });
cpSync(join(extract, "bin", "node"), join(stage, "runtime", "node"));
cpSync(join(extract, "LICENSE"), join(stage, "runtime", "LICENSE-node.txt"));
rmSync(extract, { recursive: true, force: true });
chmodSync(join(stage, "runtime", "node"), 0o755);

// Launcher, instructions, notices and version.
const launcher = join(stage, "Start Zwift Link.command");
cpSync(join(root, "packaging", "mac", "Start Zwift Link.command"), launcher);
chmodSync(launcher, 0o755);
cpSync(join(root, "packaging", "mac", "START HERE.txt"), join(stage, "START HERE.txt"));
cpSync(join(root, "THIRD_PARTY_NOTICES.md"), join(stage, "THIRD_PARTY_NOTICES.md"));
const git = spawnSync("git", ["describe", "--always", "--dirty"], { cwd: root, encoding: "utf8" });
const revision = git.status === 0 ? git.stdout.trim() : "unknown";
writeFileSync(join(stage, "VERSION"), `${revision} (${new Date().toISOString().slice(0, 10)})\n`);

run("zip", ["-qry", zipPath, appName], { cwd: join(dist, "stage") });
run("unzip", ["-tq", zipPath]);
console.log(`\nBuilt ${zipPath}\n${(statSync(zipPath).size / 1e6).toFixed(1)} MB, version ${revision}`);
