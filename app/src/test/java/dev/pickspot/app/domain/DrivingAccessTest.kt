package dev.pickspot.app.domain

import org.junit.Assert.assertEquals
import org.junit.Test

class DrivingAccessTest {
    @Test fun `only baseline without distraction optimization enables interaction`() {
        assertEquals(DrivingAccess.AVAILABLE, DrivingAccess.fromPlatform(false, 0))
        assertEquals(DrivingAccess.RESTRICTED, DrivingAccess.fromPlatform(true, 0))
        for (flags in listOf(1, 8, 64, 511, 1 shl 20)) {
            assertEquals(DrivingAccess.RESTRICTED, DrivingAccess.fromPlatform(false, flags))
            assertEquals(DrivingAccess.RESTRICTED, DrivingAccess.fromPlatform(true, flags))
        }
    }
    @Test fun `invalid flags are unknown and never interpreted as baseline`() {
        assertEquals(DrivingAccess.UNKNOWN, DrivingAccess.fromPlatform(false, -1))
    }
}
