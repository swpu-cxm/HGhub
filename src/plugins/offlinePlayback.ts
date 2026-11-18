import { convertFileSrc } from "@tauri-apps/api/core";
import type { PreparedMedia } from "./client";
import { offlineHlsManifestUrl } from "./offlineHlsLoader";

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
  const hlsTs = kind === "hlsMpegTs";
  return {
    sessionId: `offline:${downloadId}`,
    url: hlsTs ? offlineHlsManifestUrl(downloadId) : convertFileSrc(localPath),
    format,
    providerId: "offline",
    localFile: true,
    offlineDownloadId: hlsTs ? downloadId : undefined,
    playback: {},
    choices: {
      source: { pluginId: "offline", servers: [], streamIndex: 0, streams: [] },
    },
  };
}