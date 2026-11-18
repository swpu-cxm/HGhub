import { convertFileSrc } from "@tauri-apps/api/core";
import type { OfflineDownloadKind } from "./offlinePlayback";
import type { WorkCacheMeta } from "./cacheApi";
import { workCatalogKey } from "./cacheApi";

export type DownloadTask = {
  id: string;
  title: string;
  episodeLabel?: string;
  kind: OfflineDownloadKind;
  state: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
  bytesDone: number;
  bytesTotal?: number;
  speedBps: number;
  error?: string;
  pluginId?: string;
  mediaId?: string;
  episodeId?: string;
  episodeIndex?: number;
  episodeCount?: number;
  coverRel?: string;
  coverLocalPath?: string;
  workCoverLocalPath?: string;
  createdAt?: number;
  updatedAt?: number;
};

export type EpisodeCacheState =
  | "none"
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed";

export function episodeCacheState(task?: DownloadTask): EpisodeCacheState {
  if (!task) return "none";
  if (task.state === "cancelled") return "none";
  return task.state;
}

export function episodeCacheStateLabel(state: EpisodeCacheState): string {
  switch (state) {
    case "none": return "未缓存";
    case "queued": return "排队";
    case "running": return "下载中";
    case "paused": return "已暂停";
    case "completed": return "已缓存";
    case "failed": return "失败";
  }
}

export function formatBytes(value: number) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let n = value, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function formatSpeed(bps: number) {
  if (bps <= 0) return "";
  return `${formatBytes(bps)}/s`;
}

export function formatEpisodeLabel(task: DownloadTask): string {
  if (task.episodeLabel?.trim()) {
    const raw = task.episodeLabel.trim();
    if (/^\d+$/.test(raw)) return `第 ${raw} 集`;
    return raw;
  }
  if (task.episodeIndex != null) return `第 ${task.episodeIndex} 集`;
  return "单集";
}

function normalizeTitle(title: string) {
  return title.trim().toLowerCase();
}

/** Client-side mirror of Rust reconcile for live lists before next restart. */
export function reconcileTasksClient(tasks: DownloadTask[]): DownloadTask[] {
  const pairsByTitle = new Map<string, Set<string>>();
  for (const task of tasks) {
    if (!task.pluginId || !task.mediaId) continue;
    const key = normalizeTitle(task.title);
    const pair = `${task.pluginId}\0${task.mediaId}`;
    if (!pairsByTitle.has(key)) pairsByTitle.set(key, new Set());
    pairsByTitle.get(key)!.add(pair);
  }
  return tasks.map(task => {
    const titleKey = normalizeTitle(task.title);
    const candidates = pairsByTitle.get(titleKey);
    if (!candidates || candidates.size !== 1) return task;
    const [pair] = [...candidates];
    const [pluginId, mediaId] = pair.split("\0");
    if (task.mediaId && task.pluginId) return task;
    return {
      ...task,
      pluginId: task.pluginId ?? pluginId,
      mediaId: task.mediaId ?? mediaId,
    };
  });
}

export function groupKey(task: DownloadTask) {
  if (task.pluginId && task.mediaId) return `${task.pluginId}:${task.mediaId}`;
  return `orphan:${task.pluginId || "local"}:${normalizeTitle(task.title)}`;
}

export type CacheGroup = {
  key: string;
  title: string;
  pluginId?: string;
  mediaId?: string;
  episodeCount?: number;
  coverSrc?: string;
  meta?: WorkCacheMeta;
  tasks: DownloadTask[];
};

export function groupDownloadTasks(
  tasks: DownloadTask[],
  works: Record<string, WorkCacheMeta> = {},
  workCovers: Record<string, string> = {},
): CacheGroup[] {
  const reconciled = reconcileTasksClient(tasks);
  const map = new Map<string, CacheGroup>();
  for (const task of reconciled) {
    const key = groupKey(task);
    let group = map.get(key);
    if (!group) {
      const metaKey = task.pluginId && task.mediaId ? workCatalogKey(task.pluginId, task.mediaId) : undefined;
      const meta = metaKey ? works[metaKey] : undefined;
      const workCover = metaKey ? workCovers[metaKey] : undefined;
      group = {
        key,
        title: meta?.title || task.title,
        pluginId: task.pluginId ?? meta?.pluginId,
        mediaId: task.mediaId ?? meta?.mediaId,
        episodeCount: meta?.episodeCount ?? task.episodeCount,
        coverSrc: workCover
          ? convertFileSrc(workCover)
          : task.workCoverLocalPath
            ? convertFileSrc(task.workCoverLocalPath)
            : task.coverLocalPath
              ? convertFileSrc(task.coverLocalPath)
              : undefined,
        meta,
        tasks: [],
      };
      map.set(key, group);
    }
    if (task.coverLocalPath && !group.coverSrc) group.coverSrc = convertFileSrc(task.coverLocalPath);
    if (task.episodeCount != null) group.episodeCount = Math.max(group.episodeCount ?? 0, task.episodeCount);
    group.tasks.push(task);
  }
  return [...map.values()].map(g => ({
    ...g,
    tasks: g.tasks.sort((a, b) => (a.episodeIndex ?? 0) - (b.episodeIndex ?? 0)),
  })).sort((a, b) => b.tasks.reduce((n, t) => Math.max(n, t.updatedAt ?? 0), 0) - a.tasks.reduce((n, t) => Math.max(n, t.updatedAt ?? 0), 0));
}

export function taskForEpisodeIndex(group: CacheGroup, index: number): DownloadTask | undefined {
  return group.tasks.find(t => t.episodeIndex === index);
}

export function kindLabel(kind: OfflineDownloadKind) {
  if (kind === "hlsFmp4") return "HLS → MP4";
  if (kind === "hlsMpegTs") return "HLS TS 离线包";
  return "MP4";
}