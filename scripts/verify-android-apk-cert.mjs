import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const identityPath = join(root, "android-signing/signing-identity.json");

function normalizeFingerprint(raw) {
  return String(raw)
    .toUpperCase()
    .replace(/[^A-F0-9]/g, "")
    .replace(/(.{2})(?=.)/g, "$1:");
}

function fingerprintFromApk(apkPath, apksigner) {
  const out = execFileSync(apksigner, ["verify", "--print-certs", apkPath], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  const m = out.match(/Signer #1 certificate SHA-256 digest:\s*([0-9a-f:]+)/i);
  if (!m) throw new Error(`无法在 apksigner 输出中解析 SHA-256：${apkPath}`);
  return normalizeFingerprint(m[1]);
}

const identity = JSON.parse(readFileSync(identityPath, "utf8"));
const expected = normalizeFingerprint(identity.sha256Fingerprint);
const apksigner = process.env.APKSIGNER || "apksigner";
const apks = process.argv.slice(2).filter((p) => p.endsWith(".apk"));
if (apks.length === 0) {
  console.error("用法: verify-android-apk-cert.mjs <apk> [more.apk ...]");
  process.exit(1);
}

let failed = 0;
for (const apk of apks) {
  if (!existsSync(apk)) {
    console.error(`缺少文件: ${apk}`);
    failed++;
    continue;
  }
  const got = fingerprintFromApk(apk, apksigner);
  if (got !== expected) {
    console.error(`证书指纹不匹配 ${apk}\n  期望: ${expected}\n  实际: ${got}`);
    failed++;
  } else {
    console.log(`OK ${apk} SHA-256 ${got}`);
  }
}
if (failed) process.exit(1);
console.log("All APK certificates match signing-identity.json");