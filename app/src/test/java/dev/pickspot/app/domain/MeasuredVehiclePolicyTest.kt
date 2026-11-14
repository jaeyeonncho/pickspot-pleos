package dev.pickspot.app.domain

import org.junit.Assert.*
import org.junit.Test

class MeasuredVehiclePolicyTest {
    private val policy = MeasuredVehiclePolicy()
    private val epoch = 1_800_000_000_000L
    private val elapsed = 100_000L
    private fun sample() = MeasuredVehicleSample(37.484, 127.030, epoch, elapsed, 12f)
    @Test fun `measured accuracy is preserved without converting Pleos confidence`() {
        val fix = policy.validate(sample(), epoch, elapsed)!!
        assertEquals(12f, fix.accuracyMeters)
        assertEquals(GeoPoint(37.484, 127.030), fix.point)
        assertTrue(fix.isFresh(epoch + 29_999, elapsed + 29_999))
        assertFalse(fix.isFresh(epoch + 30_000, elapsed + 30_000))
    }
    @Test fun `missing nonfinite nonpositive and poor accuracy are refused`() {
        for (value in listOf(null, Float.NaN, Float.POSITIVE_INFINITY, 0f, -1f, 101f))
            assertNull(policy.validate(sample().copy(accuracyMeters = value), epoch, elapsed))
        assertNotNull(policy.validate(sample().copy(accuracyMeters = 100f), epoch, elapsed))
    }
    @Test fun `old elapsed timestamp cannot be freshened by a recent wall timestamp`() {
        assertNull(policy.validate(sample().copy(measuredElapsedMillis = elapsed - 30_000), epoch, elapsed))
        assertNull(policy.validate(sample().copy(observedAtMillis = epoch - 30_000), epoch, elapsed))
    }
    @Test fun `future and impossible clock values are refused`() {
        assertNull(policy.validate(sample().copy(observedAtMillis = epoch + 5_001), epoch, elapsed))
        assertNull(policy.validate(sample().copy(measuredElapsedMillis = elapsed + 1), epoch, elapsed))
        assertNull(policy.validate(sample().copy(measuredElapsedMillis = -1), epoch, elapsed))
        val fix = policy.validate(sample().copy(observedAtMillis = epoch + 5_000), epoch, elapsed)!!
        assertFalse(fix.isFresh(epoch + 30_000, elapsed + 30_000))
    }
    @Test fun `clock rollback and monotonic ageing invalidate accepted fixes`() {
        val fix = policy.validate(sample(), epoch, elapsed)!!
        assertFalse(fix.isFresh(epoch - 1, elapsed))
        assertFalse(fix.isFresh(epoch, elapsed - 1))
        assertFalse(fix.isFresh(epoch, elapsed + 30_000))
    }
    @Test fun `invalid coordinates do not become usable locations`() {
        assertNull(policy.validate(sample().copy(latitude = Double.NaN), epoch, elapsed))
        assertNull(policy.validate(sample().copy(longitude = 181.0), epoch, elapsed))
    }
}
