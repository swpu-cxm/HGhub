import ProxySettings from "./ProxySettings";
import { playbackSources, SourcePicker } from "./ImmersiveHome";
import { IBack, IChevR, IGrid, ISettings, IMoon, ISun, IVolMute, IPlayF, IRefresh, ILockF, IHeart, IInfo } from "../icons";
import type { ReactNode } from "react";
import { Toggle } from "../components/ui";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { checkAppUpdate, type AppRelease } from "../appUpdates";
import { readPendingUpdate, savePendingUpdate, stageLabel, type AppUpdateStage } from "../appUpdateInstall";
import { useStore } from "../store";
import { APP_VERSION, platform } from "../environment";
import { UPDATE_GITHUB_OWNER, UPDATE_GITHUB_REPO } from "../updateConfig";
import { useHost } from "./HostContext";
import { BrowseFrame, Notice } from "./BrowsePages";
import { pluginError } from "./client";
import { usePluginRequests } from "./usePluginRequests";
import type { UpdatePolicy } from "./updateClient";
export default function ApplicationSettings({ onBack }: { onBack: () => void }) {
  const app = useStore(), host = useHost(), [error, setError] = useState("");
  const [picker, setPicker] = useState(false);
  const available = playbackSources(host.sources), selected = available.filter(p => host.prefs.homeIds.includes(p.meta.id));
  const request = usePluginRequests(), [resolverPrefs, setResolverPrefs] = useState<Record<string, string>>({}), [clearing, setClearing] = useState(false);
  useEffect(() => { let live = true; void request<Record<string, string>>("resolver.preferences.get").then(p => { if (live) setResolverPrefs(p); }).catch(e => { if (live) setError(pluginError(e)); }); return () => { live = false; }; }, [request]);
  const clearResolver = async (site?: string) => {
    setClearing(true); setError("");
    try {
      await request(site ? "resolver.preferences.set" : "resolver.preferences.clear", site ? { host: site, pluginId: null } : {});
      setResolverPrefs(await request<Record<string, string>>("resolver.preferences.get"));
    } catch (error) { setError(pluginError(error)); } finally { setClearing(false); }
  };
  const updatePolicy = async (changes: Partial<UpdatePolicy>) => {
    setClearing(true); setError("");
    try { await request("updates.policy.set", { ...host.updates.policy, ...changes }); await host.refreshUpdates(); }
    catch (e) { setError(pluginError(e)); } finally { setClearing(false); }
  };
  return <div className="absolute inset-0 bg-bg flex flex-col legacy-settings">
    <div className="shrink-0 relative overflow-hidden bg-s1" style={{paddingTop:"var(--sat, 0px)"}}>
      <div className="absolute inset-0 pointer-events-none" style={{background:"radial-gradient(90% 120% at 100% 0%, var(--p-pc) 0%, transparent 60%)",opacity:.32}}/>
      <div className="relative px-3 pt-2 pb-4"><button onClick={onBack} aria-label="返回" className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={20}/></button>
        <div className="px-2 mt-1"><div className="flex items-center gap-2"><span className="w-9 h-9 rounded-(--r-sm) bg-pc text-on-pc flex items-center justify-center"><ISettings size={20}/></span><h1 className="text-[24px] font-bold tracking-wide text-on">设置</h1></div><p className="text-[11px] text-mut mt-1">外观 · 播放 · 插件 · 本地数据</p></div>
      </div>
    </div>
    <div className="flex-1 min-h-0 scroll-y px-4 pt-1 pb-10"><div className="max-w-[720px] mx-auto"><Notice error={error||app.error}/>
      <Section title="外观"><Setting icon={app.theme==="dark"?<IMoon size={16}/>:<ISun size={16}/>} title="深色外观" description="切换应用的深色与浅色外观"><Toggle label="深色外观" on={app.theme==="dark"} onChange={on=>app.setTheme(on?"dark":"light")}/></Setting></Section>
      <Section title="播放">
        <button className="w-full text-left" onClick={()=>setPicker(true)} aria-haspopup="dialog"><Setting icon={<IGrid size={16}/>} title="首页播放片源" description={host.prefs.homeMode==="all"?`全部片源 · ${available.length} 个`:host.prefs.homeMode==="single"?selected[0]?.meta.name||"尚未选择片源":`已选择 ${selected.length} 个片源`}><IChevR size={15}/></Setting></button>
        <Setting icon={<IVolMute size={16}/>} title="启动时静音" description="每次启动默认静音，下次启动生效"><Toggle label="启动时静音" on={app.muteOnStartup} onChange={app.setMuteOnStartup}/></Setting>
        <Setting icon={<IPlayF size={16}/>} title="自动播放下一条" description="播完后继续下一集或下一部作品"><Toggle label="自动播放下一条" on={host.prefs.autoNext} onChange={autoNext=>host.setPrefs({autoNext})}/></Setting>
        <Setting icon={<IRefresh size={16}/>} title="播放失败后尝试其他播放流" description="尝试当前来源可用的其他播放流"><Toggle label="播放失败后尝试其他播放流" on={host.prefs.playbackFallback} onChange={playbackFallback=>host.setPrefs({playbackFallback})}/></Setting>
      </Section>
      <Section title="插件与内容">
        <Setting icon={<IRefresh size={16}/>} title="启动时自动检查插件更新" description="同一地址的自动检查至少间隔 24 小时"><Toggle label="启动时自动检查插件更新" on={host.updates.policy.checkOnStartup} disabled={clearing} onChange={checkOnStartup=>void updatePolicy({checkOnStartup})}/></Setting>
        <Setting icon={<IGrid size={16}/>} title="自动安装插件更新" description="在当前播放结束后安装更高版本"><Toggle label="自动安装插件更新" on={host.updates.policy.autoInstall} disabled={clearing} onChange={autoInstall=>void updatePolicy({autoInstall})}/></Setting>
        <Setting icon={<ILockF size={16}/>} title="显示成人内容" description="控制来源中的成人内容展示"><Toggle label="显示成人内容" on={host.prefs.mature} onChange={mature=>host.setPrefs({mature})}/></Setting>
      </Section>
      <Section title="本地数据"><Setting icon={<IHeart size={16}/>} title="我的片库" description={`${host.library.filter(e=>e.favorite).length} 部收藏 · ${host.library.filter(e=>e.lastProgress).length} 条观看记录`}/>
        <Setting icon={<IRefresh size={16}/>} title="离线缓存" description="查看下载进度与管理本地 MP4"><button onClick={()=>app.push({kind:"downloads"})}>打开缓存管理</button></Setting>
        <details className="px-3.5 py-3 hpp-resolver-preferences" aria-label="解析器站点偏好"><summary className="text-[12.5px] cursor-pointer">解析器站点偏好</summary><div className="mt-3 text-xs text-mut">
          {Object.entries(resolverPrefs).map(([site,id])=><div className="flex gap-2 py-2" key={site}><span className="flex-1 break-all">{site} · {host.plugins.find(p=>p.meta.id===id)?.meta.name||id}</span><button aria-label={`忘记 ${site} 的解析器`} disabled={clearing} onClick={()=>void clearResolver(site)}>忘记</button></div>)}
          {!Object.keys(resolverPrefs).length&&<p>暂无记住的站点。</p>}<button className="mt-3 text-primary" disabled={clearing||!Object.keys(resolverPrefs).length} onClick={()=>void clearResolver()}>清空解析器偏好</button>
        </div></details>
      </Section>
      <Section title="网络"><ProxySettings/><Setting icon={<ILockF size={16}/>} title="严格安全模式" description="用于插件与媒体请求。自建服务需要访问局域网时可关闭。"><Toggle label="严格安全模式" on={app.strictSecurity} disabled={!app.strictSecurityReady||app.securityPending} onChange={on=>void app.setStrictSecurity(on).catch(e=>setError(pluginError(e)))}/></Setting></Section>
      <Section title="关于"><Setting icon={<IInfo size={16}/>} title={`HGhub ${APP_VERSION}`} description="由用户自行导入内容源与解析器的插件视频播放器"/><AppUpdateSetting/></Section>
    </div></div>
    {picker&&<SourcePicker plugins={available} close={()=>setPicker(false)} manage={()=>app.push({kind:"plugins"})}/>}
  </div>;
}

