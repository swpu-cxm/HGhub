import { UPDATE_GITHUB_OWNER, UPDATE_GITHUB_REPO, type UpdateAuth } from "./updateConfig";

const releaseLatestApi = (owner: string, repo: string) =>
  `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
const releaseListApi = (owner: string, repo: string, perPage = 30) =>
  `https://api.github.com/repos/${owner}/${repo}/releases?per_page=${perPage}`;
const releasePage = (owner: string, repo: string, tag: string) =>
  `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(tag)}`;

export type AppRelease = {
  tag: string;
  url: string;
  available: boolean;
  apkUrl?: string;
  apkSha256?: string;
  apkName?: string;
};

export type ParsedAppVersion = { core: bigint[]; label?: string };

export class VersionParseError extends Error {
  constructor(scope: "当前版本" | "发布标签" | "版本号") {
    super(`无法识别${scope}，请稍后重试`);
    this.name = "VersionParseError";
  }
}

/** 解析 HGhub 私有安装测试版本：支持 v 前缀、任意段数字核心（如 0.0.5.1）、-swpu-install-test 等后缀。 */
export function parseAppVersion(value: string): ParsedAppVersion {
  const raw = value.trim();
  if (!raw || /\s/.test(raw) || raw.includes("/")) throw new VersionParseError("版本号");
  const body = raw.startsWith("v") || raw.startsWith("V") ? raw.slice(1) : raw;
  const dash = body.indexOf("-");
  const corePart = dash >= 0 ? body.slice(0, dash) : body;
  const label = dash >= 0 ? body.slice(dash + 1) : undefined;
  if (!/^\d+(?:\.\d+)*$/.test(corePart)) throw new VersionParseError("版本号");
  const parts = corePart.split(".");
  if (parts.some(p => p.length > 1 && p.startsWith("0"))) throw new VersionParseError("版本号");
  const core = parts.map(p => BigInt(p));
  return { core, label: label || undefined };
}

export function compareVersions(left: string, right: string): number {
  const a = parseAppVersion(left);
  const b = parseAppVersion(right);
  const len = Math.max(a.core.length, b.core.length);
  for (let i = 0; i < len; i++) {
    const x = a.core[i] ?? 0n;
    const y = b.core[i] ?? 0n;
    if (x !== y) return x > y ? 1 : -1;
  }
  const la = a.label ?? "";
  const lb = b.label ?? "";
  if (la === lb) return 0;
  if (!la && lb) return 1;
  if (la && !lb) return -1;
  return la > lb ? 1 : la < lb ? -1 : 0;
}

function authHeaders(auth?: UpdateAuth) {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (auth?.bearerToken) headers.Authorization = `Bearer ${auth.bearerToken}`;
  return headers;
}

export function androidAbiFromUa(ua = navigator.userAgent) {
  if (/arm64|aarch64/i.test(ua)) return "aarch64";
  if (/armv7|armeabi/i.test(ua)) return "armv7";
  if (/x86_64|x64/i.test(ua)) return "x86_64";
  return "aarch64";
}

function pickApkAsset(
  assets: { name: string; browser_download_url: string; digest?: string; content_type?: string }[],
  abi: string,
) {
  const apk = assets.filter(
    a =>
      a.content_type === "application/vnd.android.package-archive" ||
      /\.apk$/i.test(a.name),
  );
  const match =
    apk.find(a => /_arm64\.apk$/i.test(a.name) && abi === "aarch64") ||
    apk.find(a => a.name.includes(`_${abi}`)) ||
    apk.find(a => a.name.includes(abi)) ||
    apk.find(a => /universal/i.test(a.name)) ||
    apk[0];
  if (!match) return null;
  const sha = match.digest?.startsWith("sha256:")
    ? match.digest.slice("sha256:".length).toLowerCase()
    : undefined;
  return { url: match.browser_download_url, name: match.name, sha256: sha };
}

type GhRelease = {
  tag_name: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string; digest?: string; content_type?: string }[];
};

