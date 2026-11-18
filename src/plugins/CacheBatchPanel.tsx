import { useMemo, useState } from "react";
import type { Episode } from "./protocol";
import { episodeCacheState, episodeCacheStateLabel, type DownloadTask } from "./libraryCache";

export default function CacheBatchPanel({
  episodes,
  tasks,
  busy,
  onEnqueueSelected,
}: {
  episodes: Episode[];
  tasks: DownloadTask[];
  busy: boolean;
  onEnqueueSelected: (eps: Episode[]) => Promise<{ enqueued: number; skipped: number; errors: string[] }>;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState("");
  const byEpisodeId = useMemo(() => {
    const map = new Map<string, DownloadTask>();
    for (const t of tasks) {
      if (t.episodeId) map.set(t.episodeId, t);
    }
    return map;
  }, [tasks]);

  const selectable = episodes.filter(ep => {
    if (ep.locked) return false;
    const state = episodeCacheState(byEpisodeId.get(ep.id));
    return state === "none" || state === "failed";
  });

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(selectable.map(e => e.id)));
  const clear = () => setSelected(new Set());

  const startBatch = async () => {
    const eps = episodes.filter(e => selected.has(e.id));
    if (!eps.length) {
      setNotice("请先选择要缓存的分集");
      return;
    }
    setNotice(`即将加入 ${eps.length} 集到下载队列…`);
    const result = await onEnqueueSelected(eps);
    const parts = [
      result.enqueued ? `已加入 ${result.enqueued} 集` : "",
      result.skipped ? `跳过 ${result.skipped} 集` : "",
      result.errors.length ? `失败 ${result.errors.length} 集` : "",
    ].filter(Boolean);
    setNotice(parts.join(" · ") || "已完成");
    setSelected(new Set());
  };

  if (!episodes.length) return null;

  return (
    <div className="hpp-cache-batch">
      <div className="hpp-cache-batch-head">
        <h3>批量离线缓存</h3>
        <div className="hpp-cache-batch-tools">
          <button type="button" disabled={busy} onClick={selectAll}>全选可缓存</button>
          <button type="button" disabled={busy} onClick={clear}>清空</button>
        </div>
      </div>
      <div className="hpp-episodes hpp-cache-batch-grid">
        {episodes.slice(0, 120).map(ep => {
          const state = episodeCacheState(byEpisodeId.get(ep.id));
          const cached = state !== "none" && state !== "failed";
          const picked = selected.has(ep.id);
          return (
            <button
              key={ep.id}
              type="button"
              className={`hpp-cache-batch-ep ${picked ? "is-picked" : ""}`}
              disabled={busy || ep.locked || cached}
              aria-pressed={picked}
              onClick={() => toggle(ep.id)}
              title={episodeCacheStateLabel(state)}
            >
              <span>{ep.episodeNumber ?? ep.index}</span>
              <small>{cached ? episodeCacheStateLabel(state) : picked ? "已选" : "未缓存"}</small>
            </button>
          );
        })}
      </div>
      <p className="hpp-cache-batch-note">将逐集解析并排队，并发受下载器限制；已缓存或进行中的分集会自动跳过。</p>
      <button type="button" className="hpp-cache-batch-start" disabled={busy || !selected.size} onClick={() => void startBatch()}>
        开始缓存所选（{selected.size}）
      </button>
      {notice && <p className="hpp-cache-batch-status" role="status">{notice}</p>}
    </div>
  );
}