import { convertFileSrc } from "@tauri-apps/api/core";
import type { PreparedMedia } from "./client";

export type OfflineDownloadKind = "progressiveMp4" | "hlsFmp4" | "hlsMpegTs";

export function offlinePlaybackFormat(kind: OfflineDownloadKind): "hls" | "progressive" {
  return kind === "hlsMpegTs" ? "hls" : "progressive";
}

export function buildOfflinePreparedMedia(
  downloadId: string,
  localPath: string,
  kind: OfflineDownloadKind,
): PreparedMedia {
  const format = offlinePlaybackFormat(kind);
  return {
    sessionId: `offline:${downloadId}`,
    url: convertFileSrc(localPath),
    format,
    providerId: "offline",
    localFile: true,
    playback: {},
    choices: {
      source: { pluginId: "offline", servers: [], streamIndex: 0, streams: [] },
    },
  };
}