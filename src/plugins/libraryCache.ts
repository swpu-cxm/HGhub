import { convertFileSrc } from "@tauri-apps/api/core";
import type { OfflineDownloadKind } from "./offlinePlayback";

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
  createdAt?: number;
  updatedAt?: number;
};

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

export function groupKey(task: DownloadTask) {
  const media = task.mediaId || task.title;
  return `${task.pluginId || "local"}:${media}`;
}

export type CacheGroup = {
  key: string;
  title: string;
  pluginId?: string;
  mediaId?: string;
  episodeCount?: number;
  coverSrc?: string;
  tasks: DownloadTask[];
};

export function groupDownloadTasks(tasks: DownloadTask[]): CacheGroup[] {
  const map = new Map<string, CacheGroup>();
  for (const task of tasks) {
    const key = groupKey(task);
    let group = map.get(key);
    if (!group) {
      group = {
        key,
        title: task.title,
        pluginId: task.pluginId,
        mediaId: task.mediaId,
        episodeCount: task.episodeCount,
        coverSrc: task.coverLocalPath ? convertFileSrc(task.coverLocalPath) : undefined,
        tasks: [],
      };
      map.set(key, group);
    }
    if (task.coverLocalPath && !group.coverSrc) group.coverSrc = convertFileSrc(task.coverLocalPath);
    if (task.episodeCount != null) group.episodeCount = task.episodeCount;
    group.tasks.push(task);
  }
  return [...map.values()].map(g => ({
    ...g,
    tasks: g.tasks.sort((a, b) => (a.episodeIndex ?? 0) - (b.episodeIndex ?? 0)),
  })).sort((a, b) => b.tasks.reduce((n, t) => Math.max(n, t.updatedAt ?? 0), 0) - a.tasks.reduce((n, t) => Math.max(n, t.updatedAt ?? 0), 0));
}

export function kindLabel(kind: OfflineDownloadKind) {
  if (kind === "hlsFmp4") return "HLS → MP4";
  if (kind === "hlsMpegTs") return "HLS TS 离线包";
  return "MP4";
}