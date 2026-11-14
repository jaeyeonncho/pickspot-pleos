package dev.pickspot.app.domain

import org.junit.Assert.*
import org.junit.Test

class RouteSourceTest {
    @Test fun `TMAP example source requires real metrics and explicitly example inputs`() {
        assertEquals(RouteSource.TMAP_EXAMPLE, RouteSource.fromWire("tmap", false, "example"))
        for (input in listOf(null, "live", "unknown")) {
            assertThrows(IllegalArgumentException::class.java) { RouteSource.fromWire("tmap", false, input) }
        }
        assertThrows(IllegalArgumentException::class.java) { RouteSource.fromWire("tmap", true, "example") }
    }
    @Test fun `fixture and unknown source cannot be mistaken for real calculations`() {
        assertEquals(RouteSource.FIXTURE, RouteSource.fromWire("synthetic-fixture", true, null))
        assertEquals(RouteSource.FIXTURE, RouteSource.fromWire("synthetic-fixture", true, "example"))
        assertThrows(IllegalArgumentException::class.java) { RouteSource.fromWire("synthetic-fixture", false, "example") }
        assertThrows(IllegalArgumentException::class.java) { RouteSource.fromWire("unknown", false, "example") }
        assertThrows(IllegalArgumentException::class.java) { RouteSource.fromWire("synthetic-fixture", true, "live") }
    }
    @Test fun `only known failure categories are surfaced without provider details`() {
        assertEquals(RouteCalculationIssue.LIMIT, RouteCalculationIssue.fromWire("limit"))
        assertEquals(RouteCalculationIssue.CONFIGURATION, RouteCalculationIssue.fromWire("configuration"))
        assertEquals(RouteCalculationIssue.CONNECTION, RouteCalculationIssue.fromWire("connection"))
        assertEquals(RouteCalculationIssue.UNAVAILABLE, RouteCalculationIssue.fromWire("private provider error"))
        assertNull(RouteCalculationIssue.fromWire(null))
    }
}
