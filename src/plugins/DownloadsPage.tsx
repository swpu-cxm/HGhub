import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IBack, IRefresh } from "../icons";
import { BrowseFrame, Notice } from "./BrowsePages";
import { useStore } from "../store";

type DownloadTask = {
  id: string;
  title: string;
  episodeLabel?: string;
  kind: "progressiveMp4" | "hlsFmp4" | "hlsMpegTs";
  state: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
  bytesDone: number;
  bytesTotal?: number;
  speedBps: number;
  error?: string;
};

function formatBytes(value: number) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let n = value, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export default function DownloadsPage({ onBack }: { onBack: () => void }) {
  const app = useStore();
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [error, setError] = useState("");
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
  const play = async (task: DownloadTask) => {
    setError("");
    try {
      await invoke("download_manage", { action: "localPath", params: { id: task.id } });
      app.push({
        kind: "offlinePlay",
        downloadId: task.id,
        title: task.title,
        episodeLabel: task.episodeLabel,
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
  return <BrowseFrame title="离线缓存" tools={<button onClick={onBack} aria-label="返回"><IBack size={18}/></button>}>
    <Notice error={error}/>
    <p className="text-xs text-mut mb-3">支持：直链 MP4、fMP4 HLS（合并为单 MP4）、MPEG-TS HLS（含 AES-128 密钥离线包，断网可播）。不支持：SAMPLE-AES、BYTERANGE、独立音轨 Rendition、DRM。</p>
    {!tasks.length ? <p className="text-mut text-sm">暂无下载任务。在作品详情页可添加缓存。</p> : <ul className="space-y-2">
      {tasks.map(task => {
        const pct = task.bytesTotal ? Math.min(100, Math.round(task.bytesDone / task.bytesTotal * 100)) : null;
        return <li key={task.id} className="rounded-(--r-md) bg-s2 p-3 text-sm">
          <strong>{task.title}</strong>
          {task.episodeLabel && <div className="text-mut text-xs">{task.episodeLabel}</div>}
          <div className="text-xs text-mut mt-1">{task.kind === "hlsFmp4" ? "HLS → MP4" : task.kind === "hlsMpegTs" ? "HLS TS 离线包" : "MP4"} · {task.state}</div>
          <div className="text-xs mt-1">{formatBytes(task.bytesDone)}{task.bytesTotal ? ` / ${formatBytes(task.bytesTotal)}` : ""}{pct !== null ? ` · ${pct}%` : ""}{task.speedBps > 0 ? ` · ${formatBytes(task.speedBps)}/s` : ""}</div>
          {task.error && <div className="text-xs text-red-400 mt-1">{task.error}</div>}
          <div className="flex flex-wrap gap-2 mt-2">
            {task.state === "running" || task.state === "queued" ? <button onClick={() => void run("pause", task.id)}>暂停</button> : null}
            {task.state === "paused" || task.state === "failed" ? <button onClick={() => void run("resume", task.id)}>继续</button> : null}
            {task.state !== "completed" && task.state !== "cancelled" ? <button onClick={() => void run("cancel", task.id)}>取消</button> : null}
            {task.state === "completed" && <button onClick={() => void play(task)}>离线播放</button>}
            <button onClick={() => void run("remove", task.id)}>删除</button>
          </div>
        </li>;
      })}
    </ul>}
    <button className="mt-4 text-primary text-sm flex items-center gap-1" onClick={() => void refresh()}><IRefresh size={14}/> 刷新</button>
  </BrowseFrame>;
}
