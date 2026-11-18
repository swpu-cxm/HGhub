import type { AppRelease } from "./appUpdates";

export type AppUpdateStage =
  | "idle"
  | "need_permission"
  | "downloading"
  | "verifying"
  | "launching_installer"
  | "installer_opened"
  | "failed";

export type PendingAppUpdate = {
  release: Pick<AppRelease, "tag" | "apkUrl" | "apkSha256" | "apkName" | "url">;
  localPath?: string;
  savedAt: number;
};

const PENDING_KEY = "hpp.pendingAppUpdate";

export function readPendingUpdate(): PendingAppUpdate | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PendingAppUpdate;
  } catch {
    return null;
  }
}

export function savePendingUpdate(pending: PendingAppUpdate | null) {
  try {
    if (!pending) localStorage.removeItem(PENDING_KEY);
    else localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch { /* quota */ }
}

export function stageLabel(stage: AppUpdateStage, detail = ""): string {
  const base: Record<AppUpdateStage, string> = {
    idle: "",
    need_permission: "需要允许安装未知应用，已打开系统设置",
    downloading: "正在下载安装包…",
    verifying: "正在校验安装包…",
    launching_installer: "正在打开系统安装程序…",
    installer_opened: "已打开系统安装程序，请在系统界面点安装确认",
    failed: detail || "更新失败",
  };
  return base[stage];
}