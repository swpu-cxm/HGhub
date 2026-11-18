import { invoke } from "@tauri-apps/api/core";
import type { AppRelease } from "./appUpdates";

export type AppUpdateStage =
  | "idle"
  | "checking"
  | "candidate"
  | "need_permission"
  | "downloading"
  | "verifying"
  | "ready"
  | "launching_installer"
  | "installer_opened"
  | "failed";

export type PersistedAppUpdate = {
  tag: string;
  apkUrl: string;
  apkSha256?: string;
  apkName?: string;
  url: string;
  localPath?: string;
  inspectedVersionCode?: number;
  inspectedVersionName?: string;
  savedAt: number;
};

const PENDING_KEY = "hpp.pendingAppUpdate.v2";
const LEGACY_KEY = "hpp.pendingAppUpdate";

export function releaseSnapshot(
  release: AppRelease,
): Pick<PersistedAppUpdate, "tag" | "apkUrl" | "apkSha256" | "apkName" | "url"> {
  return {
    tag: release.tag,
    apkUrl: release.apkUrl!,
    apkSha256: release.apkSha256,
    apkName: release.apkName,
    url: release.url,
  };
}

export function readPendingUpdate(): PersistedAppUpdate | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (raw) return JSON.parse(raw) as PersistedAppUpdate;
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (!legacy) return null;
    const old = JSON.parse(legacy) as { release: AppRelease; localPath?: string; savedAt: number };
    const migrated: PersistedAppUpdate = {
      tag: old.release.tag,
      apkUrl: old.release.apkUrl ?? "",
      apkSha256: old.release.apkSha256,
      apkName: old.release.apkName,
      url: old.release.url,
      localPath: old.localPath,
      savedAt: old.savedAt,
    };
    savePendingUpdate(migrated);
    localStorage.removeItem(LEGACY_KEY);
    return migrated;
  } catch {
    return null;
  }
}

export function savePendingUpdate(pending: PersistedAppUpdate | null) {
  try {
    if (!pending) localStorage.removeItem(PENDING_KEY);
    else localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch { /* quota */ }
}

export async function discardStaleDownloads(keepPath?: string | null) {
  try {
    await invoke<number>("app_update_discard_downloads", { keep: keepPath ?? null });
  } catch {
    /* non-android */
  }
}

/** 新候选与持久化 pending 不一致时清除旧包与本地状态（避免 0.0.6.0 标签 + 陈旧路径）。 */
export async function reconcilePendingWithCandidate(
  candidate: AppRelease | null,
  opts: { clearOnNoUpdate?: boolean } = {},
) {
  const pending = readPendingUpdate();
  if (!pending) return;
  const same =
    candidate?.available &&
    candidate.tag === pending.tag &&
    (!candidate.apkUrl || candidate.apkUrl === pending.apkUrl);
  if (same) return;
  if (!candidate?.available && !opts.clearOnNoUpdate) return;
  await discardStaleDownloads(null);
  savePendingUpdate(null);
}

export function stageLabel(stage: AppUpdateStage, detail = ""): string {
  const base: Record<AppUpdateStage, string> = {
    idle: "",
    checking: "正在检查更新…",
    candidate: "发现新版本",
    need_permission: "需要允许安装未知应用",
    downloading: "正在下载安装包…",
    verifying: "正在校验安装包…",
    ready: "安装包已就绪",
    launching_installer: "正在打开系统安装程序…",
    installer_opened: "已打开系统安装程序，请在系统界面点安装确认",
    failed: detail || "更新失败",
  };
  return base[stage];
}