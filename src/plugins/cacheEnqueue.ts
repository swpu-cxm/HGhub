import { invoke } from "@tauri-apps/api/core";
import { detachedPluginCall } from "./pluginDetachedCall";
import type { MediaDetail } from "./protocol";
import type { Episode } from "./protocol";
import type { PlaybackSelection } from "./playbackSelection";
import { workCatalogKey } from "./cacheApi";

async function posterToBase64(poster?: string): Promise<string | undefined> {
  if (!poster) return undefined;
  try {
    const res = await fetch(poster);
    if (!res.ok) return undefined;
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  } catch {
    return undefined;
  }
}

export async function upsertWorkMetaFromDetail(
  pluginId: string,
  mediaId: string,
  detail: MediaDetail,
  pluginName: string,
) {
  await invoke("download_manage", {
    action: "upsertWorkMeta",
    params: {
      pluginId,
      mediaId,
      title: detail.title,
      pluginName,
      year: detail.year,
      episodeCount: detail.episodeCount,
      description: detail.description,
      score: detail.score,
      tags: detail.tags,
    },
  });
}

export async function persistTaskCover(taskId: string, poster?: string) {
  const dataBase64 = await posterToBase64(poster);
  if (!dataBase64) return;
  await invoke("download_manage", {
    action: "attachCoverData",
    params: { id: taskId, dataBase64 },
  });
}

export type EnqueueEpisodeInput = {
  pluginId: string;
  mediaId: string;
  detail: MediaDetail;
  pluginName: string;
  ep: Episode;
  playlistId?: string;
  selection: PlaybackSelection;
  poster?: string;
  /** 批量模式下元数据已在批次开头写入 */
  skipWorkMeta?: boolean;
  /** 批量模式下封面只持久化一次 */
  skipCover?: boolean;
};

export async function enqueueEpisodeCache(input: EnqueueEpisodeInput): Promise<{ id: string; created: boolean }> {
  const playback = await detachedPluginCall<{ streams: { url: string; format?: string; headers?: Record<string, string> }[] }>({
    id: input.pluginId,
    method: "media.resolvePlayback",
    args: {
      mediaId: input.mediaId,
      playlistId: input.playlistId,
      episodeId: input.ep.id,
      serverId: input.selection.serverId,
      streamIndex: input.selection.streamIndex,
      resolverId: input.selection.resolverId,
      resolverStreamIndex: input.selection.resolverStreamIndex,
      resolverServers: input.selection.resolverServers,
    },
  });
  const pick = playback.streams[input.selection.streamIndex] || playback.streams[0];
  if (!pick?.url) throw new Error("没有可缓存的播放地址");
  if (pick.format && pick.format !== "progressive" && pick.format !== "hls") {
    throw new Error("该播放流格式暂不支持离线缓存");
  }
  if (!input.skipWorkMeta) {
    await upsertWorkMetaFromDetail(input.pluginId, input.mediaId, input.detail, input.pluginName);
  }
  const created = await invoke<{ id: string }>("download_manage", {
    action: "enqueue",
    params: {
      title: input.detail.title,
      episodeLabel: input.ep.label || `第 ${input.ep.index} 集`,
      sourceUrl: pick.url,
      headers: pick.headers || {},
      mediaFormat: pick.format,
      pluginId: input.pluginId,
      mediaId: input.mediaId,
      episodeId: input.ep.id,
      episodeIndex: input.ep.index,
      episodeCount: input.detail.episodeCount,
      coverUrl: input.poster?.startsWith("http") ? input.poster : undefined,
    },
  });
  if (input.poster && !input.skipCover) {
    try {
      await persistTaskCover(created.id, input.poster);
    } catch {
      /* 封面失败不阻断下载 */
    }
  }
  return { id: created.id, created: true };
}

export type BatchEnqueueInput = Omit<EnqueueEpisodeInput, "ep" | "skipWorkMeta" | "skipCover">;

export async function enqueueEpisodeBatch(
  episodes: Episode[],
  input: BatchEnqueueInput,
): Promise<{ enqueued: number; skipped: number; errors: string[] }> {
  let enqueued = 0;
  let skipped = 0;
  const errors: string[] = [];
  try {
    await upsertWorkMetaFromDetail(input.pluginId, input.mediaId, input.detail, input.pluginName);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    errors.push(`作品元数据: ${message}`);
  }
  let coverDone = false;
  for (const ep of episodes) {
    if (ep.locked) {
      skipped++;
      continue;
    }
    try {
      await enqueueEpisodeCache({
        ...input,
        ep,
        skipWorkMeta: true,
        skipCover: coverDone,
      });
      coverDone = true;
      enqueued++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes("已有") || message.includes("相同")) {
        skipped++;
      } else {
        errors.push(`${ep.label || ep.index}: ${message}`);
      }
    }
  }
  return { enqueued, skipped, errors };
}