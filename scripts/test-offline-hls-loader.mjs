import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const loader = readFileSync(join(root, "src/plugins/offlineHlsLoader.ts"), "utf8");
assert.match(loader, /offlineHlsRead/);
assert.match(loader, /hghub-offline:\/\//);
assert.match(loader, /OFFLINE_HLS_REMOTE_BLOCKED/);
assert.match(loader, /OFFLINE_IPC_LOADER/);

const offline = readFileSync(join(root, "src/plugins/offlinePlayback.ts"), "utf8");
assert.match(offline, /offlineHlsManifestUrl/);
assert.match(offline, /offlineDownloadId/);

function cargoTest(args) {
  const run = spawnSync("cargo", args, { cwd: root, stdio: "inherit" });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
const manifest = "src-tauri/crates/hpp/Cargo.toml";
cargoTest(["test", "--manifest-path", manifest, "offline_resource_name_rejects", "--", "--test-threads=2"]);
cargoTest([
  "test",
  "--manifest-path",
  manifest,
  "--test",
  "media_download",
  "mpegts_hls_offline_package",
  "--",
  "--test-threads=2",
]);

console.log("offline HLS IPC loader gate: TS wiring + Rust package reads passed.");