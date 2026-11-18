import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argsKt = join(root, "src-tauri/android/AppUpdateInvokeArgs.kt");
const pluginKt = join(root, "src-tauri/android/AppUpdatePlugin.kt");

const argsSrc = readFileSync(argsKt, "utf8");
assert.match(argsSrc, /@InvokeArg/);
assert.match(argsSrc, /class ApkPathArgs/);
assert.match(argsSrc, /@Keep/);
assert.doesNotMatch(argsSrc, /private class InstallArgs/);
const pluginSrc = readFileSync(pluginKt, "utf8");
assert.match(pluginSrc, /parseArgs\(ApkPathArgs::class\.java\)/);
assert.match(pluginSrc, /AppUpdateSigningPolicy/);

const gen = join(root, "src-tauri/gen/android");
const gradlew = join(gen, "gradlew");
if (!existsSync(gradlew)) {
  console.warn("skip: gen/android 未初始化，仅完成源码契约检查");
  process.exit(0);
}

spawnSync("node", ["scripts/sync-android-network.mjs"], { cwd: root, stdio: "inherit" });
const run = spawnSync("./gradlew", [":app:testUniversalReleaseUnitTest", "--tests", "com.hghub.player.AppUpdateArgsDeserTest"], {
  cwd: gen,
  stdio: "inherit",
});
if (run.status !== 0) process.exit(run.status ?? 1);
console.log("AppUpdate ApkPathArgs: production Jackson 反序列化单测通过");