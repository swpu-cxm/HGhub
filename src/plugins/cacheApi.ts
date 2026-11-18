import { invoke } from "@tauri-apps/api/core";
import type { DownloadTask } from "./libraryCache";

export type WorkCacheMeta = {
  pluginId: string;
  mediaId: string;
  title: string;
  pluginName?: string;
  year?: number;
  episodeCount?: number;
  description?: string;
  score?: number;
  tags?: string[];
  coverRel?: string;
  updatedAt?: number;
};

export type DownloadCatalog = {
  tasks: DownloadTask[];
  works: Record<string, WorkCacheMeta>;
  workCovers: Record<string, string>;
};

export function workCatalogKey(pluginId: string, mediaId: string) {
  return `${pluginId}\u001f${mediaId}`;
}

export async function fetchDownloadCatalog(): Promise<DownloadCatalog> {
  const raw = await invoke<DownloadCatalog | DownloadTask[]>("download_manage", { action: "list", params: {} });
  if (Array.isArray(raw)) return { tasks: raw, works: {}, workCovers: {} };
  return {
    tasks: raw.tasks ?? [],
    works: raw.works ?? {},
    workCovers: raw.workCovers ?? {},
  };
}