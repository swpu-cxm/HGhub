import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function sdkBuildTools() {
  const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
  if (!sdk) throw new Error("ANDROID_SDK_ROOT 未设置");
  const bt = execFileSync("ls", [`${sdk}/build-tools`], { encoding: "utf8" })
    .trim()
    .split("\n")
    .sort()
    .at(-1);
  return join(sdk, "build-tools", bt, "aapt");
}

function badging(apkPath) {
  const aapt = sdkBuildTools();
  const out = execFileSync(aapt, ["dump", "badging", apkPath], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const pkg = out.match(/package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/);
  assert.ok(pkg, `aapt badging 无效: ${apkPath}`);
  const abi = out.match(/native-code: '([^']+)'/);
  return {
    packageName: pkg[1],
    versionCode: Number(pkg[2]),
    versionName: pkg[3],
    nativeCode: abi ? abi[1].split("' '") : [],
  };
}

function apkContainsMarker(apkPath, marker) {
  const list = spawnSync("unzip", ["-Z1", apkPath], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const targets = (list.stdout?.split("\n") ?? []).filter(
    n =>
      n &&
      (/lib\/[^/]+\/.*\.so$/i.test(n) ||
        /classes\.dex$/i.test(n) ||
        /assets\/.*\.(js|css)$/i.test(n)),
  );
  for (const name of targets) {
    const raw = spawnSync("unzip", ["-p", apkPath, name], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
    if (raw.status === 0 && raw.stdout?.includes(Buffer.from(marker))) return true;
  }
  return false;
}

export async function verifyApkMetadata(apkPath, expected) {
  const {
    versionCode,
    versionName,
    packageName = "com.hghub.player",
    markers = ["OFFLINE_IPC_LOADER", "hghub-offline", "OFFLINE_HLS_FORBIDDEN", "app_update_inspect_apk"],
    requireArm64 = true,
  } = expected;
  const meta = badging(apkPath);
  assert.equal(meta.packageName, packageName, `包名应为 ${packageName}`);
  assert.equal(meta.versionCode, versionCode, `versionCode 应为 ${versionCode}，实际 ${meta.versionCode}`);
  assert.equal(meta.versionName, versionName, `versionName 应为 ${versionName}，实际 ${meta.versionName}`);
  if (requireArm64) {
    assert.ok(
      meta.nativeCode.some(a => /arm64|aarch64/i.test(a)),
      `应包含 arm64 ABI，实际: ${meta.nativeCode.join(",") || "(无 native-code)"}`,
    );
  }
  for (const m of markers) {
    assert.ok(apkContainsMarker(apkPath, m), `APK 内未找到构建标记 "${m}"，可能未编入本次前端`);
  }
  return meta;
}

if (process.argv[1]?.endsWith("verify-android-apk-metadata.mjs")) {
  const apk = process.argv[2];
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const versionName = process.argv[3] || pkg.version;
  const versionCode = Number(process.argv[4] || pkg.androidVersionCode);
  await verifyApkMetadata(apk, { versionCode, versionName });
  console.log(`apk metadata OK: ${apk} vc=${versionCode} vn=${versionName}`);
}