function AppUpdateSetting() {
  const [checking, setChecking] = useState(false), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(`检查 ${UPDATE_GITHUB_OWNER}/${UPDATE_GITHUB_REPO} Releases`), [error, setError] = useState("");
  const [release, setRelease] = useState<AppRelease | null>(null);
  const [stage, setStage] = useState<AppUpdateStage>("idle");
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);
  useEffect(() => {
    const pending = readPendingUpdate();
    if (pending?.localPath) {
      setPendingPath(pending.localPath);
      setMessage(`已下载 ${pending.release.tag}，可继续打开系统安装程序`);
    }
    const onVis = () => {
      if (document.visibilityState !== "visible" || platform !== "android") return;
      void invoke<boolean>("app_update_permissions").then(allowed => {
        if (allowed && pending?.localPath && !busy) {
          setMessage(`已允许安装权限 · 可点「继续安装 ${pending.release.tag}」`);
        }
      }).catch(() => {});
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [busy]);
  const check = async () => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setChecking(true); setError(""); setRelease(null); setStage("idle"); setMessage("正在检查更新…");
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const result = await checkAppUpdate(APP_VERSION, controller.signal);
      if (active.current !== controller) return;
      setRelease(result);
      setMessage(result ? result.available ? `发现新版本 ${result.tag}` : `暂无更新 · 最新发布 ${result.tag}` : "暂无正式发布版本");
    } catch (e) {
      if (active.current !== controller) return;
      setMessage("检查未完成");
      setError(controller.signal.aborted ? "检查超时，请重试" : e instanceof Error ? e.message : "检查更新失败，请重试");
    } finally {
      window.clearTimeout(timeout);
      if (active.current === controller) { active.current = null; setChecking(false); }
    }
  };
  const launchInstaller = async (path: string) => {
    setStage("launching_installer");
    setMessage(stageLabel("launching_installer"));
    const result = await invoke<{ launched?: boolean; installerCount?: number; apkBytes?: number }>("app_update_install", { path });
    if (!result?.launched) throw new Error("安装程序未成功打开，请重试");
    setStage("installer_opened");
    setMessage(stageLabel("installer_opened") + (result.installerCount ? `（${result.installerCount} 个安装器可用）` : ""));
  };
  const installAndroid = async (target: AppRelease, reusePath?: string | null) => {
    if (!target.apkUrl || busy) return;
    setBusy(true); setError("");
    try {
      const allowed = await invoke<boolean>("app_update_permissions");
      if (!allowed) {
        savePendingUpdate({ release: target, savedAt: Date.now() });
        setStage("need_permission");
        setMessage(stageLabel("need_permission"));
        await invoke("app_update_open_install_permission");
        setError("请先在系统设置中允许「安装未知应用」，返回后点「继续安装」");
        return;
      }
      let path = reusePath;
      if (!path) {
        setStage("downloading");
        setMessage(stageLabel("downloading"));
        path = await invoke<string>("app_update_download_apk", {
          url: target.apkUrl,
          fileName: target.apkName || "HGhub-update.apk",
          expectedSha256: target.apkSha256 || null,
        });
        setStage("verifying");
        setMessage(`${stageLabel("verifying")}（${path.split(/[/\\]/).pop()}）`);
      }
      setPendingPath(path);
      savePendingUpdate({ release: target, localPath: path, savedAt: Date.now() });
      await launchInstaller(path);
    } catch (e) {
      setStage("failed");
      const msg = e instanceof Error ? e.message : "无法完成更新";
      setMessage(stageLabel("failed", msg));
      setError(msg);
    } finally { setBusy(false); }
  };
  const continuePending = async () => {
    const pending = readPendingUpdate();
    if (!pending?.localPath) { setError("没有待安装的已下载包"); return; }
    const target = release ?? ({ ...pending.release, available: true } as AppRelease);
    await installAndroid(target, pending.localPath);
  };
  const open = async () => {
    if (!release || busy) return;
    if (platform === "android" && release.apkUrl) { await installAndroid(release); return; }
    setBusy(true); setError("");
    try { await invoke<void>("open_url", { url: release.url }); }
    catch { setError("无法打开浏览器，请重试"); }
    finally { setBusy(false); }
  };
  const statusLine = stage !== "idle" && !error ? stageLabel(stage) : message;
  const pending = readPendingUpdate();
  return <div>
    <Setting icon={<IRefresh size={16}/>} title="检查更新" description={<span role="status">{statusLine}</span>}>
      <div className="flex flex-col items-end gap-2 text-[12px] text-primary">
        {release?.available && <button className="pressable disabled:opacity-50" disabled={busy || checking} onClick={() => void open()}>{busy ? (stageLabel(stage) || "正在处理…") : platform === "android" && release.apkUrl ? "下载并安装" : "前往 Release"}</button>}
        {platform === "android" && (pending?.localPath || pendingPath) && (
          <button className="pressable disabled:opacity-50" disabled={busy || checking} onClick={() => void continuePending()}>
            {busy ? "正在打开安装程序…" : `继续安装 ${pending?.release.tag || release?.tag || "待安装包"}`}
          </button>
        )}
        <button className="pressable disabled:opacity-50" disabled={checking || busy} onClick={() => void check()}>{checking ? "检查中…" : release ? "重新检查" : "检查更新"}</button>
      </div>
    </Setting>
    {error && <div className="px-3.5 pb-3"><Notice error={error}/></div>}
    {stage === "installer_opened" && <p className="px-3.5 pb-2 text-[10.5px] text-mut">应用尚未升级成功；请在系统安装界面确认后再打开 HGhub 核对版本号。</p>}
  </div>;
}

// Reused Settings row/section structure from 5f88442.
function Section({title,children}:{title:string;children:ReactNode}) {return <><h2 className="text-[10.5px] font-semibold text-dim tracking-wide px-1 mt-4 mb-1.5">{title}</h2><section className="rounded-(--r-md) bg-s2 divide-y divide-s3">{children}</section></>;}
function Setting({icon,title,description,children}:{icon:ReactNode;title:string;description:ReactNode;children?:ReactNode}) {return <div className="flex items-center gap-3 px-3.5 py-3"><span className="shrink-0 w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-primary">{icon}</span><div className="flex-1 min-w-0"><div className="text-[12.5px] text-on">{title}</div><div className="text-[10.5px] text-mut">{description}</div></div><div className="shrink-0 flex">{children}</div></div>;}
