package dev.pickspot.app.domain

/** Authenticated status only; passenger coordinates never enter the vehicle app. */
data class LiveRouteSession(val version:Long,val passengerRevision:Long,val expiresAt:Long,
    val locationValidUntil:Long?,val routingAllowed:Boolean) {
    fun ready(now:Long)=version>0&&passengerRevision>=0&&expiresAt>now&&routingAllowed&&(locationValidUntil?:0)>now
}
data class LiveRouteRequest(val trip:PreparedVehicleTrip,val expectedVersion:Long,val passengerRevision:Long,val candidateIds:List<String>) {
    init {
        require(expectedVersion>0&&passengerRevision>=0)
        require(candidateIds.size in 1..3&&candidateIds.distinct().size==candidateIds.size&&candidateIds.all{Regex("[a-zA-Z0-9_-]{1,40}").matches(it)})
    }
}
data class RouteEvidence(val name:String,val conditions:String,val sources:List<String>)
data class LiveRouteCandidate(val id:String,val walkMeters:Int,val walkSeconds:Int,val detourSeconds:Int,val evidence:RouteEvidence)
data class LiveRouteReport(val sessionVersion:Long,val passengerRevision:Long,val validUntil:Long,
    val preference:DrivePreference,val originalWaypointCount:Int,val candidates:List<LiveRouteCandidate>)
interface LiveRouteGateway {
    suspend fun status():LiveRouteSession
    suspend fun compare(request:LiveRouteRequest):LiveRouteReport
}
enum class LiveRouteFailure { CONNECTION, ACCESS, CHANGED, CONSENT, INPUT, LIMIT, UNAVAILABLE, INVALID_RESPONSE }
class LiveRouteException(val issue:LiveRouteFailure):Exception(issue.name)

fun PreparedVehicleTrip.sendableAt(wall:Long,elapsed:Long):Boolean = validUntil>wall&&vehicle.isFresh(wall,elapsed)&&
    vehicle.accuracyMeters.isFinite()&&vehicle.accuracyMeters>0&&vehicle.accuracyMeters<=100&&
    (vehicle.point.latitude!=0.0||vehicle.point.longitude!=0.0)&&route.isFresh(wall)&&route.hasCoordinates&&
    route.waypoints.size<=1&&route.destination.name.isNotBlank()&&route.destination.name.length<=100&&
    route.destination.name.none{it.code<32||it.code==127}
