package dev.pickspot.app.routing

import dev.pickspot.app.domain.LiveRouteGateway
import java.net.URI

/** Displayed in the consent UI; supplied by trusted configuration, never an invite URL. */
data class LiveRouteDisclosure(val origin:String,val processingRegion:String){
    init {
        val uri=URI(origin)
        require(uri.scheme=="https"&&!uri.host.isNullOrBlank()&&uri.userInfo==null&&uri.rawPath.isNullOrEmpty()&&uri.rawQuery==null&&uri.rawFragment==null)
        require(processingRegion.isNotBlank()&&processingRegion.length<=100&&processingRegion.none{it.code<32||it.code==127})
    }
}
class LiveRouteConnection private constructor(val gateway:LiveRouteGateway,val disclosure:LiveRouteDisclosure,val candidateIds:List<String>){
    companion object {
        fun configured(origin:String,processingRegion:String,sessionId:String,vehicleToken:String,candidateIds:List<String>):LiveRouteConnection {
            require(candidateIds.size in 1..3&&candidateIds.distinct().size==candidateIds.size&&candidateIds.all{Regex("[a-zA-Z0-9_-]{1,40}").matches(it)})
            return LiveRouteConnection(HttpsLiveRouteGateway(origin,sessionId,vehicleToken),LiveRouteDisclosure(origin,processingRegion),candidateIds.toList())
        }
    }
}
object VehiclePairingConfiguration {
    // Set only after a reviewed direct-TLS routing deployment is configured.
    // Never derive this from an invitation, Intent, QR payload or editable URL field.
    fun origin():String?=null
}
