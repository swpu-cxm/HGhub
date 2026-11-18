import { invoke } from "@tauri-apps/api/core";
import type { AppRelease } from "./appUpdates";
import { compareVersions } from "./appUpdates";
import { savePendingUpdate } from "./appUpdateInstall";

export const EXPECTED_RELEASE_CERT_SHA256 =
  "85:4C:C8:68:DF:ED:17:FA:1D:90:2B:60:C3:C7:B6:AC:D2:CE:DA:6D:23:85:39:E6:63:9C:51:44:41:22:55:AD";

export type ApkBuildMeta = {
  packageName: string;
  versionName: string;
  versionCode: number;
  apkBytes?: number;
  certSha256?: string;
};

function normalizeCertSha256(value: string) {
  const raw = value.toUpperCase().replace(/[^A-F0-9]/g, "");
  return raw.match(/.{1,2}/g)?.join(":") ?? value;
}

export type InstalledBuildMeta = ApkBuildMeta & { sdkInt?: number };

export async function fetchInstalledBuildInfo(): Promise<InstalledBuildMeta> {
  return invoke<InstalledBuildMeta>("app_update_build_info");
}

export async function inspectDownloadedApk(path: string): Promise<ApkBuildMeta> {
  return invoke<ApkBuildMeta>("app_update_inspect_apk", { path });
}

export async function assertApkReadyForUpdate(
  path: string,
  target: Pick<AppRelease, "tag">,
  currentVersion: string,
): Promise<ApkBuildMeta> {
  const [apk, installed] = await Promise.all([
    inspectDownloadedApk(path),
    fetchInstalledBuildInfo(),
  ]);
  if (apk.packageName !== installed.packageName) {
    savePendingUpdate(null);
    throw new Error(
      `安装包包名 ${apk.packageName} 与当前应用 ${installed.packageName} 不一致`,
    );
  }
  if (apk.versionCode <= installed.versionCode) {
    savePendingUpdate(null);
    throw new Error(
      `安装包 versionCode=${apk.versionCode}（${apk.versionName}）不高于当前 ${installed.versionCode}（${installed.versionName}）。` +
        "可能下载了错误或过期的 Release 资产（例如与旧版字节相同）；请重新检查更新并下载。",
    );
  }
  if (apk.certSha256) {
    const got = normalizeCertSha256(apk.certSha256);
    const want = normalizeCertSha256(EXPECTED_RELEASE_CERT_SHA256);
    if (got !== want) {
      savePendingUpdate(null);
      throw new Error("安装包签名证书与 HGhub 发布证书不一致");
    }
  }
  if (compareVersions(apk.versionName, currentVersion) <= 0) {
    savePendingUpdate(null);
    throw new Error(
      `安装包版本 ${apk.versionName} 未高于当前 ${currentVersion}（目标 ${target.tag}）`,
    );
  }
  return apk;
}