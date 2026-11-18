package com.hghub.player

import com.fasterxml.jackson.databind.ObjectMapper
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors production Jackson binding used by app.tauri.plugin.Invoke.parseArgs. */
class OrientationArgsDeserTest {
  private val mapper = ObjectMapper()

  @Test
  fun deserializeLandscapeTrue_releaseJsonShape() {
    val args = mapper.readValue("""{"landscape":true}""", OrientationArgs::class.java)
    assertTrue(args.landscape)
  }

  @Test
  fun deserializeLandscapeFalse() {
    val args = mapper.readValue("""{"landscape":false}""", OrientationArgs::class.java)
    assertFalse(args.landscape)
  }
}