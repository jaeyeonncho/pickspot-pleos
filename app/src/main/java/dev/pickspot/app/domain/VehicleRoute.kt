package dev.pickspot.app.domain

data class VehiclePlace(val point: GeoPoint, val name: String, val address: String = "",
    val poiId: String = "", val poiSubId: String = "", val poiProvider: String = "") {
    // The current vehicle provider uses (0,0) for missing waypoint coordinates.
    // Treat that sentinel as unavailable, never as a usable navigation stop.
    val hasCoordinate get() = point.latitude != 0.0 || point.longitude != 0.0
}

/** Local, in-memory vehicle context. Never persisted or sent to the sharing server. */
data class VehicleRoute(val destination: VehiclePlace, val waypoints: List<VehiclePlace>,
    val routeOption: String, val observedAtEpochMillis: Long) {
    val hasCoordinates get() = destination.hasCoordinate && waypoints.all { it.hasCoordinate }
    fun isFresh(now: Long) = observedAtEpochMillis > 0 && now >= observedAtEpochMillis && now - observedAtEpochMillis < 30_000
    fun sameItinerary(other: VehicleRoute) = destination == other.destination &&
        waypoints == other.waypoints && routeOption == other.routeOption
}
data class WaypointPlan(val original: VehicleRoute, val pickup: VehiclePlace) {
    val waypoints get() = listOf(pickup) + original.waypoints
    fun matches(actual: VehicleRoute): Boolean = actual.hasCoordinates && original.hasCoordinates && pickup.hasCoordinate && original.routeOption == actual.routeOption &&
        samePlace(original.destination, actual.destination) && waypoints.size == actual.waypoints.size &&
        waypoints.zip(actual.waypoints).all { (expected, received) -> samePlace(expected, received) }
    private fun samePlace(a: VehiclePlace, b: VehiclePlace) = a.point.distanceTo(b.point) <= 10.0 &&
        (a.poiId.isEmpty() || a.poiId == b.poiId) &&
        (a.poiSubId.isEmpty() || a.poiSubId == b.poiSubId) &&
        (a.poiProvider.isEmpty() || a.poiProvider == b.poiProvider)
}
class WaypointPlanningException(val issue: NavigationIssue) : IllegalStateException(issue.name)
object WaypointPlanner {
    fun plan(expected: VehicleRoute, current: VehicleRoute, candidate: PickupCandidate, now: Long): WaypointPlan {
        fun reject(issue: NavigationIssue): Nothing = throw WaypointPlanningException(issue)
        if (!expected.isFresh(now) || !current.isFresh(now)) reject(NavigationIssue.ROUTE_CONTEXT_STALE)
        if (!current.hasCoordinates || !expected.hasCoordinates || (candidate.point.latitude == 0.0 && candidate.point.longitude == 0.0)) reject(NavigationIssue.INVALID_DESTINATION)
        if (!expected.sameItinerary(current)) reject(NavigationIssue.ROUTE_CHANGED)
        if (candidate.curbStatus == CurbStatus.RESTRICTED) reject(NavigationIssue.INVALID_DESTINATION)
        if (current.waypoints.size >= 2) reject(NavigationIssue.WAYPOINT_LIMIT)
        if ((current.waypoints + current.destination).any { it.point.distanceTo(candidate.point) <= 35.0 })
            reject(NavigationIssue.DUPLICATE_WAYPOINT)
        val pickup = VehiclePlace(candidate.point, candidate.poi?.name ?: "픽스팟 ${candidate.name}",
            candidate.poi?.address.orEmpty(), candidate.poi?.id.orEmpty(), candidate.poi?.subId.orEmpty())
        return WaypointPlan(current, pickup)
    }
}

data class VehicleTripInput(val vehicle: VehicleFix, val route: VehicleRoute)
