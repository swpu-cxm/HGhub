package com.hghub.player

import com.fasterxml.jackson.databind.ObjectMapper
import org.junit.Assert.assertEquals
import org.junit.Test

/** Mirrors production Jackson binding used by app.tauri.plugin.Invoke.parseArgs. */
class AppUpdateArgsDeserTest {
  private val mapper = ObjectMapper()

  @Test
  fun deserializeApkPathArgs_releaseJsonShape() {
    val json =
      """{"path":"/data/user/0/com.hghub.player/updates/HGhub_0.0.6.0-swpu-install-test_arm64.apk"}"""
    val args = mapper.readValue(json, ApkPathArgs::class.java)
    assertEquals(
      "/data/user/0/com.hghub.player/updates/HGhub_0.0.6.0-swpu-install-test_arm64.apk",
      args.path,
    )
  }

  @Test
  fun deserializeApkPathArgs_emptyPath() {
    val args = mapper.readValue("""{"path":""}""", ApkPathArgs::class.java)
    assertEquals("", args.path)
  }
}