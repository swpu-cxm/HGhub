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
  kindLabel,
} from "./libraryCache";
import { useHost } from "./HostContext";
import { pluginCommand, releaseMedia } from "./client";

export default function LibraryCachePanel() {
  const app = useStore();
  const host = useHost();
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const refresh = useCallback(async () => {
    try {
      const list = await invoke<DownloadTask[]>("download_manage", { action: "list", params: {} });
      setTasks(list);
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
    let disposed = false;
    void (async () => {
      for (const task of tasks) {
        if (task.coverLocalPath || !task.pluginId || !task.mediaId) continue;
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
          await invoke("download_manage", { action: "attachCover", params: { id: task.id, coverUrl: url } });
          releaseMedia(r.sessionId);
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

  const groups = groupDownloadTasks(tasks);
  const active = tasks.filter(t => t.state === "running" || t.state === "queued");
  const globalSpeed = active.reduce((n, t) => n + (t.speedBps || 0), 0);

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
        <ul className="hpp-cache-groups">
          {groups.map(group => {
            const completed = group.tasks.filter(t => t.state === "completed").length;
            const totalEp = group.episodeCount;
            const open = expanded[group.key] ?? true;
            return (
              <li key={group.key} className="hpp-cache-group">
                <button type="button" className="hpp-cache-group-head" aria-expanded={open} onClick={() => setExpanded(e => ({ ...e, [group.key]: !open }))}>
                  <div className="hpp-cache-cover">
                    {group.coverSrc ? <img src={group.coverSrc} alt="" loading="lazy"/> : <span>{group.title.slice(0, 2)}</span>}
                  </div>
                  <div className="hpp-cache-group-meta">
                    <strong>{group.title}</strong>
                    <small>
                      已缓存 {completed} 集{totalEp != null ? ` / 共 ${totalEp} 集` : ""}
                    </small>
                  </div>
                  <IChevR size={16} className={open ? "hpp-chev-open" : ""}/>
                </button>
                {open && (
                  <ul className="hpp-cache-episodes">
                    {group.tasks.map(task => {
                      const pct = task.bytesTotal ? Math.min(100, Math.round(task.bytesDone / task.bytesTotal * 100)) : null;
                      return (
                        <li key={task.id} className="hpp-cache-episode">
                          <div className="hpp-cache-episode-title">{formatEpisodeLabel(task)}</div>
                          <div className="hpp-cache-episode-meta text-mut text-xs">
                            {kindLabel(task.kind)} · {task.state}
                            {task.state === "running" || task.state === "queued"
                              ? ` · ${formatBytes(task.bytesDone)}${task.bytesTotal ? ` / ${formatBytes(task.bytesTotal)}` : ""}${task.speedBps > 0 ? ` · ${formatSpeed(task.speedBps)}` : ""}${pct != null ? ` · ${pct}%` : ""}`
                              : task.state === "completed"
                                ? ` · ${formatBytes(task.bytesDone)}`
                                : task.bytesDone ? ` · ${formatBytes(task.bytesDone)}` : ""}
                          </div>
                          {task.error && <p className="text-xs text-red-400">{task.error}</p>}
                          <div className="hpp-cache-episode-actions">
                            {task.state === "running" || task.state === "queued" ? <button onClick={() => void run("pause", task.id)}>暂停</button> : null}
                            {task.state === "paused" || task.state === "failed" ? <button onClick={() => void run("resume", task.id)}>继续</button> : null}
                            {task.state !== "completed" && task.state !== "cancelled" ? <button onClick={() => void run("cancel", task.id)}>取消</button> : null}
                            {task.state === "completed" && <button onClick={() => void play(task)}>离线播放</button>}
                            <button onClick={() => void run("remove", task.id)}>删除</button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <button type="button" className="hpp-cache-refresh" onClick={() => void refresh()}><IRefresh size={14}/> 刷新</button>
    </div>
  );
}
