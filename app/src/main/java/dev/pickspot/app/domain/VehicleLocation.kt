package dev.pickspot.app.domain

/** Raw SDK confidence has no verified metre/range semantics. Never use it as accuracy. */
data class VehicleLocationSample(
    val latitude: Double, val longitude: Double,
    val observedAtEpochMillis: Long, val confidence: Float
)
data class VehicleFix(
    val point: GeoPoint, val observedAtEpochMillis: Long,
    val confidence: Float, val ageAtReceiptMillis: Long, val receivedAtElapsedMillis: Long
) {
    fun ageMillis(elapsedMillis: Long) = ageAtReceiptMillis +
        (elapsedMillis - receivedAtElapsedMillis).coerceAtLeast(0)
}
enum class VehicleLocationPhase { OFF, UNSUPPORTED, PERMISSION_REQUIRED, WAITING, FRESH, STALE, INVALID, TIMEOUT, ERROR, PAUSED }

data class VehicleLocationState(
    val phase: VehicleLocationPhase = VehicleLocationPhase.OFF,
    val fix: VehicleFix? = null,
    val ageSeconds: Long? = null,
    val enabled: Boolean = false
) {
    // This only establishes coordinate freshness. Route accuracy must be assessed separately.
    val freshFix get() = fix.takeIf { phase == VehicleLocationPhase.FRESH }
}

class VehicleLocationPolicy {
    fun validate(sample: VehicleLocationSample, wallMillis: Long, elapsedMillis: Long): VehicleFix? {
        if (sample.observedAtEpochMillis <= 0 || sample.observedAtEpochMillis > wallMillis + 5_000 ||
            !sample.confidence.isFinite()) return null
        val point = runCatching { GeoPoint(sample.latitude, sample.longitude) }.getOrNull() ?: return null
        return VehicleFix(point, sample.observedAtEpochMillis, sample.confidence,
            (wallMillis - sample.observedAtEpochMillis).coerceAtLeast(0), elapsedMillis)
    }
    fun isFresh(fix: VehicleFix, elapsedMillis: Long) = fix.ageMillis(elapsedMillis) < MAX_AGE_MILLIS
    companion object { const val MAX_AGE_MILLIS = 30_000L }
}

/** Implementations deliver callbacks on the main thread and stop collecting when stopped. */
interface VehicleLocationGateway {
    fun isSupported(): Boolean
    fun start(onSample: (VehicleLocationSample?) -> Unit, onError: () -> Unit)
    fun stop()
}
