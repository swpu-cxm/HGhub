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

console.log("media_download gate: fixture + real-network integration tests passed.");