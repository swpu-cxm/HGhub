#!/usr/bin/env node
/**
 * 下载生产 Release arm64 APK，校验 ZIP/SHA/size 与 aapt 包名/证书/versionCode。
 * 不启动系统安装器（无设备/模拟器时到此为止）。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TAG = process.env.HGHUB_UPDATE_TAG || "v0.0.5.4-swpu-install-test";
const APK =
  process.env.HGHUB_UPDATE_APK_URL ||
  `https://github.com/swpu-cxm/HGhub/releases/download/${TAG}/HGhub_0.0.5.4-swpu-install-test_arm64.apk`;

const response = await fetch(APK, {
  headers: {
    Accept: "application/octet-stream",
    "User-Agent": "HGhub-Android-Updater-Test/1.0",
  },
});
assert.equal(response.ok, true, `HTTP ${response.status} for ${APK}`);
const bytes = Buffer.from(await response.arrayBuffer());
assert.ok(bytes.length > 512 * 1024, `APK too small: ${bytes.length}`);
assert.equal(bytes[0], 0x50);
assert.equal(bytes[1], 0x4b);

const sha = createHash("sha256").update(bytes).digest("hex");
console.log(`download ok: ${(bytes.length / 1024 / 1024).toFixed(2)} MiB sha256=${sha}`);

const dir = await mkdtemp(join(tmpdir(), "hghub-apk-"));
const file = join(dir, "update.apk");
await writeFile(file, bytes);

const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
if (sdk) {
  const bt = spawnSync("bash", ["-c", `ls ${sdk}/build-tools | sort -V | tail -1`], { encoding: "utf8" }).stdout.trim();
  const aapt = join(sdk, "build-tools", bt, "aapt");
  const out = spawnSync(aapt, ["dump", "badging", file], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /package: name='com\.hghub\.player'/);
  assert.match(out.stdout, /versionCode='\d+'/);
  const certs = spawnSync(join(sdk, "build-tools", bt, "apksigner"), ["verify", "--print-certs", file], {
    encoding: "utf8",
  });
  assert.equal(certs.status, 0, certs.stderr);
  assert.match(
    certs.stdout.replace(/:/g, "").toUpperCase(),
    /854CC868DFED17FA1D902B60C3C7B6ACD2CEDA6D238539E6639C5144412255AD/,
    "certificate fingerprint",
  );
  console.log("aapt/apksigner package + cert ok");
} else {
  console.warn("ANDROID_SDK_ROOT 未设置，跳过 aapt/apksigner");
}

const kotlin = spawnSync("rg", ["-l", "FLAG_ACTIVITY_NEW_TASK", "src-tauri/android/AppUpdatePlugin.kt"], { encoding: "utf8" });
assert.notEqual(kotlin.status, 0, "AppUpdatePlugin must not use FLAG_ACTIVITY_NEW_TASK for install");

await rm(dir, { recursive: true, force: true });
console.log("app update apk gate passed");