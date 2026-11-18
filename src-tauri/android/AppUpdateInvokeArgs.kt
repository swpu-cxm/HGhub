package com.hghub.player

import androidx.annotation.Keep
import app.tauri.annotation.InvokeArg

/** Tauri mobile-plugin args; must be public top-level @InvokeArg (see PathPlugin / consumer-rules.pro). */
@InvokeArg
@Keep
class ApkPathArgs {
  @JvmField var path: String = ""
}