package com.hghub.player

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.os.Build

object AppUpdateIntents {
  const val APK_MIME = "application/vnd.android.package-archive"

  fun buildInstallIntent(uri: Uri): Intent =
    Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(uri, APK_MIME)
      addCategory(Intent.CATEGORY_DEFAULT)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN) {
        clipData = ClipData.newRawUri("", uri)
      }
    }
}