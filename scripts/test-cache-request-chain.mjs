#!/usr/bin/env node
import { spawnSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const cargo = spawnSync(
  "cargo",
  [
    "test",
    "--manifest-path",
    "src-tauri/crates/hpp/Cargo.toml",
    "--test",
    "cache_request_chain",
    "--",
    "--test-threads=2",
  ],
  { stdio: "inherit", cwd: root, env: process.env },
);
if (cargo.status !== 0) process.exit(cargo.status ?? 1);

const data = await mkdtemp(join(tmpdir(), "hpp-cache-chain-"));
const bin = join(
  root,
  "src-tauri/crates/hpp/target/debug/examples",
  process.platform === "win32" ? "dev_host.exe" : "dev_host",
);
spawnSync(
  "cargo",
  ["build", "--manifest-path", "src-tauri/crates/hpp/Cargo.toml", "--example", "dev_host"],
  { stdio: "inherit", cwd: root },
);

const pending = new Map();
let serial = 0;
const host = spawn(bin, [data, "--relaxed"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
const dispatch = (params) =>
  new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, { resolve, reject });
    host.stdin.write(JSON.stringify({ id, action: params.action, params: params.params }) + "\n");
  });

await new Promise((resolve, reject) => {
  host.on("error", reject);
  createInterface({ input: host.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.ready) resolve();
    else {
      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        entry.resolve(message);
      }
    }
  });
});

const pluginCode = await import("node:fs/promises").then((fs) =>
  fs.readFile(join(root, "src-tauri/crates/hpp/tests/fixtures/cache_enqueue.js"), "utf8"),
);
const imported = await dispatch({
  action: "import",
  params: { code: pluginCode },
});
assert.equal(imported.ok, true, JSON.stringify(imported));

const missing = await dispatch({
  action: "call",
  params: {
    id: "fixture.cache.enqueue",
    method: "media.resolvePlayback",
    args: { mediaId: "work", playlistId: "main", episodeId: "ep1" },
  },
});
assert.equal(missing.ok, false);
assert.match(missing.error?.message ?? "", /requestId/, missing.error);

await dispatch({
  action: "settings.set",
  params: { id: "fixture.cache.enqueue", key: "baseUrl", value: "http://127.0.0.1:9" },
});

const ok = await dispatch({
  action: "call",
  params: {
    id: "fixture.cache.enqueue",
    method: "media.resolvePlayback",
    args: { mediaId: "work", playlistId: "main", episodeId: "ep1" },
    requestId: "dev-host-bridge-001",
  },
});
assert.equal(ok.ok, true, JSON.stringify(ok));
assert.equal(
  ok.value?.streams?.[0]?.headers?.["X-Fixture-Request-Id"],
  "dev-host-bridge-001",
  JSON.stringify(ok.value),
);

host.kill();
console.log("cache request chain: Rust fixture + TS detached + dev_host IPC diagnostics passed");