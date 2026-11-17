import { spawnSync } from "node:child_process";

const cargo = spawnSync(
  "cargo",
  ["test", "--manifest-path", "src-tauri/crates/hpp/Cargo.toml", "--test", "media_download", "--", "--test-threads=2"],
  { stdio: "inherit", env: process.env },
);
if (cargo.status !== 0) process.exit(cargo.status ?? 1);

console.log("media_download gate: local fixture tests passed (ffprobe validation when available).");