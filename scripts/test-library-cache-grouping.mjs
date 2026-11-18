import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

spawnSync("cargo", [
  "test",
  "--manifest-path",
  "src-tauri/crates/hpp/Cargo.toml",
  "backfills_legacy_episode_when_sibling_has_media_id",
  "--",
  "--test-threads=2",
], { stdio: "inherit", cwd: root });

const run = spawnSync("npx", ["--yes", "tsx", "src/plugins/libraryCache.test.ts"], { cwd: root, stdio: "inherit" });
if (run.status !== 0) process.exit(run.status ?? 1);

const panel = readFileSync(join(root, "src/plugins/LibraryCachePanel.tsx"), "utf8");
assert.match(panel, /CacheWorkDetailSheet/);
assert.match(panel, /fetchDownloadCatalog/);

const detail = readFileSync(join(root, "src/plugins/PluginMediaDetail.tsx"), "utf8");
assert.match(detail, /CacheBatchPanel/);
assert.match(detail, /openLibraryCacheWork/);
const enqueue = readFileSync(join(root, "src/plugins/cacheEnqueue.ts"), "utf8");
assert.match(enqueue, /skipWorkMeta/);
assert.match(enqueue, /enqueueEpisodeBatch/);
assert.doesNotMatch(detail, /await batchEnqueue\(eps\)[\s\S]*openLibraryCacheWork/s);

console.log("library cache grouping + UI wiring gate passed");