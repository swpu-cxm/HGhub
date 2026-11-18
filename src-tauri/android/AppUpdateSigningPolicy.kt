package com.hghub.player

import android.content.pm.PackageManager
import android.content.pm.Signature
import android.os.Build
import java.security.MessageDigest

object AppUpdateSigningPolicy {
  /** Matches android-signing/signing-identity.json (public certificate fingerprint). */
  const val EXPECTED_CERT_SHA256 =
    "85:4C:C8:68:DF:ED:17:FA:1D:90:2B:60:C3:C7:B6:AC:D2:CE:DA:6D:23:85:39:E6:63:9C:51:44:41:22:55:AD"

  private fun normalizeSha256(hex: String): String {
    val raw = hex.uppercase().replace("[^A-F0-9]".toRegex(), "")
    return raw.chunked(2).joinToString(":")
  }

  private fun sha256OfSignature(signature: Signature): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())
  return digest.joinToString(":") { b -> "%02X".format(b) }
  }

  fun archiveSigningSha256(pm: PackageManager, apkPath: String): String? {
    val flags =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        PackageManager.GET_SIGNING_CERTIFICATES
      } else {
        @Suppress("DEPRECATION") PackageManager.GET_SIGNATURES
      }
    @Suppress("DEPRECATION")
    val info = pm.getPackageArchiveInfo(apkPath, flags) ?: return null
    info.applicationInfo?.sourceDir = apkPath
    info.applicationInfo?.publicSourceDir = apkPath
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      val signingInfo = info.signingInfo ?: return null
      val signatures =
        if (signingInfo.hasMultipleSigners()) {
          signingInfo.apkContentsSigners
        } else {
          signingInfo.signingCertificateHistory
        } ?: return null
      if (signatures.isEmpty()) return null
      return sha256OfSignature(signatures[0])
    }
    @Suppress("DEPRECATION")
    val legacy = info.signatures ?: return null
    if (legacy.isEmpty()) return null
    return sha256OfSignature(legacy[0])
  }

  fun assertTrustedArchive(pm: PackageManager, apkPath: String): String? {
    val got = archiveSigningSha256(pm, apkPath) ?: return "无法读取 APK 签名证书"
    val want = normalizeSha256(EXPECTED_CERT_SHA256)
    val have = normalizeSha256(got)
    return if (want == have) null else "安装包签名不匹配（期望 HGhub 发布证书，实际 ${have.take(23)}…）"
  }
}