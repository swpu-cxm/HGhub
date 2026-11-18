import { spawnSync } from "node:child_process";

const local = spawnSync(
  "cargo",
  ["test", "--manifest-path", "src-tauri/crates/hpp/Cargo.toml", "--test", "media_download", "--", "--test-threads=2"],
  { stdio: "inherit", env: process.env },
);
if (local.status !== 0) process.exit(local.status ?? 1);

const network = spawnSync(
  "cargo",
  ["test", "--manifest-path", "src-tauri/crates/hpp/Cargo.toml", "--test", "media_download", "--", "--ignored", "--test-threads=1"],
  { stdio: "inherit", env: process.env },
);
if (network.status !== 0) process.exit(network.status ?? 1);

const huangguo = spawnSync(
  "cargo",
  [
    "test",
    "--manifest-path",
    "src-tauri/crates/hpp/Cargo.toml",
    "--test",
    "huangguo_cache",
    "--",
    "--ignored",
    "--test-threads=1",
    "--nocapture",
  ],
  { stdio: "inherit", env: process.env },
);
if (huangguo.status !== 0) process.exit(huangguo.status ?? 1);

const offlinePlay = spawnSync("node", ["scripts/test-offline-playback.mjs"], { stdio: "inherit", env: process.env });
if (offlinePlay.status !== 0) process.exit(offlinePlay.status ?? 1);

console.log("media_download gate: fixture + real-network + 黄果琼明神女录缓存集成测试通过。");