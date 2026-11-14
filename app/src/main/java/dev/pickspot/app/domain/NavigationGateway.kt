package dev.pickspot.app.domain

/** UI-independent contract; only the Pleos adapter knows the vehicle SDK. */
interface NavigationGateway {
    var onState: ((NavigationState) -> Unit)?
    fun connect()
    fun request(candidate: PickupCandidate, expectedRoute: VehicleRoute)
    fun refreshRoute()
    fun setInteractionAllowed(allowed: Boolean)
    fun close()
}

enum class NavigationPhase { DISCONNECTED, CONNECTING, READING, READY, REQUESTING, ROUTING, VERIFYING, CONFIRMED, FAILED }
enum class NavigationIssue { CONNECTION, TIMEOUT, CANCELLED, TOO_CLOSE, TOO_FAR, ROUTE_SEARCH, INVALID_DESTINATION, DESTINATION_MISMATCH, SEND_FAILED,
    NO_DESTINATION, ROUTE_CHANGED, ROUTE_CONTEXT_STALE, WAYPOINT_LIMIT, WAYPOINT_UNAVAILABLE, DUPLICATE_WAYPOINT, INTERACTION_RESTRICTED }
data class NavigationState(
    val phase: NavigationPhase = NavigationPhase.DISCONNECTED,
    val connected: Boolean = false,
    val issue: NavigationIssue? = null,
    val confirmedId: String? = null,
    val route: VehicleRoute? = null,
    val waypointDispatchAvailable: Boolean = false
) {
    val busy: Boolean get() = phase in setOf(NavigationPhase.CONNECTING, NavigationPhase.READING, NavigationPhase.REQUESTING,
        NavigationPhase.ROUTING, NavigationPhase.VERIFYING)
}