function releasePageMatches(owner: string, repo: string, tag: string, html_url: string) {
  const expected = releasePage(owner, repo, tag);
  return html_url === expected || html_url === `https://github.com/${owner}/${repo}/releases/tag/${tag}`;
}

function isInstallChannelTag(tag: string) {
  return /-swpu-/i.test(tag);
}

/** 在 fork 的 Release 列表中选取带 APK 的最高版本；优先 swpu 安装测试通道。 */
export function selectBestRelease(releases: GhRelease[], abi: string, channelSuffix = "swpu-install-test") {
  const candidates = releases.filter(r => {
    if (r.draft) return false;
    try {
      parseAppVersion(r.tag_name);
    } catch {
      return false;
    }
    const apk = pickApkAsset(Array.isArray(r.assets) ? r.assets : [], abi);
    if (!apk) return false;
    if (!isInstallChannelTag(r.tag_name)) return false;
    return r.tag_name.replace(/^v/i, "").endsWith(channelSuffix) || r.tag_name.includes(channelSuffix);
  });
  if (!candidates.length) return null;
  candidates.sort((x, y) => compareVersions(y.tag_name, x.tag_name));
  return candidates[0] ?? null;
}

export function releaseFromGh(
  data: GhRelease,
  currentVersion: string,
  owner: string,
  repo: string,
  abi: string,
): AppRelease {
  if (!data || typeof data.tag_name !== "string" || typeof data.html_url !== "string") {
    throw new Error("GitHub 返回的发布信息无效，请稍后重试");
  }
  if (data.draft) throw new Error("当前最新发布仍为草稿，请稍后再试");
  let available: boolean;
  try {
    available = compareVersions(data.tag_name, currentVersion) > 0;
  } catch (e) {
    if (e instanceof VersionParseError) throw e;
    throw new Error("无法比较版本号，请稍后重试");
  }
  if (!releasePageMatches(owner, repo, data.tag_name, data.html_url)) {
    throw new Error("GitHub 返回的发布链接无效，请稍后重试");
  }
  const asset = pickApkAsset(Array.isArray(data.assets) ? data.assets : [], abi);
  if (!asset) throw new Error("最新发布未包含本机架构的 Android 安装包");
  return {
    tag: data.tag_name,
    url: data.html_url,
    available,
    apkUrl: asset.url,
    apkSha256: asset.sha256,
    apkName: asset.name,
  };
}

async function fetchGithubJson(url: string, signal: AbortSignal, auth?: UpdateAuth) {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: authHeaders(auth),
      credentials: "omit",
      cache: "no-store",
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error("无法连接 GitHub，请检查网络后重试");
  }
  if (response.status === 404) return null;
  if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) {
    throw new Error("GitHub 请求次数已达上限，请稍后重试");
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("无法访问更新发布（可能需要配置访问凭据）");
  }
  if (!response.ok) throw new Error(`检查更新失败（HTTP ${response.status}），请稍后重试`);
  try {
    return await response.json();
  } catch {
    throw new Error("GitHub 返回的发布信息无效，请稍后重试");
  }
}

export async function checkAppUpdate(
  currentVersion: string,
  signal: AbortSignal,
  auth?: UpdateAuth,
  owner = UPDATE_GITHUB_OWNER,
  repo = UPDATE_GITHUB_REPO,
  abi?: string,
): Promise<AppRelease | null> {
  try {
    parseAppVersion(currentVersion);
  } catch {
    throw new VersionParseError("当前版本");
  }
  const resolvedAbi = abi ?? androidAbiFromUa();
  const latest = await fetchGithubJson(releaseLatestApi(owner, repo), signal, auth);
  if (latest) {
    try {
      return releaseFromGh(latest as GhRelease, currentVersion, owner, repo, resolvedAbi);
    } catch (e) {
      if (e instanceof VersionParseError) throw e;
      throw e;
    }
  }
  const list = await fetchGithubJson(releaseListApi(owner, repo), signal, auth);
  if (!list || !Array.isArray(list)) return null;
  const picked = selectBestRelease(list as GhRelease[], resolvedAbi);
  if (!picked) return null;
  return releaseFromGh(picked, currentVersion, owner, repo, resolvedAbi);
}