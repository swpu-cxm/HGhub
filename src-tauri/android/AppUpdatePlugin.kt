package com.hghub.player

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.annotation.Keep
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.PermissionState
import app.tauri.plugin.Plugin
import java.io.File

@Keep
@TauriPlugin
class AppUpdatePlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun getAbi(invoke: Invoke) {
    invoke.resolve(mapOf("abi" to currentAbi()))
  }

  @Command
  fun canRequestPackageInstalls(invoke: Invoke) {
  invoke.resolve(
      mapOf(
        "allowed" to
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            activity.packageManager.canRequestPackageInstalls()
          } else {
            true
          },
      ),
    )
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
  fun installApk(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(InstallArgs::class.java)
      val source = File(args.path)
      if (!source.exists()) {
        invoke.reject("找不到安装包")
        return
      }
      val uri = FileProvider.getUriForFile(
        activity,
        activity.packageName + ".fileprovider",
        source,
      )
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      activity.startActivity(intent)
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject(error.message)
    }
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

  private class InstallArgs { @JvmField var path: String = "" }
}