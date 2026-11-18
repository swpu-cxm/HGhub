import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import PluginPlayer from "./PluginPlayer";
import { buildOfflinePreparedMedia, type OfflineDownloadKind } from "./offlinePlayback";
import type { PreparedMedia } from "./client";
import { Notice } from "./BrowsePages";
import {
  type DownloadTask,
  formatEpisodeLabel,
  groupDownloadTasks,
  groupKey,
} from "./libraryCache";
import { fetchDownloadCatalog } from "./cacheApi";
import { getOfflineProgress, setOfflineProgress } from "./offlineProgress";
import { useHost } from "./HostContext";

type Props = {
  downloadId: string;
  title: string;
  episodeLabel?: string;
  kind: OfflineDownloadKind;
  onBack: () => void;
};

export default function OfflinePlaybackPage({ downloadId, title, episodeLabel, kind, onBack }: Props) {
  const app = useStore();
  const host = useHost();
  const [media, setMedia] = useState<PreparedMedia | null>(null);
  const [error, setError] = useState("");
  const [diag, setDiag] = useState("");
  const [preparing, setPreparing] = useState(true);
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const position = useRef(getOfflineProgress(downloadId)?.positionSec ?? 0);
  const lastSave = useRef(0);
  const epoch = useRef(0);

  const task = useMemo(() => tasks.find(t => t.id === downloadId), [tasks, downloadId]);
  const groupTasks = useMemo(() => {
    if (!task) return [];
    const key = groupKey(task);
    const group = groupDownloadTasks(tasks, {}, {}).find(g => g.key === key);
    return (group?.tasks ?? []).filter(t => t.state === "completed");
  }, [tasks, task]);

  const episodeIndex = groupTasks.findIndex(t => t.id === downloadId);
  const prevTask = episodeIndex > 0 ? groupTasks[episodeIndex - 1] : undefined;
  const nextTask = episodeIndex >= 0 && episodeIndex < groupTasks.length - 1 ? groupTasks[episodeIndex + 1] : undefined;

  const openTask = useCallback(
    (t: DownloadTask) => {
      app.replace({
        kind: "offlinePlay",
        downloadId: t.id,
        title: t.title,
        episodeLabel: formatEpisodeLabel(t),
        mediaKind: t.kind,
      });
    },
    [app],
  );

  const loadTasks = useCallback(async () => {
    const catalog = await fetchDownloadCatalog();
    setTasks(catalog.tasks);
    return catalog.tasks;
  }, []);

  const prepare = useCallback(async () => {
    const n = ++epoch.current;
    setPreparing(true);
    setError("");
    setDiag("");
    try {
      await loadTasks();
      const prep = await invoke<{
        path: string;
        packageValid?: boolean;
        validateError?: string;
        segmentCount?: number;
        aes128KeyPresent?: boolean;
      }>("download_manage", { action: "preparePlayback", params: { id: downloadId } });
      const bits = [
        prep.packageValid === false && prep.validateError ? `校验: ${prep.validateError}` : null,
        prep.segmentCount != null ? `分片 ${prep.segmentCount}` : null,
        prep.aes128KeyPresent != null ? `AES-128: ${prep.aes128KeyPresent ? "ok" : "缺密钥"}` : null,
      ].filter(Boolean);
      if (bits.length) setDiag(bits.join(" · "));
      if (prep.packageValid === false) {
        throw new Error(prep.validateError || "离线包校验失败");
      }
      if (epoch.current !== n) return;
      const saved = getOfflineProgress(downloadId);
      if (saved?.positionSec) position.current = saved.positionSec;
      setMedia(buildOfflinePreparedMedia(downloadId, prep.path, kind));
    } catch (e) {
      if (epoch.current !== n) return;
      setMedia(null);
      setError(e instanceof Error ? e.message : "无法准备离线播放");
    } finally {
      if (epoch.current === n) setPreparing(false);
    }
  }, [downloadId, kind, loadTasks]);

  useEffect(() => {
    app.setWatching(true);
    return () => app.setWatching(false);
  }, [app]);

  useEffect(() => {
    void prepare();
    return () => { epoch.current++; };
  }, [prepare]);

  const episodePanel = groupTasks.length > 1 ? (
    <ul className="hpp-offline-episodes">
      {groupTasks.map(t => (
        <li key={t.id}>
          <button
            type="button"
            className={t.id === downloadId ? "is-current" : undefined}
            onClick={() => openTask(t)}
          >
            {formatEpisodeLabel(t)}
            {t.id === downloadId ? " · 播放中" : ""}
          </button>
        </li>
      ))}
    </ul>
  ) : undefined;

  const playbackError = (detail?: string) =>
    kind === "hlsMpegTs"
      ? `离线 HLS 播放失败${detail ? ` [${detail}]` : ""}。引擎: Hls.js/MSE · IPC 本地加载（非 asset XHR）。`
      : `离线视频无法播放${detail ? ` [${detail}]` : ""}`;

  return (
    <div className="absolute inset-0 z-40 bg-black">
      {diag && !error && (
        <p className="absolute top-0 left-0 right-0 z-[70] px-4 py-1 text-xs text-white/50 pointer-events-none" style={{ paddingTop: "max(4px, var(--sat, 0px))" }}>
          {diag}
        </p>
      )}
      {error && !media ? (
        <div className="p-4 pt-16">
          <Notice error={error}/>
          <button type="button" className="mt-4 text-primary" onClick={() => void prepare()}>重试</button>
        </div>
      ) : (
        <PluginPlayer
          mode="full"
          media={media}
          preparing={preparing}
          active={!preparing && !!media}
          position={position.current}
          title={title}
          episodeLabel={episodeLabel || (task ? formatEpisodeLabel(task) : "")}
          episodeCount={task?.episodeCount ?? groupTasks.length}
          poster={task?.coverLocalPath ? convertFileSrc(task.coverLocalPath) : undefined}
          panels={{
            episodes: episodePanel,
            playback: (
              <p className="text-xs text-mut px-1">
                离线播放：换源、评论与在线解析不可用；倍速、手势、全屏与在线播放器一致。
              </p>
            ),
          }}
          cacheDisabledReason="离线播放不支持再缓存"
          onOpenDownloads={onBack}
          onBack={onBack}
          onNextEpisode={nextTask ? () => openTask(nextTask) : undefined}
          onPreviousEpisode={prevTask ? () => openTask(prevTask) : undefined}
          nextPreview={nextTask ? { title: formatEpisodeLabel(nextTask) } : undefined}
          previousPreview={prevTask ? { title: formatEpisodeLabel(prevTask) } : undefined}
          queueIndex={episodeIndex >= 0 ? episodeIndex : 0}
          total={Math.max(groupTasks.length, 1)}
          error={error}
          onRetry={() => void prepare()}
          onPosition={(t, duration) => {
            position.current = t;
            if (Date.now() - lastSave.current > 4000) {
              lastSave.current = Date.now();
              setOfflineProgress(downloadId, t, duration);
            }
          }}
          onPlaying={() => setError("")}
          onStopped={() => setOfflineProgress(downloadId, position.current)}
          onEnded={() => {
            setOfflineProgress(downloadId, position.current);
            if (host.prefs.autoNext && nextTask) openTask(nextTask);
          }}
          onFailure={detail => setError(playbackError(detail))}
          onWaiting={() => {}}
        />
      )}
    </div>
  );
}