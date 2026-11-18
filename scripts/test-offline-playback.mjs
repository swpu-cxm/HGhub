import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function offlinePlaybackFormat(kind) {
  return kind === "hlsMpegTs" ? "hls" : "progressive";
}
assert.equal(offlinePlaybackFormat("hlsMpegTs"), "hls");
assert.equal(offlinePlaybackFormat("hlsFmp4"), "progressive");
assert.equal(offlinePlaybackFormat("progressiveMp4"), "progressive");

const cache = readFileSync(join(root, "src/plugins/LibraryCachePanel.tsx"), "utf8");
assert.doesNotMatch(cache, /window\.location/);
assert.match(cache, /kind:\s*"offlinePlay"/);

const video = readFileSync(join(root, "src/components/VideoSurface.tsx"), "utf8");
assert.match(video, /localFile/);
assert.match(video, /offlineHlsPlaybackPath/);
assert.doesNotMatch(video, /localFile\s*\?\s*"native"/);

const lib = readFileSync(join(root, "src/plugins/LibraryPage.tsx"), "utf8");
assert.match(lib, /缓存/);
assert.match(lib, /LibraryCachePanel/);

const net = readFileSync(join(root, "src-tauri/android/network_security_config.xml"), "utf8");
assert.match(net, /asset\.localhost/);
assert.match(net, /cleartextTrafficPermitted="false"/);

const media = spawnSync(
  "cargo",
  [
    "test",
    "--manifest-path",
    "src-tauri/crates/hpp/Cargo.toml",
    "--test",
    "media_download",
    "mpegts_hls_offline_package",
    "--",
    "--test-threads=2",
  ],
  { stdio: "inherit", cwd: root },
);
if (media.status !== 0) process.exit(media.status ?? 1);

console.log("offline playback gate: UI wiring + TS fixture + local HLS package tests passed.");