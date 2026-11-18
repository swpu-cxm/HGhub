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

const downloads = readFileSync(join(root, "src/plugins/DownloadsPage.tsx"), "utf8");
assert.doesNotMatch(downloads, /window\.location/);
assert.match(downloads, /kind:\s*"offlinePlay"/);

const video = readFileSync(join(root, "src/components/VideoSurface.tsx"), "utf8");
assert.match(video, /localFile/);

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