import { useEffect, useRef, useState } from "react";
import { BrowseFrame, EmptySources, Notice, type OpenMedia } from "./BrowsePages";
import { useHost, libraryKey, type LibraryEntry } from "./HostContext";
import { onPluginAuthFailure, onPluginAuthSuccess, pluginCommand, pluginError, type InstalledPlugin } from "./client";
import { usePluginRequests } from "./usePluginRequests";
import { useAssetUrls } from "./MediaCards";
import type { UserProfile } from "./protocol";
import CloudLibrary from "./CloudLibrary";
import { ICpu, IChevR, ISettings, IStar, IHist, IUser, IDownload } from "../icons";
import LibraryCachePanel from "./LibraryCachePanel";
import { useStore, type LibraryPanel } from "../store";

export default function LibraryPage({ open, manage, settings }: { open: OpenMedia; manage: (id?: string) => void; settings: () => void }) {
  const app = useStore();
  const host = useHost(), request = usePluginRequests();
  const kind = app.libraryPanel;
  const setKind = (panel: LibraryPanel) => {
    app.setLibraryPanel(panel);
    try { localStorage.setItem("hpp.libraryPanel", panel); } catch { /* ignore */ }
  };
  const [trackingOnly, setTrackingOnly] = useState(false);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const visible = host.library.filter(e => kind === "history" ? !!e.lastProgress : trackingOnly ? e.tracking : e.favorite)
    .filter(e => host.prefs.mature || !host.plugins.find(p => p.meta.id === e.pluginId)?.meta.mature)
    .sort((a, b) => kind === "history" ? (b.lastProgress?.at || 0) - (a.lastProgress?.at || 0) : b.updatedAt - a.updatedAt);
  const checkUpdates = async () => {
    setBusy(true); setError(""); setNotice(""); let count = 0;
    try {
      for (const source of host.sources.filter(p => p.methods.includes("updates.check"))) {
        const entries = host.library.filter(e => e.pluginId === source.meta.id && e.tracking);
        for (let i = 0; i < entries.length; i += 50) {
          const batch = entries.slice(i, i + 50);
          try {
            const results = await request<{ mediaId: string; latestLabel?: string; episodeCount?: number; updatedAt?: number }[]>("call", { id: source.meta.id, method: "updates.check", args: { items: batch.map(e => ({ mediaId: e.mediaId, episodeCount: e.item.episodeCount, updatedAt: e.item.updatedAt })) } });
            for (const result of results) {
              const entry = batch.find(e => e.mediaId === result.mediaId); if (!entry) continue;
              await pluginCommand("library.put", { pluginId: source.meta.id, item: { ...entry.item, episodeCount: result.episodeCount ?? entry.item.episodeCount, updatedAt: result.updatedAt ?? entry.item.updatedAt }, latestLabel: result.latestLabel || "有更新" }); count++;
            }
          } catch (e) { setError(`${source.meta.name}：${pluginError(e)}`); }
        }
      }
      await host.refreshLibrary(); setNotice(`已检查追更，${count} 部作品有变化`);
    } finally { setBusy(false); }
  };
  const accounts = host.sources.filter(p => p.methods.includes("auth.getProfile") || p.methods.includes("library.listMedia"));
  return <div className="hpp-page hpp-library-page"><header className="shrink-0 px-4 pb-2 flex items-center" style={{paddingTop:"calc(var(--sat,0px) + 14px)"}}><h1 className="text-[24px] font-bold text-on leading-none">我的片库</h1><button aria-label="设置" onClick={settings} className="ml-auto w-9 h-9 rounded-full bg-s3 flex items-center justify-center"><ISettings size={17}/></button></header><div className="hpp-scroll"><div className="hpp-content">
    <button className="hpp-library-plugins" onClick={() => manage()}><span className="hpp-plugin-icon"><ICpu size={24}/></span><span><strong>插件中心</strong><small>管理片源、导入插件与账号登录</small></span><IChevR size={18}/></button>
    <nav className="hpp-library-tabs" aria-label="片库分栏">{([["favorite","收藏",IStar],["cloud","来自片源",IUser],["history","历史",IHist],["cache","缓存",IDownload]] as const).map(([id,label,Icon])=><button key={id} aria-pressed={kind===id} onClick={()=>setKind(id)}><Icon size={18}/>{label}</button>)}</nav>
    <Notice error={error || host.error}/>{notice && <p role="status">{notice}</p>}
    {kind === "cache" ? <LibraryCachePanel/> : kind === "cloud" ? <><p className="hpp-library-caption">登录各片源，查看它们的收藏与观看记录。</p>{accounts.map(p=><Account key={p.meta.id+p.revision} plugin={p} open={open} manage={()=>manage(p.meta.id)}/>)}{!accounts.length&&<div className="hpp-empty"><IUser size={36}/><h2>还没有可用的片源账号</h2><p>添加支持账号或云端片库的数据源后，即可在这里查看。</p><button onClick={()=>manage()}>前往插件中心</button></div>}</> : <>
      <div className="hpp-library-toolbar"><span>{visible.length} 部作品 · 仅保存在本机</span>{kind==="favorite"?<><button aria-pressed={trackingOnly} onClick={()=>setTrackingOnly(v=>!v)}>只看追更</button>{trackingOnly&&<button disabled={busy} onClick={()=>void checkUpdates()}>检查追更</button>}</>:<button disabled={!visible.length} onClick={()=>{if(window.confirm("清空本机观看历史？收藏不会被删除。"))void pluginCommand("library.history.clear").then(host.refreshLibrary).catch(e=>setError(pluginError(e)));}}>清空观看历史</button>}</div>
      <section className="hpp-local-library">{visible.map(entry=><LibraryCard key={libraryKey(entry.pluginId,entry.mediaId)} entry={entry} open={open} history={kind==="history"} fail={setError}/>)}</section>
      {!visible.length&&<div className="hpp-empty">{kind==="history"?<IHist size={38}/>:<IStar size={38}/>}<h2>{kind==="history"?"你的下一段故事，从这里继续":trackingOnly?"还没有追更作品":"把喜欢的作品，留在这里"}</h2><p>{kind==="history"?"播放过的作品与观看进度会自动保存。":"在播放器或作品详情中收藏，无需登录。"}</p></div>}
    </>}
  </div></div></div>;
}
function LibraryCard({entry,open,history,fail}:{entry:LibraryEntry;open:OpenMedia;history:boolean;fail:(error:string)=>void}) {
  const host=useHost(),plugin=host.sources.find(p=>p.meta.id===entry.pluginId),installed=host.plugins.find(p=>p.meta.id===entry.pluginId);
  const urls=useAssetUrls(entry.pluginId,plugin&&entry.item.cover?[entry.item.cover]:[]),progress=entry.lastProgress;
  return <article className="hpp-local-entry"><button className="hpp-library-cover" aria-label={history ? "继续观看" : "查看作品"} disabled={!plugin?.methods.includes("media.getDetail")} onClick={()=>open(entry.pluginId,entry.mediaId)}><div className="hpp-poster">{urls[0]?<img src={urls[0]} alt="" loading="lazy"/>:<span>{entry.item.title.slice(0,2)}</span>}<small>{!plugin?"来源不可用":entry.latestLabel|| (history?"继续观看":entry.tracking?"追更中":"已收藏")}</small>{progress?.durationSec&&<progress max={progress.durationSec} value={progress.positionSec}/>}</div><h3>{entry.item.title}</h3></button><p className="hpp-muted">{installed?.meta.name||"来源已移除"}{history&&progress?` · 看到 ${Math.floor(progress.positionSec/60)}:${String(Math.floor(progress.positionSec%60)).padStart(2,"0")}`:""}</p><details><summary>管理作品</summary>{entry.favorite&&<button onClick={()=>void host.put(entry.pluginId,entry.item,{favorite:false}).catch(e=>fail(pluginError(e)))}>取消本地收藏</button>}<AssociatedSources entry={entry} open={open}/></details></article>;
}
function AssociatedSources({ entry, open }: { entry: LibraryEntry; open: OpenMedia }) {
  const host = useHost(), request = usePluginRequests(), [expanded, setExpanded] = useState(false);
  const [sources, setSources] = useState<LibraryEntry[]>([]), [error, setError] = useState("");
  useEffect(() => {
    if (!expanded) return;
    let live = true;
    void request<LibraryEntry[]>("library.sources.get", { pluginId: entry.pluginId, mediaId: entry.mediaId }).then(result => { if (live) setSources(result); }).catch(e => { if (live) setError(pluginError(e)); });
    return () => { live = false; request.cancelAll(); };
  }, [expanded, entry.pluginId, entry.mediaId, request]);
  return <div><button aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>关联来源</button>{expanded && <><Notice error={error}/>{sources.filter(e => host.prefs.mature || !host.plugins.find(p => p.meta.id === e.pluginId)?.meta.mature).map(source => {
    const plugin = host.sources.find(p => p.meta.id === source.pluginId);
    return <p key={libraryKey(source.pluginId, source.mediaId)}><button disabled={!plugin?.methods.includes("media.getDetail")} onClick={() => open(source.pluginId, source.mediaId)}>{source.item.title} · {plugin?.meta.name || source.pluginId}{plugin ? "" : " · 来源不可用"}</button></p>;
  })}{!sources.length && !error && <p className="hpp-muted">尚未关联其他来源</p>}</>}</div>;
}
function Account({ plugin: p, open, manage }: { plugin: InstalledPlugin; open: OpenMedia; manage: () => void }) {
  const request = usePluginRequests(), epoch = useRef(0);
  const [profile, setProfile] = useState<UserProfile | null>(null), [error, setError] = useState("");
  const avatar = useAssetUrls(p.meta.id, profile?.avatar ? [profile.avatar] : []);
  const getProfile = () => {
    const n = ++epoch.current;
    if (p.methods.includes("auth.getProfile")) void request<UserProfile | null>("call", { id: p.meta.id, method: "auth.getProfile", args: {} }).then(r => { if (n === epoch.current) setProfile(r); }).catch(e => { if (n === epoch.current) setError(pluginError(e)); });
  };
  useEffect(() => { getProfile(); return () => { epoch.current++; }; }, [p.meta.id]);
  useEffect(() => onPluginAuthFailure(f => { if (f.id === p.meta.id) { epoch.current++; setProfile(null); if (!f.silent) setError(f.message); } }), [p.meta.id]);
  useEffect(() => onPluginAuthSuccess(id => { if (id === p.meta.id) { setError(""); getProfile(); } }), [p.meta.id]);
  return <section className="hpp-account"><div className="hpp-section-title"><h3>{p.meta.name}</h3><button onClick={manage}>账号与操作</button></div><Notice error={error}/>{profile ? <div className="hpp-profile">{avatar[0] && <img src={avatar[0]} alt=""/>}<strong>{profile.name}</strong><p>{profile.description}</p></div> : p.methods.includes("auth.getProfile") && <p className="hpp-muted">未登录此插件</p>}
    {p.methods.includes("library.listMedia") && (!p.methods.includes("auth.getProfile") || profile) && <CloudLibrary plugin={p} open={open}/>}
  </section>;
}
