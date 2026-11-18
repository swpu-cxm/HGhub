import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { verifyApkMetadata } from "./verify-android-apk-metadata.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const code = pkg.androidVersionCode;
const outDir = join(root, "release-out");
const buildLog = join(root, "build-logs");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const logPath = join(buildLog, `android-${version}-${stamp}.log`);

function log(msg) {
  console.log(msg);
}

function run(cmd, opts = {}) {
  log(`$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: root, ...opts });
}

mkdirSync(buildLog, { recursive: true });
const head = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
const dirty = execSync("git status --porcelain", { cwd: root, encoding: "utf8" }).trim();

const manifest = {
  version,
  versionCode: code,
  gitHead: head,
  dirty: Boolean(dirty),
  startedAt: new Date().toISOString(),
};

log(`=== HGhub Android release build ${version} (vc=${code}) @ ${head} ===`);
if (dirty) {
  console.warn("警告: 工作区有未提交改动，产物将记录 dirty=true");
}

const apkOut = join(root, "src-tauri/gen/android/app/build/outputs/apk");
if (existsSync(apkOut)) {
  log("清理旧 APK 构建输出 (outputs/apk only)");
  rmSync(apkOut, { recursive: true, force: true });
}
for (const f of [`HGhub_${version}_arm64-v8a.apk`, `HGhub_${version}_aarch64.apk`, `HGhub_${version}_universal.apk`]) {
  const p = join(outDir, f);
  if (existsSync(p)) rmSync(p);
}

run("pnpm build");
run("pnpm tauri android build");

let foundArm64 = spawnSync(
  "find",
  [join(root, "src-tauri/gen/android/app/build/outputs/apk"), "-name", "*arm64*release*unsigned.apk"],
  { encoding: "utf8" },
).stdout
  .trim()
  .split("\n")
  .find(Boolean);
if (!foundArm64) {
  foundArm64 = spawnSync(
    "find",
    [join(root, "src-tauri/gen/android/app/build/outputs/apk"), "-name", "*universal*release*unsigned.apk"],
    { encoding: "utf8" },
  ).stdout
    .trim()
    .split("\n")
    .find(Boolean);
}
if (!foundArm64) {
  console.error("未找到 arm64/universal unsigned APK");
  process.exit(1);
}
await verifyApkMetadata(foundArm64, { versionCode: code, versionName: version });
manifest.unsignedSha256 = sha256File(foundArm64);
manifest.unsignedApk = foundArm64;

run(`bash scripts/android-sign-built-apks.sh ${version}`);

const signedCandidates = [
  join(outDir, `HGhub_${version}_arm64.apk`),
  join(outDir, `HGhub_${version}_arm64-v8a.apk`),
  join(outDir, `HGhub_${version}_aarch64.apk`),
  join(outDir, `HGhub_${version}_universal.apk`),
];
const finalApk = signedCandidates.find(p => existsSync(p));
if (!existsSync(finalApk)) {
  console.error("签名后未找到 arm64 release APK");
  process.exit(1);
}
await verifyApkMetadata(finalApk, { versionCode: code, versionName: version });
manifest.signedSha256 = sha256File(finalApk);
manifest.finishedAt = new Date().toISOString();
writeFileSync(logPath, JSON.stringify(manifest, null, 2));
writeFileSync(join(outDir, `BUILD_MANIFEST_${version}.json`), JSON.stringify(manifest, null, 2));
log(`构建完成。signed sha256=${manifest.signedSha256}`);
log(`manifest: ${logPath}`);

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}