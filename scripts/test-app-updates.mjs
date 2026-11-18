import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const OWNER = 'swpu-cxm';
const REPO = 'HGhub';
const originalFetch = globalThis.fetch;
let calls = 0;
globalThis.fetch = async () => { calls++; throw new Error('No request expected'); };
const bundled = await build({ entryPoints: ['src/appUpdates.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const mod = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const {
  compareVersions,
  checkAppUpdate,
  parseAppVersion,
  selectBestRelease,
  VersionParseError,
} = mod;
assert.equal(calls, 0, 'Importing update support must not check automatically');

for (const [left, right, expected] of [
  ['v0.0.2', '0.0.1', 1], ['v0.10.0', '0.9.0', 1], ['1.0.0', '0.99.99', 1],
  ['v0.0.1', '0.0.1', 0], ['0.0.1', '0.0.2', -1],
  ['v0.0.5.1-swpu-install-test', '0.0.5-swpu-install-test', 1],
  ['v0.0.5.1-swpu-install-test', '0.0.5.1-swpu-install-test', 0],
  ['0.0.5.2-swpu-install-test', 'v0.0.5.1-swpu-install-test', 1],
  ['v0.0.4-swpu-install-test', '0.0.5-swpu-install-test', -1],
  ['1.0.0', '1.0.0-rc.1', 1],
]) assert.equal(compareVersions(left, right), expected, `${left} vs ${right}`);

assert.throws(() => compareVersions('v0.0.5.1-swpu-install-test', 'latest'), VersionParseError);
assert.throws(() => compareVersions('1.02.3', '0.0.1'), VersionParseError);

const p51 = parseAppVersion('v0.0.5.1-swpu-install-test');
assert.deepEqual(p51.core.map(String), ['0', '0', '5', '1']);
assert.equal(p51.label, 'swpu-install-test');

const picked = selectBestRelease([
  { tag_name: 'v0.0.4-swpu-install-test', draft: false, prerelease: true, html_url: 'x', assets: [{ name: 'HGhub_0.0.4_arm64.apk', browser_download_url: 'u', content_type: 'application/vnd.android.package-archive' }] },
  { tag_name: 'v0.0.5.1-swpu-install-test', draft: false, prerelease: false, html_url: 'y', assets: [{ name: 'HGhub_0.0.5_arm64.apk', browser_download_url: 'u2', content_type: 'application/vnd.android.package-archive' }] },
  { tag_name: 'v9.9.9', draft: false, prerelease: false, html_url: 'z', assets: [{ name: 'setup.exe', browser_download_url: 'w' }] },
], 'aarch64');
assert.equal(picked?.tag_name, 'v0.0.5.1-swpu-install-test');

const controller = new AbortController();
const release = (tag = 'v0.0.2', prerelease = false) => ({
  tag_name: tag,
  html_url: `https://github.com/${OWNER}/${REPO}/releases/tag/${tag}`,
  draft: false,
  prerelease,
  assets: [{ name: 'HGhub_0.0.2_aarch64.apk', browser_download_url: `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/HGhub_0.0.2_aarch64.apk`, content_type: 'application/vnd.android.package-archive', digest: 'sha256:' + 'a'.repeat(64), state: 'uploaded' }],
});
function respondLatest(body, status = 200, headers = {}) {
  globalThis.fetch = async (url, options) => {
    calls++;
    if (String(url).includes('/releases/latest')) {
      assert.equal(options.credentials, 'omit');
      return new Response(body === null ? '' : JSON.stringify(body), { status: body === null ? 404 : status, headers });
    }
  if (String(url).includes('/releases?')) return new Response('[]', { status: 200 });
    throw new Error('unexpected url ' + url);
  };
}
respondLatest(release('v0.0.5.1-swpu-install-test'));
const up = await checkAppUpdate('0.0.5-swpu-install-test', controller.signal);
assert.equal(up.available, true);
assert.equal(up.tag, 'v0.0.5.1-swpu-install-test');

respondLatest(release('v0.0.5.1-swpu-install-test'));
assert.equal((await checkAppUpdate('0.0.5.1-swpu-install-test', controller.signal)).available, false);

respondLatest(release('v0.0.5.1-swpu-install-test', true));
const pre = await checkAppUpdate('0.0.5-swpu-install-test', controller.signal);
assert.equal(pre.available, true, 'prerelease with apk is accepted');

respondLatest(release());
const latest = await checkAppUpdate('0.0.1', controller.signal);
assert.deepEqual(latest?.available, true);

respondLatest(null);
assert.equal(await checkAppUpdate('0.0.1', controller.signal), null);

globalThis.fetch = async (url) => {
  if (String(url).includes('/releases/latest')) return new Response(JSON.stringify(release('v0.0.5.1-swpu-install-test')), { status: 200 });
  if (String(url).includes('/releases?')) {
    return new Response(JSON.stringify([release('v0.0.5.1-swpu-install-test')]), { status: 200 });
  }
};
assert.equal((await checkAppUpdate('0.0.5.1-swpu-install-test', controller.signal)).available, false);

for (const [body, status, headers, pattern] of [
  [{}, 403, { 'x-ratelimit-remaining': '0' }, /次数已达上限/], [{}, 429, {}, /次数已达上限/],
  [{}, 403, {}, /无法访问/], [{}, 500, {}, /HTTP 500/],
  [{ ...release(), draft: true }, 200, {}, /草稿/],
  [{ ...release(), html_url: 'https://example.com/update' }, 200, {}, /发布链接无效/],
  [{ ...release(), assets: [] }, 200, {}, /安装包/],
]) {
  respondLatest(body, status, headers);
  await assert.rejects(checkAppUpdate('0.0.5-swpu-install-test', controller.signal), pattern);
}
globalThis.fetch = async () => new Response('<html>bad gateway</html>');
await assert.rejects(checkAppUpdate('0.0.1', controller.signal), /发布信息无效/);
globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
await assert.rejects(checkAppUpdate('0.0.1', controller.signal), /无法连接 GitHub/);
globalThis.fetch = async (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
const cancelled = checkAppUpdate('0.0.1', controller.signal);
controller.abort();
await assert.rejects(cancelled, { name: 'AbortError' });
globalThis.fetch = originalFetch;

const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
for (const key of ['csp', 'devCsp']) {
  const connect = config.app.security[key].split(';').find(d => d.trim().startsWith('connect-src '));
  assert(connect.split(/\s+/).includes('https://api.github.com'), `${key} permits the release API`);
}
const pending = readFileSync("src/appUpdateInstall.ts", "utf8");
assert.match(pending, /reconcilePendingWithCandidate/);
assert.match(pending, /app_update_discard_downloads/);
console.log(`App update checks passed: 4-part swpu tags, same-version, prerelease, list fallback, errors, state machine`);