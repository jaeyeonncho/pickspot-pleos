package dev.pickspot.app.domain

import kotlin.math.*

data class GeoPoint(val latitude: Double, val longitude: Double) {
    init {
        require(latitude.isFinite() && latitude in -90.0..90.0)
        require(longitude.isFinite() && longitude in -180.0..180.0)
    }
    fun distanceTo(other: GeoPoint): Double {
        val lat = Math.toRadians(other.latitude - latitude)
        val lon = Math.toRadians(other.longitude - longitude)
        val a = sin(lat / 2).pow(2) + cos(Math.toRadians(latitude)) *
            cos(Math.toRadians(other.latitude)) * sin(lon / 2).pow(2)
        return 6371000 * 2 * asin(sqrt(a.coerceIn(0.0, 1.0)))
    }
}

enum class CurbStatus(val penalty: Double) { DESIGNATED(0.0), UNKNOWN(1.0), RESTRICTED(1.0) }

enum class PickupPreference(val walkWeight: Double, val detourWeight: Double) {
    BALANCED(0.40, 0.40),
    LESS_WALK(0.70, 0.10),
    LESS_DETOUR(0.15, 0.65)
}

data class PoiReference(val id: String, val subId: String, val name: String, val address: String)

/** Travel metrics must come from walking/driving routes, never straight-line estimates. */
data class PickupCandidate(
    val id: String,
    val name: String,
    val point: GeoPoint,
    val walkMeters: Int,
    val detourSeconds: Int,
    val curbStatus: CurbStatus,
    val note: String,
    val poi: PoiReference? = null,
    val walkSeconds: Int? = null
) {
    init {
        require(walkMeters >= 0 && detourSeconds >= 0)
        require(walkSeconds == null || walkSeconds >= 0)
        require(id.isNotBlank() && name.isNotBlank())
    }
}

data class RankedPickup(val candidate: PickupCandidate, val cost: Double)

enum class SessionAvailability { WAITING, ACTIVE }
class SessionClosedException(val expired: Boolean) : Exception()
class SessionConflictException : Exception()
class SessionRateLimitException : Exception()
enum class RouteCalculationPhase { CALCULATING, READY, FAILED, STALE }
enum class RouteSource {
    FIXTURE, TMAP_EXAMPLE;
    companion object {
        fun fromWire(source: String, synthetic: Boolean, inputMode: String?): RouteSource = when {
            source == "synthetic-fixture" && synthetic && inputMode in setOf(null, "example") -> FIXTURE
            source == "tmap" && !synthetic && inputMode == "example" -> TMAP_EXAMPLE
            else -> throw IllegalArgumentException("Unknown route source")
        }
    }
}
enum class RouteCalculationIssue {
    LIMIT, CONFIGURATION, CONNECTION, UNAVAILABLE;
    companion object {
        fun fromWire(value: String?): RouteCalculationIssue? = when (value) {
            null -> null
            "limit" -> LIMIT
            "configuration" -> CONFIGURATION
            "connection" -> CONNECTION
            else -> UNAVAILABLE
        }
    }
}
data class RouteCalculation(
    val phase: RouteCalculationPhase,
    val destinationName: String,
    val completedAtEpochMillis: Long? = null,
    val validUntilEpochMillis: Long? = null,
    val retryAtEpochMillis: Long = 0,
    val attemptsRemaining: Int = 0,
    val source: RouteSource = RouteSource.FIXTURE,
    val issue: RouteCalculationIssue? = null
) {
    init {
        require(attemptsRemaining >= 0 && retryAtEpochMillis >= 0 && destinationName.isNotBlank())
        if (phase == RouteCalculationPhase.READY) {
            require(completedAtEpochMillis != null && completedAtEpochMillis > 0)
            require(validUntilEpochMillis != null && validUntilEpochMillis > completedAtEpochMillis)
        }
    }
}

data class DestinationOption(val id: String, val name: String) {
    init { require(id.isNotBlank() && name.isNotBlank()) }
}

data class PickupSession(
    val id: String,
    val passengerName: String,
    val passengerPoint: GeoPoint?,
    val candidates: List<PickupCandidate>,
    val isDemo: Boolean,
    val expiresAtEpochMillis: Long,
    val availability: SessionAvailability = SessionAvailability.ACTIVE,
    val version: Long = 0,
    val inviteCode: String? = null,
    val selectedCandidateId: String? = null,
    val selectionRequestId: String? = null,
    val routeCalculation: RouteCalculation? = null,
    val canEndRemotely: Boolean = false,
    val navigationPending: Boolean = false,
    val destinationId: String? = null,
    val destinationOptions: List<DestinationOption> = emptyList()
) {
    init {
        require(id.isNotBlank() && expiresAtEpochMillis > 0)
        require(availability != SessionAvailability.ACTIVE || passengerPoint != null)
        require(candidates.map { it.id }.distinct().size == candidates.size)
    }
    fun isExpired(nowEpochMillis: Long) = nowEpochMillis >= expiresAtEpochMillis
}

/** A server-backed repository can replace this without changing ranking or the screen. */
interface PickupRepository {
    val pollingIntervalMillis: Long? get() = null
    val sharesMeetingChoice: Boolean get() = false
    suspend fun loadSession(): PickupSession
    suspend fun shareMeetingChoice(session:PickupSession,candidate:PickupCandidate):PickupSession = session
    suspend fun selectCandidate(session: PickupSession, candidate: PickupCandidate): PickupSession = session
    suspend fun reportNavigation(session: PickupSession, confirmed: Boolean) {}
    suspend fun recalculateRoutes(session: PickupSession): PickupSession = session
    suspend fun changeDestination(session: PickupSession, destinationId: String): PickupSession = session
    suspend fun endSession(session: PickupSession) {}
    fun resetSession() {}
}

class PickupRecommender {
    fun rank(candidates: List<PickupCandidate>, preference: PickupPreference): List<RankedPickup> =
        candidates.filter { it.curbStatus != CurbStatus.RESTRICTED }
            .map { RankedPickup(it, preference.walkWeight * it.walkMeters / 600.0 +
                preference.detourWeight * it.detourSeconds / 600.0 + 0.20 * it.curbStatus.penalty) }
            .sortedWith(compareBy<RankedPickup> { it.cost }.thenBy { it.candidate.walkMeters }.thenBy { it.candidate.id })
            .take(3)
}
