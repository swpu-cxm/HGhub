import { useEffect, useMemo, useRef, useState } from "react";
import { registerBackHandler } from "../back";
import { IClose, IPlayF } from "../icons";
import CachePoster from "./CachePoster";
import {
  type CacheGroup,
  episodeCacheState,
  episodeCacheStateLabel,
  formatBytes,
  formatEpisodeLabel,
  formatSpeed,
  taskForEpisodeIndex,
  type DownloadTask,
} from "./libraryCache";

export default function CacheWorkDetailSheet({
  group,
  onClose,
  onPlay,
  onOpenOnline,
  onManageTask,
}: {
  group: CacheGroup;
  onClose: () => void;
  onPlay: (task: DownloadTask) => void;
  onOpenOnline?: () => void;
  onManageTask: (action: string, task: DownloadTask) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [expanded, setExpanded] = useState(false);
  const episodeCount = group.episodeCount ?? Math.max(...group.tasks.map(t => t.episodeIndex ?? 0), group.tasks.length);
  const completed = group.tasks.filter(t => t.state === "completed").length;
  const active = group.tasks.filter(t => t.state === "running" || t.state === "queued").length;
  const slots = useMemo(() => {
    const max = Math.max(episodeCount, ...group.tasks.map(t => t.episodeIndex ?? 0));
    return Array.from({ length: max }, (_, i) => i + 1);
  }, [episodeCount, group.tasks]);

  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    const unregister = registerBackHandler(() => { close.current(); return true; });
    return () => { unregister(); dialog.close(); };
  }, []);

  const meta = group.meta;
  const source = meta?.pluginName || group.pluginId || "离线";

  return (
    <dialog
      ref={ref}
      className="hg-detail-sheet hpp-cache-work-sheet"
      aria-labelledby="hpp-cache-work-title"
      onCancel={e => { e.preventDefault(); onClose(); }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="hg-detail-frame">
        <div className="hg-sheet-handle"/>
        <header className="hg-detail-heading">
          <h2 id="hpp-cache-work-title">缓存作品</h2>
          <button aria-label="关闭" onClick={onClose} autoFocus><IClose size={22}/></button>
        </header>
        <div className="hg-detail-scroll">
          <div className="hg-detail-hero">
            <div className="hg-detail-cover hpp-cache-detail-cover">
              <CachePoster src={group.coverSrc} title={group.title}/>
            </div>
            <div>
              <h1>{group.title}</h1>
              <p>
                {[meta?.year, episodeCount ? `共 ${episodeCount} 集` : null, source]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <small className="hpp-cache-work-stats">
                已缓存 {completed} 集
                {active > 0 ? ` · 下载中 ${active} 集` : ""}
              </small>
              {meta?.score != null && (
                <strong className="hg-detail-score">★ {meta.score.toFixed(1)} <small>分</small></strong>
              )}
              {!!meta?.tags?.length && (
                <div className="hg-detail-tags">{meta.tags.map(tag => <span key={tag}>{tag}</span>)}</div>
              )}
            </div>
          </div>
          {meta?.description && (
            <div className="hg-synopsis">
              <p className={expanded ? "" : "is-clamped"}>{meta.description}</p>
              {meta.description.length > 80 && (
                <button aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>
                  {expanded ? "收起" : "展开简介"}
                </button>
              )}
            </div>
          )}
          <div className="hg-episode-picker hpp-cache-episode-grid">
            <div className="hg-section-title">
              <h3>选集</h3>
              <span>{episodeCount ? `共 ${episodeCount} 集` : `${group.tasks.length} 项`}</span>
            </div>
            <div className="hpp-episodes hpp-cache-status-grid">
              {slots.map(index => {
                const task = taskForEpisodeIndex(group, index);
                const state = episodeCacheState(task);
                const label = episodeCacheStateLabel(state);
                const pct = task?.bytesTotal
                  ? Math.min(100, Math.round((task.bytesDone / task.bytesTotal) * 100))
                  : null;
                return (
                  <button
                    key={index}
                    type="button"
                    className={`hpp-cache-ep-btn state-${state}`}
                    disabled={state === "none"}
                    title={task ? `${formatEpisodeLabel(task)} · ${label}` : `第 ${index} 集 · ${label}`}
                    onClick={() => task && state === "completed" && onPlay(task)}
                  >
                    <span>{index}</span>
                    <small>{label}{state === "running" && pct != null ? ` ${pct}%` : ""}</small>
                    {state === "running" && task && task.speedBps > 0 && (
                      <em className="hpp-cache-ep-speed">{formatSpeed(task.speedBps)}</em>
                    )}
                  </button>
                );
              })}
            </div>
            <ul className="hpp-cache-episode-list">
              {group.tasks.map(task => (
                <li key={task.id} className="hpp-cache-episode">
                  <div className="hpp-cache-episode-title">{formatEpisodeLabel(task)}</div>
                  <div className="hpp-cache-episode-meta text-mut text-xs">
                    {episodeCacheStateLabel(episodeCacheState(task))}
                    {task.state === "completed" ? ` · ${formatBytes(task.bytesDone)}` : ""}
                    {task.error ? ` · ${task.error}` : ""}
                  </div>
                  <div className="hpp-cache-episode-actions">
                    {task.state === "completed" && (
                      <button onClick={() => onPlay(task)}><IPlayF size={14}/> 播放</button>
                    )}
                    {task.state === "running" || task.state === "queued" ? (
                      <button onClick={() => onManageTask("pause", task)}>暂停</button>
                    ) : null}
                    {task.state === "paused" || task.state === "failed" ? (
                      <button onClick={() => onManageTask("resume", task)}>继续</button>
                    ) : null}
                    {task.state !== "completed" && task.state !== "cancelled" ? (
                      <button onClick={() => onManageTask("cancel", task)}>取消</button>
                    ) : null}
                    <button onClick={() => onManageTask("remove", task)}>删除</button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <footer className="hpp-cache-work-footer">
          {onOpenOnline && (
            <button type="button" className="hpp-cache-online-btn" onClick={onOpenOnline}>
              在线续缓存更多集
            </button>
          )}
        </footer>
      </div>
    </dialog>
  );
}