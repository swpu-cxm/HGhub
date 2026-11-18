import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IBack } from "../icons";
import { useStore } from "../store";
import VideoSurface, { type VideoHandle } from "../components/VideoSurface";
import { buildOfflinePreparedMedia, type OfflineDownloadKind } from "./offlinePlayback";
import type { PreparedMedia } from "./client";
import { Notice } from "./BrowsePages";

type Props = {
  downloadId: string;
  title: string;
  episodeLabel?: string;
  kind: OfflineDownloadKind;
  onBack: () => void;
};

export default function OfflinePlaybackPage({ downloadId, title, episodeLabel, kind, onBack }: Props) {
  const app = useStore();
  const videoRef = useRef<VideoHandle>(null);
  const [media, setMedia] = useState<PreparedMedia | null>(null);
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<"loading" | "playing" | "paused">("loading");
  const position = useRef(0);

  useEffect(() => {
    app.setWatching(true);
    return () => app.setWatching(false);
  }, [app]);

  useEffect(() => {
    let live = true;
    void (async () => {
      setError("");
      try {
        const path = await invoke<string>("download_manage", { action: "localPath", params: { id: downloadId } });
        if (!live) return;
        setMedia(buildOfflinePreparedMedia(downloadId, path, kind));
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "无法准备离线播放");
      }
    })();
    return () => { live = false; };
  }, [downloadId, kind]);

  return (
    <div className="absolute inset-0 z-40 bg-black flex flex-col">
      <header className="flex items-center gap-3 px-4 py-3 text-white" style={{ paddingTop: "max(12px, var(--sat, 0px))" }}>
        <button type="button" aria-label="返回缓存管理" onClick={onBack}><IBack size={20}/></button>
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-sm">{title}</strong>
          {episodeLabel && <span className="text-xs text-white/70">{episodeLabel}</span>}
        </div>
      </header>
      <Notice error={error}/>
      <div className="relative flex-1 min-h-0 bg-black">
        {media && !error ? (
          <>
            <VideoSurface
              ref={videoRef}
              media={media}
              position={position.current}
              active
              autoPlay
              muted={app.muted}
              volume={app.volume}
              rate={1}
              fit="contain"
              scale={1}
              panX={0}
              panY={0}
              isGesturing={false}
              onClick={() => videoRef.current?.toggle()}
              onTime={t => { position.current = t; }}
              onDuration={() => {}}
              onSize={() => {}}
              onPlaying={() => { setPhase("playing"); setError(""); }}
              onPause={() => setPhase("paused")}
              onWaiting={() => setPhase("loading")}
              onBuffered={() => {}}
              onError={() => setError(kind === "hlsMpegTs"
                ? "离线 HLS 无法播放。请确认缓存包完整（清单、分片与 aes128.key）；若仍失败请反馈。"
                : "离线视频无法播放，请确认文件未损坏。")}
            />
            {phase === "loading" && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-9 h-9 spinner" role="status" aria-label="正在加载离线视频"/>
              </div>
            )}
          </>
        ) : !error ? (
          <p className="text-center text-white/60 text-sm mt-12">正在打开离线文件…</p>
        ) : null}
      </div>
    </div>
  );
}