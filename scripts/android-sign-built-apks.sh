#!/usr/bin/env bash
# 对 Tauri 产出的 release APK 做 zipalign（如需要）+ apksigner 签名与指纹校验。口令仅经环境变量传入，不入日志。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:?version label e.g. 0.0.4-swpu-install-test}"
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
[ -n "$SDK" ] || { echo "ANDROID_SDK_ROOT 未设置" >&2; exit 1; }
BT="$(ls "$SDK/build-tools" | sort -V | tail -1)"
APKSIGNER="$SDK/build-tools/$BT/apksigner"
ZIPALIGN="$SDK/build-tools/$BT/zipalign"
KS="${ANDROID_KEYSTORE_PATH:?}"
ALIAS="${ANDROID_KEY_ALIAS:?}"
STORE_PW="${ANDROID_KEYSTORE_PASSWORD:?}"
KEY_PW="${ANDROID_KEY_PASSWORD:?}"
mkdir -p "$ROOT/release-out" "$ROOT/checksums"
mapfile -t APKS < <(find "$ROOT/src-tauri/gen/android/app/build/outputs/apk" -name '*-release*.apk' 2>/dev/null || true)
[ "${#APKS[@]}" -gt 0 ] || { echo "未找到 release APK，请先 pnpm tauri android build" >&2; exit 1; }
for f in "${APKS[@]}"; do
  abi="$(basename "$(dirname "$(dirname "$f")")")"
  aligned="$ROOT/release-out/.aligned-${abi}.apk"
  "$ZIPALIGN" -f -p 4 "$f" "$aligned"
  out="$ROOT/release-out/HGhub_${VERSION}_${abi}.apk"
  "$APKSIGNER" sign --ks "$KS" --ks-key-alias "$ALIAS" \
    --ks-pass "env:ANDROID_KEYSTORE_PASSWORD" --key-pass "env:ANDROID_KEY_PASSWORD" \
    --v4-signing-enabled false --out "$out" "$aligned"
  "$APKSIGNER" verify --print-certs "$out" | head -3
  node "$ROOT/scripts/verify-android-apk-cert.mjs" "$out"
  sha256sum "$out" | tee "$ROOT/checksums/HGhub_${VERSION}_${abi}.apk.sha256"
  rm -f "$aligned"
done
ls -lh "$ROOT/release-out" "$ROOT/checksums"