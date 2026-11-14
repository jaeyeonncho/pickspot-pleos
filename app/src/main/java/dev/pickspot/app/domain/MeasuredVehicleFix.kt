package dev.pickspot.app.domain

/** Android GPS measurement kept separate from Pleos confidence. No inferred accuracy. */
data class MeasuredVehicleSample(
    val latitude: Double, val longitude: Double, val observedAtMillis: Long,
    val measuredElapsedMillis: Long, val accuracyMeters: Float?
)
data class MeasuredVehicleFix(
    val point: GeoPoint, val observedAtMillis: Long, val accuracyMeters: Float,
    val receivedWallMillis: Long, val receivedElapsedMillis: Long, val ageAtReceiptMillis: Long
) {
    fun isFresh(wallMillis: Long, elapsedMillis: Long): Boolean =
        wallMillis >= receivedWallMillis && elapsedMillis >= receivedElapsedMillis &&
            maxOf(wallMillis - receivedWallMillis, elapsedMillis - receivedElapsedMillis) + ageAtReceiptMillis < 30_000
}
class MeasuredVehiclePolicy {
    fun validate(sample: MeasuredVehicleSample, wallMillis: Long, elapsedMillis: Long): MeasuredVehicleFix? {
        if (wallMillis <= 0 || elapsedMillis < 0 || sample.observedAtMillis <= 0 ||
            sample.observedAtMillis > wallMillis + 5_000 || sample.measuredElapsedMillis < 0 ||
            sample.measuredElapsedMillis > elapsedMillis) return null
        val accuracy = sample.accuracyMeters ?: return null
        if (!accuracy.isFinite() || accuracy <= 0 || accuracy > 100) return null
        val point = runCatching { GeoPoint(sample.latitude, sample.longitude) }.getOrNull() ?: return null
        val age = maxOf((wallMillis - sample.observedAtMillis).coerceAtLeast(0), elapsedMillis - sample.measuredElapsedMillis)
        if (age >= 30_000) return null
        return MeasuredVehicleFix(point, sample.observedAtMillis, accuracy, wallMillis, elapsedMillis, age)
    }
}
