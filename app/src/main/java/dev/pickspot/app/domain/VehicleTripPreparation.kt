package dev.pickspot.app.domain

/** Explicit comparison preference, never inferred from the Pleos route option. */
enum class DrivePreference(val wireValue: String) {
    RECOMMENDED("recommended"), FREE_FIRST("free-first"), FASTEST("fastest"), BEGINNER("beginner"),
    HIGHWAY_FIRST("highway-first"), SHORTEST("shortest"), AVOID_SCHOOL_ZONES("avoid-school-zones")
}
data class ObservedVehicleRoute(val route: VehicleRoute, val receivedWall: Long, val receivedElapsed: Long) {
    fun remainingMillis(wall: Long, elapsed: Long): Long {
        if (wall < receivedWall || elapsed < receivedElapsed || !route.isFresh(wall) || !route.isFresh(receivedWall)) return 0
        return (30_000 - (receivedWall - route.observedAtEpochMillis) - maxOf(wall-receivedWall,elapsed-receivedElapsed)).coerceAtLeast(0)
    }
}
enum class TripPreparationIssue { POSITION_REQUIRED, POSITION_STALE, ROUTE_REQUIRED, ROUTE_STALE,
    COORDINATE_UNAVAILABLE, WAYPOINT_LIMIT, INVALID_DESTINATION, PREFERENCE_REQUIRED }
/** Local memory only. No consent claim, passenger data, credentials, or transport is attached. */
data class PreparedVehicleTrip(val vehicle: MeasuredVehicleFix, val route: VehicleRoute,
    val preference: DrivePreference, val validUntil: Long)
data class VehicleTripPreparation(val draft: PreparedVehicleTrip? = null, val issue: TripPreparationIssue? = null)
object VehicleTripPreparer {
    fun prepare(fix: MeasuredVehicleFix?, observation: ObservedVehicleRoute?, preference: DrivePreference?, wall: Long, elapsed: Long): VehicleTripPreparation {
        fun missing(issue: TripPreparationIssue)=VehicleTripPreparation(issue=issue)
        if(fix==null)return missing(TripPreparationIssue.POSITION_REQUIRED)
        if(!fix.isFresh(wall,elapsed))return missing(TripPreparationIssue.POSITION_STALE)
        if(observation==null)return missing(TripPreparationIssue.ROUTE_REQUIRED)
        val route=observation.route
        val routeRemaining=observation.remainingMillis(wall,elapsed)
        if(routeRemaining<=0)return missing(TripPreparationIssue.ROUTE_STALE)
        if((fix.point.latitude==0.0&&fix.point.longitude==0.0)||!route.hasCoordinates)return missing(TripPreparationIssue.COORDINATE_UNAVAILABLE)
        if(route.waypoints.size>1)return missing(TripPreparationIssue.WAYPOINT_LIMIT)
        val name=route.destination.name
        if(name.isBlank()||name.length>100||name.any { it.code<32||it.code==127 })return missing(TripPreparationIssue.INVALID_DESTINATION)
        if(preference==null)return missing(TripPreparationIssue.PREFERENCE_REQUIRED)
        val fixRemaining=30_000-fix.ageAtReceiptMillis-maxOf(wall-fix.receivedWallMillis,elapsed-fix.receivedElapsedMillis)
        return VehicleTripPreparation(draft=PreparedVehicleTrip(fix,route.copy(waypoints=route.waypoints.toList()),preference,
            wall+minOf(fixRemaining,routeRemaining)))
    }
}

/** Main-thread, foreground-only adapters; neither interface permits network or navigation writes. */
interface MeasuredLocationReader {
    fun hasPermission(): Boolean
    fun isAvailable(): Boolean
    fun start(onSample: (MeasuredVehicleSample)->Unit, onUnavailable: ()->Unit)
    fun stop()
}
interface VehicleRouteReader {
    fun start(onState: (NavigationState)->Unit)
    fun refresh()
    fun stop()
}
