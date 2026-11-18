import { invoke } from "@tauri-apps/api/core";
import {
  LoadStats,
  type FragmentLoaderConstructor,
  type HlsConfig,
  type Loader,
  type LoaderCallbacks,
  type LoaderConfiguration,
  type LoaderContext,
  type PlaylistLoaderConstructor,
} from "hls.js";

const SCHEME = "hghub-offline://";

export function offlineHlsManifestUrl(downloadId: string) {
  return `${SCHEME}${downloadId}/index.m3u8`;
}

export function parseOfflineHlsResource(url: string, downloadId: string): string {
  const expect = `${SCHEME}${downloadId}/`;
  if (url.startsWith(expect)) return url.slice(expect.length).split("?")[0] ?? "";
  if (url.startsWith(SCHEME)) {
    throw new Error(`OFFLINE_HLS_WRONG_TASK: 请求 URL 不属于任务 ${downloadId}`);
  }
  if (/^https?:\/\//i.test(url)) {
    throw new Error("OFFLINE_HLS_REMOTE_BLOCKED: 离线播放禁止访问远程地址");
  }
  if (!url.includes("://")) return url.split("?")[0] ?? "";
  throw new Error(`OFFLINE_HLS_BAD_URL: ${url.slice(0, 96)}`);
}

function b64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

type ReadResponse = {
  name: string;
  bytes: number;
  mime: string;
  dataB64: string;
  loader?: string;
};

function makeLoaderClass(downloadId: string) {
  return class OfflineHlsLoader implements Loader<LoaderContext> {
    public context: LoaderContext | null = null;
    private aborted = false;
    stats = new LoadStats();

    constructor(_config: HlsConfig) {}

    getStats() {
      return this.stats;
    }

    load(
      context: LoaderContext,
      _config: LoaderConfiguration,
      callbacks: LoaderCallbacks<LoaderContext>,
    ): void {
      this.context = context;
      this.aborted = false;
      const resource = parseOfflineHlsResource(context.url, downloadId);
      const t0 = performance.now();
      void invoke<ReadResponse>("download_manage", {
        action: "offlineHlsRead",
        params: { id: downloadId, resource },
      })
        .then(res => {
          if (this.aborted) return;
          const raw = b64ToArrayBuffer(res.dataB64);
          if (raw.byteLength !== res.bytes) {
            throw new Error(`OFFLINE_HLS_SIZE_MISMATCH: 期望 ${res.bytes} 字节，收到 ${raw.byteLength}`);
          }
          const playlist = /\.m3u8$/i.test(resource);
          const data: string | ArrayBuffer = playlist
            ? new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(raw))
            : raw;
          const t1 = performance.now();
          this.stats.loading.start = t0;
          this.stats.loading.first = t0;
          this.stats.loading.end = t1;
          this.stats.loaded = raw.byteLength;
          this.stats.total = raw.byteLength;
          callbacks.onSuccess({ url: context.url, data }, this.stats, context, undefined);
        })
        .catch(err => {
          if (this.aborted) return;
          const text = err instanceof Error ? err.message : String(err);
          callbacks.onError({ code: 0, text: `OFFLINE_IPC_LOADER: ${text}` }, context, null, this.stats);
        });
    }

    abort(): void {
      this.aborted = true;
      this.stats.aborted = true;
    }

    destroy(): void {
      this.aborted = true;
      this.context = null;
    }
  };
}

export function createOfflineHlsLoader(downloadId: string): FragmentLoaderConstructor & PlaylistLoaderConstructor {
  return makeLoaderClass(downloadId) as unknown as FragmentLoaderConstructor & PlaylistLoaderConstructor;
}