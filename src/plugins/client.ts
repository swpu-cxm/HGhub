import { invoke } from "@tauri-apps/api/core";
import { probeMediaCapabilities } from "./mediaCapabilities";
import type { PlaybackInfo, PlaybackServer, PluginFailure, PluginMeta, Codec, MediaFormat } from "./protocol";

export interface InstalledPlugin {
  meta: PluginMeta; enabled: boolean; source?: string; status: "ready" | "unloaded" | "failed" | "incompatible" | "disabled";
  methods: string[]; error?: PluginFailure; endpoint: { id: string; label?: string; url: string } | null; revision: string;
  origin?: { kind: string; location: string; manifest?: string; manifestName?: string }; canRestore?: boolean;
}
export interface PreparedMedia {
  requestedAt?: number;
  sessionId: string; url: string; format: "hls" | "progressive"; providerId: string;
  /** 本地离线文件：走原生 HLS/文件播放，不经插件会话与 media.activity。 */
  localFile?: boolean;
  /** HLS TS 离线包：经 IPC loader 读取，不用 WebView XHR 访问 asset。 */
  offlineDownloadId?: string;
  playback: Omit<PlaybackInfo, "streams">;
  choices: { source: PlaybackChoices; resolver?: PlaybackChoices; resolverRoute?: ResolverRoute };
}
export interface ResolverRoute {
  host: string; forced: boolean; selectedId?: string; resolvers: { id: string; name: string }[];
}
export interface PlaybackChoices {
  pluginId: string; name?: string; servers: PlaybackServer[]; serverId?: string | null; streamIndex: number;
  streams: { index: number; label?: string; height?: number; bitrate?: number; codec?: Codec; kind?: string; format?: MediaFormat; serverId?: string }[];
}
export type AuthFailure = { id: string; code: "AUTH_REQUIRED" | "AUTH_EXPIRED"; message: string; silent?: boolean };
const authListeners = new Set<(failure: AuthFailure) => void>();
const authSuccessListeners = new Set<(id: string) => void>();
let mediaReady: Promise<unknown> | undefined;
function ensureMediaCapabilities() {
  // All first-use requests share registration; retry a failed IPC on the next action.
  return mediaReady ??= invoke("hpp_manage", { action: "host.media.configure", params: probeMediaCapabilities() }).catch(error => {
    mediaReady = undefined;
    throw error;
  });
}
export function onPluginAuthFailure(listener: (failure: AuthFailure) => void) {
  authListeners.add(listener);
  return () => { authListeners.delete(listener); };
}
export function onPluginAuthSuccess(listener: (id: string) => void) {
  authSuccessListeners.add(listener);
  return () => { authSuccessListeners.delete(listener); };
}
export async function pluginCommand<T>(action: string, params: Record<string, unknown> = {}, options: { notifyAuth?: boolean } = {}): Promise<T> {
  try {
    await ensureMediaCapabilities();
    const result = await invoke<T>("hpp_manage", { action, params });
    if (["updates.startup", "updates.tick", "updates.install"].includes(action) && (result as { changed?: boolean })?.changed) window.dispatchEvent(new Event("hpp.changed"));
    if (["updates.check", "updates.policy.set", "updates.install", "updates.dismiss", "subscriptions.save", "subscriptions.remove"].includes(action)) window.dispatchEvent(new Event("hpp.updates.changed"));
    if (["import", "enable", "retry", "remove", "restore", "distribution.apply", "settings.set", "endpoint.set", "endpoint.list"].includes(action)) window.dispatchEvent(new Event("hpp.changed"));
    const isAuth = action === "form.submit" && (params.target as { kind?: string })?.kind === "auth" || action === "call" && params.method === "auth.submit";
    if (action === 'call' && params.method === 'auth.logout') window.dispatchEvent(new Event('hpp.changed'));
    if (isAuth && typeof params.id === "string" && (result as { status?: string })?.status === "ok") {
      for (const listener of authSuccessListeners) listener(params.id);
    }
    return result;
  }
  catch (error) {
    const failure = error as (Partial<PluginFailure> & { pluginId?: string }) | null;
    if (typeof params.id === "string" && (failure?.code === "AUTH_REQUIRED" || failure?.code === "AUTH_EXPIRED")) {
      for (const listener of authListeners) listener({ id: failure.pluginId || params.id, code: failure.code, message: pluginError(error), silent: options.notifyAuth === false });
    }
    throw error;
  }
}
export function openPluginLink(url: string) { return invoke<void>("open_url", { url }); }
export function pluginError(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return typeof error === "string" ? error : "插件操作失败";
}
export function releaseMedia(sessionId: string) { void pluginCommand("media.release", { sessionId }).then(() => window.dispatchEvent(new Event("hpp.playback.idle"))).catch(() => {}); }
