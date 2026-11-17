import { UPDATE_GITHUB_OWNER, UPDATE_GITHUB_REPO, type UpdateAuth } from "./updateConfig";

const releaseApi = (owner: string, repo: string) =>
  `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
const releasePage = (owner: string, repo: string, tag: string) =>
  `https://github.com/${owner}/${repo}/releases/tag/${tag}`;

export type AppRelease = {
  tag: string;
  url: string;
  available: boolean;
  apkUrl?: string;
  apkSha256?: string;
  apkName?: string;
};

function versionParts(value: string) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(value);
  const prerelease = match?.[4]?.split(".") ?? [];
  if (!match || prerelease.some(part => /^0\d+$/.test(part))) throw new Error("无法识别版本号，请稍后重试");
  return { core: match.slice(1, 4).map(BigInt), prerelease };
}

// SemVer precedence: numeric components, then prerelease identifiers; ignore build metadata.
export function compareVersions(left: string, right: string): number {
  const a = versionParts(left), b = versionParts(right);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  if (!a.prerelease.length || !b.prerelease.length) return Number(!a.prerelease.length) - Number(!b.prerelease.length);
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i], y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (nx !== ny) return nx ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
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

export async function checkAppUpdate(
  currentVersion: string,
  signal: AbortSignal,
  auth?: UpdateAuth,
  owner = UPDATE_GITHUB_OWNER,
  repo = UPDATE_GITHUB_REPO,
  abi?: string,
): Promise<AppRelease | null> {
  let response: Response;
  const api = releaseApi(owner, repo);
  try {
    response = await fetch(api, {
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
  let data;
  try { data = await response.json(); }
  catch { throw new Error("GitHub 返回的发布信息无效，请稍后重试"); }
  if (!data || typeof data.tag_name !== "string" || typeof data.html_url !== "string" || data.draft !== false || data.prerelease !== false) {
    throw new Error("GitHub 返回的发布信息无效，请稍后重试");
  }
  const available = compareVersions(data.tag_name, currentVersion) > 0;
  const expected = releasePage(owner, repo, data.tag_name);
  if (data.html_url !== expected && data.html_url !== releasePage(owner, repo, encodeURIComponent(data.tag_name))) {
    throw new Error("GitHub 返回的发布链接无效，请稍后重试");
  }
  const asset = pickApkAsset(Array.isArray(data.assets) ? data.assets : [], abi ?? androidAbiFromUa());
  return {
    tag: data.tag_name,
    url: data.html_url,
    available,
    apkUrl: asset?.url,
    apkSha256: asset?.sha256,
    apkName: asset?.name,
  };
}