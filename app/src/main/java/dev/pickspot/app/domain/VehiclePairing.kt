package dev.pickspot.app.domain

import java.net.URI

fun requirePairingOrigin(origin:String) {
    val u=URI(origin)
    require(u.scheme=="https"&&!u.host.isNullOrBlank()&&u.userInfo==null&&u.rawPath.isNullOrEmpty()&&u.rawQuery==null&&u.rawFragment==null)
    require(u.port==-1||u.port in 1..65535)
}
private val pairingId=Regex("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")
private val pairingSecret=Regex("[A-Za-z0-9_-]{43}")
class VehiclePairingTicket(val id:String,val code:String,val deviceToken:String,val expiresAt:Long) {
    init {require(pairingId.matches(id)&&Regex("[A-F0-9]{12}").matches(code)&&pairingSecret.matches(deviceToken)&&expiresAt>0)}
    override fun toString()="VehiclePairingTicket(redacted)"
}
class VehiclePairingGrant(val origin:String,val sessionId:String,val vehicleToken:String,val expiresAt:Long,
    val processingRegion:String,candidateIds:List<String>) {
    val candidateIds=candidateIds.toList()
    init {
        requirePairingOrigin(origin);require(pairingId.matches(sessionId)&&pairingSecret.matches(vehicleToken)&&expiresAt>0)
        require(processingRegion.isNotBlank()&&processingRegion.length<=100&&processingRegion.none{it.code<32||it.code==127})
        require(candidateIds.size in 1..3&&candidateIds.distinct().size==candidateIds.size&&candidateIds.all{Regex("[a-zA-Z0-9_-]{1,40}").matches(it)})
    }
    override fun toString()="VehiclePairingGrant(redacted)"
}
interface VehiclePairingGateway {
    suspend fun create():VehiclePairingTicket
    /** null means approval is still pending; no automatic retries after a failed claim. */
    suspend fun claim(ticket:VehiclePairingTicket):VehiclePairingGrant?
    suspend fun cancel(ticket:VehiclePairingTicket)
}
