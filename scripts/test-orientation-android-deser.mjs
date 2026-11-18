import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const orientationKt = join(root, "src-tauri/android/OrientationPlugin.kt");
const libRs = join(root, "src-tauri/src/lib.rs");

const orientationSrc = readFileSync(orientationKt, "utf8");
assert.match(orientationSrc, /@InvokeArg/);
assert.match(orientationSrc, /class OrientationArgs/);
assert.match(orientationSrc, /@JvmField var landscape/);

const libSrc = readFileSync(libRs, "utf8");
assert.match(libSrc, /::new\("orientation"\)/);
assert.match(libSrc, /::new\("app-update"\)/);
assert.match(libSrc, /OrientationPlugin/);
assert.match(libSrc, /AppUpdatePlugin/);
const appUpdateBlock = libSrc.split('::new("app-update")')[1] ?? "";
assert.doesNotMatch(appUpdateBlock.split("::new(")[0] ?? "", /OrientationPlugin/);

const gen = join(root, "src-tauri/gen/android");
const gradlew = join(gen, "gradlew");
if (!existsSync(gradlew)) {
  console.warn("skip: gen/android 未初始化，仅完成源码契约检查");
  process.exit(0);
}

spawnSync("node", ["scripts/sync-android-network.mjs"], { cwd: root, stdio: "inherit" });
const run = spawnSync(
  "./gradlew",
  [":app:testUniversalReleaseUnitTest", "--tests", "com.hghub.player.OrientationArgsDeserTest"],
  { cwd: gen, stdio: "inherit" },
);
if (run.status !== 0) process.exit(run.status ?? 1);
console.log("OrientationArgs: production Jackson 反序列化单测通过");