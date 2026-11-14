package dev.pickspot.app.domain

import org.junit.Assert.*
import org.junit.Test

class LaunchModePolicyTest {
    @Test fun `launcher restores only known local connections`() {
        assertEquals("competition", LaunchModePolicy.resolve(null,"competition"))
        assertEquals("local", LaunchModePolicy.resolve(null,"local"))
        assertNull(LaunchModePolicy.resolve(null,"timeout"))
        assertNull(LaunchModePolicy.resolve(null,"https://example.com"))
        assertNull(LaunchModePolicy.resolve(null,null))
    }
    @Test fun `explicit fixture or connection overrides the previous launch`() {
        assertEquals("empty", LaunchModePolicy.resolve("empty","competition"))
        assertEquals("local", LaunchModePolicy.resolve("local","competition"))
    }
}
