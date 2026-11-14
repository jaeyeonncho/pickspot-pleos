package dev.pickspot.app.domain

/** A single destination estimate, not pickup detour or passenger walking time. */
data class TripPreviewTarget(val sessionId: String, val candidateId: String, val name: String,
    val point: GeoPoint, val poi: PoiReference? = null)
data class TripPreviewPoint(val point: GeoPoint, val isDestination: Boolean,
    val poiId: String = "")
data class TripPreviewMetrics(val distanceMeters: Int, val durationSeconds: Int)
enum class TripPreviewIssue { CONNECTION, TIMEOUT, MISMATCH, INVALID_RESULT, SERVICE, RESTRICTED, UNAVAILABLE, BUSY }
sealed interface TripPreviewOutcome {
    data class Success(val metrics: TripPreviewMetrics) : TripPreviewOutcome
    data class Failure(val issue: TripPreviewIssue, val restartRequired: Boolean = false) : TripPreviewOutcome
}
object TripPreviewPolicy {
    const val VALID_FOR_MILLIS = 30_000L
    fun validate(target: TripPreviewTarget, distance: Int, seconds: Int, points: List<TripPreviewPoint>): TripPreviewOutcome {
        if (distance <= 0 || seconds <= 0) return TripPreviewOutcome.Failure(TripPreviewIssue.INVALID_RESULT, true)
        val destinations = points.filter { it.isDestination }
        val match = destinations.singleOrNull()?.let {
            (it.point.latitude != 0.0 || it.point.longitude != 0.0) && target.point.distanceTo(it.point) < 10.0 &&
                (target.poi == null || target.poi.id == it.poiId)
        } == true
        return if (match) TripPreviewOutcome.Success(TripPreviewMetrics(distance, seconds))
            else TripPreviewOutcome.Failure(TripPreviewIssue.MISMATCH, true)
    }
}
/** Main-thread callbacks. Only one SDK request may be in flight; failures can lock the session. */
interface TripPreviewGateway {
    fun setInteractionAllowed(allowed: Boolean)
    fun request(target: TripPreviewTarget, callback: (TripPreviewOutcome) -> Unit)
    fun close()
}
