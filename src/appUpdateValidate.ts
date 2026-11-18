import { invoke } from "@tauri-apps/api/core";
import type { AppRelease } from "./appUpdates";
import { compareVersions } from "./appUpdates";
import { savePendingUpdate } from "./appUpdateInstall";

export type ApkBuildMeta = {
  packageName: string;
  versionName: string;
  versionCode: number;
  apkBytes?: number;
};

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
  if (compareVersions(apk.versionName, currentVersion) <= 0) {
    savePendingUpdate(null);
    throw new Error(
      `安装包版本 ${apk.versionName} 未高于当前 ${currentVersion}（目标 ${target.tag}）`,
    );
  }
  return apk;
}