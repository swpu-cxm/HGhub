package com.hghub.player

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.annotation.Keep
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@Keep
@TauriPlugin
class AppUpdatePlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun getAbi(invoke: Invoke) {
    val ret = JSObject()
    ret.put("abi", currentAbi())
    invoke.resolve(ret)
  }

  @Command
  fun canRequestPackageInstalls(invoke: Invoke) {
    val allowed =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        activity.packageManager.canRequestPackageInstalls()
      } else {
        true
      }
    val ret = JSObject()
    ret.put("allowed", allowed)
    invoke.resolve(ret)
  }

  @Command
  fun openUnknownAppSourcesSettings(invoke: Invoke) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
        .setData(Uri.parse("package:${activity.packageName}"))
      activity.startActivity(intent)
    }
    invoke.resolve()
  }

  @Command
  fun getBuildInfo(invoke: Invoke) {
    try {
      val pm = activity.packageManager
      val info =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          pm.getPackageInfo(activity.packageName, PackageManager.PackageInfoFlags.of(0))
        } else {
          @Suppress("DEPRECATION")
          pm.getPackageInfo(activity.packageName, 0)
        }
      val code =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode
        else @Suppress("DEPRECATION") info.versionCode.toLong()
      val ret = JSObject()
      ret.put("packageName", activity.packageName)
      ret.put("versionName", info.versionName ?: "")
      ret.put("versionCode", code)
      ret.put("sdkInt", Build.VERSION.SDK_INT)
      invoke.resolve(ret)
    } catch (error: Exception) {
      invoke.reject(error.message ?: error.javaClass.simpleName)
    }
  }

  @Command
  fun inspectApk(invoke: Invoke) {
  try {
      val path = parseApkPath(invoke) ?: return
      val source = File(path)
      if (!source.isFile) {
        invoke.reject("找不到安装包：$path")
        return
      }
      val pm = activity.packageManager
      val flags =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
          PackageManager.GET_SIGNING_CERTIFICATES
        } else {
          @Suppress("DEPRECATION")
          PackageManager.GET_SIGNATURES
        }
      @Suppress("DEPRECATION")
      val info = pm.getPackageArchiveInfo(path, flags)
      if (info == null) {
        invoke.reject("PackageManager 无法解析 APK（getPackageArchiveInfo 为 null）")
        return
      }
      info.applicationInfo?.sourceDir = path
      info.applicationInfo?.publicSourceDir = path
      AppUpdateSigningPolicy.assertTrustedArchive(pm, path)?.let { msg ->
        invoke.reject(msg)
        return
      }
      val code =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode
        else @Suppress("DEPRECATION") info.versionCode.toLong()
      val cert = AppUpdateSigningPolicy.archiveSigningSha256(pm, path) ?: ""
      val ret = JSObject()
      ret.put("packageName", info.packageName ?: "")
      ret.put("versionName", info.versionName ?: "")
      ret.put("versionCode", code)
      ret.put("apkBytes", source.length())
      ret.put("certSha256", cert)
      invoke.resolve(ret)
    } catch (error: Exception) {
      invoke.reject(error.message ?: error.javaClass.simpleName)
    }
  }

  @Command
  fun installApk(invoke: Invoke) {
    try {
      val path = parseApkPath(invoke) ?: return
      val source = File(path)
      if (!source.isFile) {
        invoke.reject("找不到安装包：$path")
        return
      }
      if (source.length() < 64 * 1024) {
        invoke.reject("安装包过小（${source.length()} 字节），可能下载不完整")
        return
      }
      val pm = activity.packageManager
      AppUpdateSigningPolicy.assertTrustedArchive(pm, path)?.let { msg ->
        invoke.reject(msg)
        return
      }
      val forProvider = ensureFileProviderPath(source)
      val authority = activity.packageName + ".fileprovider"
      val uri =
        try {
          FileProvider.getUriForFile(activity, authority, forProvider)
        } catch (error: IllegalArgumentException) {
          invoke.reject(
            "无法通过 FileProvider 读取安装包，请确认文件位于应用私有 updates 目录",
          )
          return
        }
      val intent = AppUpdateIntents.buildInstallIntent(uri)
      val flags =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
          PackageManager.MATCH_DEFAULT_ONLY
        } else {
          0
        }
      val handlers = pm.queryIntentActivities(intent, flags)
      if (handlers.isEmpty()) {
        invoke.reject(
          "系统未返回 APK 安装程序（Android ${Build.VERSION.SDK_INT}）。请确认清单 queries 已声明 VIEW+package-archive。",
        )
        return
      }
      for (resolve in handlers) {
        val pkg = resolve.activityInfo.packageName
        activity.grantUriPermission(pkg, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      try {
        activity.startActivity(intent)
      } catch (error: ActivityNotFoundException) {
        invoke.reject("无法启动安装程序界面")
        return
      }
      val ret = JSObject()
      ret.put("launched", true)
      ret.put("installerCount", handlers.size)
      ret.put("apkBytes", source.length())
      invoke.resolve(ret)
    } catch (error: Exception) {
      invoke.reject(error.message ?: error.javaClass.simpleName)
    }
  }

  private fun parseApkPath(invoke: Invoke): String? {
    val args =
      try {
        invoke.parseArgs(ApkPathArgs::class.java)
      } catch (error: Exception) {
        invoke.reject(
          "APP_UPDATE_ARGS: 无法解析安装参数（${error.javaClass.simpleName}: ${error.message}）",
          error,
        )
        return null
      }
    val path = args.path.trim()
    if (path.isEmpty()) {
      invoke.reject("缺少 path")
      return null
    }
    val canonical =
      try {
        File(path).canonicalFile
      } catch (_: Exception) {
        invoke.reject("安装路径无效")
        return null
      }
    if (!isUnderUpdatesDir(canonical)) {
      invoke.reject("仅允许安装应用 updates 目录内的 APK")
      return null
    }
    return canonical.path
  }

  private fun updatesRoots(): List<File> =
    listOf(
      File(activity.filesDir, "updates"),
      File(activity.applicationInfo.dataDir, "updates"),
    )

  private fun isUnderUpdatesDir(file: File): Boolean {
    val target = file.canonicalFile
    return updatesRoots().any { root ->
      root.mkdirs()
      target.path.startsWith(root.canonicalFile.path)
    }
  }

  /** FileProvider 仅映射 filesDir/updates；必要时从 dataDir/updates 复制。 */
  private fun ensureFileProviderPath(source: File): File {
    val filesUpdates = File(activity.filesDir, "updates").apply { mkdirs() }
    val filesRoot = filesUpdates.canonicalFile
    val canonical = source.canonicalFile
    if (canonical.path.startsWith(filesRoot.path)) return canonical
    val dest = File(filesUpdates, canonical.name)
    if (dest.exists() && dest.length() == canonical.length()) return dest
    canonical.inputStream().use { input ->
      dest.outputStream().use { output -> input.copyTo(output) }
    }
    return dest
  }

  private fun currentAbi(): String {
    val abis = Build.SUPPORTED_ABIS ?: emptyArray()
    return when {
      abis.any { it.contains("arm64", true) } -> "aarch64"
      abis.any { it.contains("armeabi", true) || it.contains("armv7", true) } -> "armv7"
      abis.any { it.contains("x86_64", true) } -> "x86_64"
      else -> "aarch64"
    }
  }
}