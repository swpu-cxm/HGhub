import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { Notice } from "./BrowsePages";
import { IChevR, IRefresh } from "../icons";
import {
  type DownloadTask,
  formatBytes,
  formatEpisodeLabel,
  formatSpeed,
  groupDownloadTasks,
  type CacheGroup,
} from "./libraryCache";
import { fetchDownloadCatalog } from "./cacheApi";
import { useHost } from "./HostContext";
import { pluginCommand, releaseMedia } from "./client";
import CachePoster from "./CachePoster";
import CacheWorkDetailSheet from "./CacheWorkDetailSheet";

export default function LibraryCachePanel() {
  const app = useStore();
  const host = useHost();
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [works, setWorks] = useState<Record<string, import("./cacheApi").WorkCacheMeta>>({});
  const [workCovers, setWorkCovers] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [detailGroup, setDetailGroup] = useState<CacheGroup | null>(null);

  const refresh = useCallback(async () => {
    try {
      const catalog = await fetchDownloadCatalog();
      setTasks(catalog.tasks);
      setWorks(catalog.works);
      setWorkCovers(catalog.workCovers);
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法读取下载队列");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!detailGroup) return;
    const groups = groupDownloadTasks(tasks, works, workCovers);
    const next = groups.find(g => g.key === detailGroup.key);
    if (next) setDetailGroup(next);
  }, [tasks, works, workCovers, detailGroup?.key]);

  useEffect(() => {
    const focus = app.libraryCacheFocus;
    if (!focus || !tasks.length) return;
    const groups = groupDownloadTasks(tasks, works, workCovers);
    const match = groups.find(g => g.pluginId === focus.pluginId && g.mediaId === focus.mediaId);
    if (match) setDetailGroup(match);
    app.clearLibraryCacheFocus();
  }, [app.libraryCacheFocus, tasks, works, workCovers, app]);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      for (const task of tasks) {
        if (task.coverLocalPath || task.workCoverLocalPath || !task.pluginId || !task.mediaId) continue;
        const entry = host.library.find(e => e.pluginId === task.pluginId && e.mediaId === task.mediaId);
        const cover = entry?.item.cover;
        if (!cover) continue;
        try {
          const r = await pluginCommand<{ sessionId: string; urls: string[] }>("assets.prepare", {
            id: task.pluginId,
            assets: [cover],
          });
          const url = r.urls[0];
          if (!url || disposed) {
            releaseMedia(r.sessionId);
            continue;
          }
          const res = await fetch(url);
          releaseMedia(r.sessionId);
          if (!res.ok) continue;
          const buf = await res.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let binary = "";
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          await invoke("download_manage", {
            action: "attachCoverData",
            params: { id: task.id, dataBase64: btoa(binary) },
          });
          if (!disposed) await refresh();
        } catch {
          /* 离线或插件不可用时不阻塞列表 */
        }
      }
    })();
    return () => { disposed = true; };
  }, [tasks, host.library, refresh]);

  const play = async (task: DownloadTask) => {
    setError("");
    try {
      await invoke("download_manage", { action: "localPath", params: { id: task.id } });
      app.push({
        kind: "offlinePlay",
        downloadId: task.id,
        title: task.title,
        episodeLabel: formatEpisodeLabel(task),
        mediaKind: task.kind,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法打开离线文件");
    }
  };

  const run = async (action: string, id: string) => {
    setError("");
    try {
      await invoke("download_manage", { action, params: { id } });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    }
  };

  const groups = groupDownloadTasks(tasks, works, workCovers);
  const active = tasks.filter(t => t.state === "running" || t.state === "queued");
  const globalSpeed = active.reduce((n, t) => n + (t.speedBps || 0), 0);

  const openOnline = detailGroup?.pluginId && detailGroup.mediaId
    ? () => {
        if (!detailGroup.pluginId || !detailGroup.mediaId) return;
        setDetailGroup(null);
        app.push({ kind: "media", pluginId: detailGroup.pluginId, mediaId: detailGroup.mediaId });
      }
    : undefined;

  return (
    <div className="hpp-library-cache">
      <Notice error={error}/>
      <p className="hpp-library-caption">
        支持直链 MP4、fMP4 HLS（单 MP4）、MPEG-TS HLS（含 AES-128 离线包）。不支持 SAMPLE-AES、BYTERANGE、独立音轨 Rendition、DRM。
      </p>
      {globalSpeed > 0 && (
        <p className="hpp-cache-global-speed" role="status">合计下载 {formatSpeed(globalSpeed)}</p>
      )}
      {!groups.length ? (
        <div className="hpp-empty"><p>暂无缓存。在作品详情或播放器中可添加分集缓存。</p></div>
      ) : (
        <ul className="hpp-cache-groups hpp-cache-work-cards">
          {groups.map(group => {
            const completed = group.tasks.filter(t => t.state === "completed").length;
            const totalEp = group.episodeCount;
            return (
              <li key={group.key} className="hpp-cache-group">
                <button
                  type="button"
                  className="hpp-cache-group-head"
                  onClick={() => setDetailGroup(group)}
                >
                  <div className="hpp-cache-cover hpp-cache-cover-lg">
                    <CachePoster src={group.coverSrc} title={group.title}/>
                  </div>
                  <div className="hpp-cache-group-meta">
                    <strong>{group.title}</strong>
                    <small>
                      {group.meta?.pluginName || group.pluginId || "本地"}
                    </small>
                    <small>
                      已缓存 {completed} 集{totalEp != null ? ` / 共 ${totalEp} 集` : ""}
                    </small>
                  </div>
                  <IChevR size={16}/>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <button type="button" className="hpp-cache-refresh" onClick={() => void refresh()}><IRefresh size={14}/> 刷新</button>
      {detailGroup && (
        <CacheWorkDetailSheet
          group={detailGroup}
          onClose={() => setDetailGroup(null)}
          onPlay={task => void play(task)}
          onOpenOnline={openOnline}
          onManageTask={(action, task) => void run(action, task.id)}
        />
      )}
    </div>
  );
}