#!/usr/bin/env node
/**
 * 网络依赖：黄果短剧插件 → 搜索「琼明神女录」→ 第 2 集 resolvePlayback → 生产 DownloadManager 入队与下载。
 *
 * 前置：clone https://github.com/swpu-cxm/hghub-plugins 到 /tmp/hghub-plugins
 * 或设置 HGHUB_HUANGGUO_PLUGIN=/path/to/huangguo.js
 *
 * 命令：pnpm test:huangguo-cache
 */
import { spawnSync } from "node:child_process";

const run = spawnSync(
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
process.exit(run.status ?? 1);