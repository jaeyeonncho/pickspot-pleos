package dev.pickspot.app.routing

import dev.pickspot.app.domain.*
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONObject
import java.net.URL
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.HttpsURLConnection
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Fixed trusted endpoint; no user-entered URLs, bootstrap keys or alternate TLS trust. */
class HttpsVehiclePairingGateway internal constructor(private val origin:String,private val open:(URL)->HttpsURLConnection):VehiclePairingGateway {
    constructor(origin:String):this(origin,{it.openConnection() as HttpsURLConnection})
    init {requirePairingOrigin(origin)}
    override suspend fun create():VehiclePairingTicket {
        val (_,json)=request("POST","/v1/vehicle-pairings",null,201)
        require(json.integer("pollAfterMs")==3000L)
        return VehiclePairingTicket(json.string("id"),json.string("code"),json.string("deviceToken"),json.integer("expiresAt"))
    }
    override suspend fun claim(ticket:VehiclePairingTicket):VehiclePairingGrant? {
        val (status,json)=request("POST","/v1/vehicle-pairings/${ticket.id}/claim",ticket.deviceToken,200,202)
        if(status==202){require(json.string("status")=="pending"&&json.integer("expiresAt")<=ticket.expiresAt&&json.integer("pollAfterMs")==3000L);return null}
        return decodeGrant(json,origin)
    }
    override suspend fun cancel(ticket:VehiclePairingTicket){
        val (_,json)=request("DELETE","/v1/vehicle-pairings/${ticket.id}",ticket.deviceToken,200)
        require(json.string("status")=="cancelled")
    }
    private suspend fun request(method:String,path:String,secret:String?,vararg statuses:Int):Pair<Int,JSONObject> = suspendCancellableCoroutine{continuation->
        val current=AtomicReference<HttpsURLConnection?>()
        val future=try{workers.submit {
            if(!continuation.isActive)return@submit
            try {
                val connection=open(URL(origin+path));current.set(connection)
                try {
                    if(!continuation.isActive)return@submit
                    connection.requestMethod=method;connection.instanceFollowRedirects=false;connection.useCaches=false
                    connection.connectTimeout=5_000;connection.readTimeout=5_000
                    connection.setRequestProperty("Origin",origin);connection.setRequestProperty("Accept","application/json")
                    if(secret!=null)connection.setRequestProperty("Authorization","Bearer $secret")
                    if(method=="POST"){
                        connection.doOutput=true;connection.setRequestProperty("Content-Type","application/json");connection.setFixedLengthStreamingMode(2)
                        connection.outputStream.use{if(!continuation.isActive)return@submit;it.write(byteArrayOf(123,125))}
                    }
                    val code=connection.responseCode
                    require(code in statuses&&connection.contentType?.substringBefore(';')?.trim()=="application/json")
                    val bytes=connection.inputStream.use{input->
                        val out=java.io.ByteArrayOutputStream();val buffer=ByteArray(2048)
                        while(true){val n=input.read(buffer,0,minOf(buffer.size,16385-out.size()));if(n<0)break;out.write(buffer,0,n);require(out.size()<=16384)}
                        out.toByteArray()
                    }
                    val value=JSONObject(String(bytes,Charsets.UTF_8))
                    if(continuation.isActive)continuation.resume(code to value)
                }finally{connection.disconnect();current.set(null)}
            }catch(_:Exception){if(continuation.isActive)continuation.resumeWithException(IllegalStateException("PAIRING_REQUEST_FAILED"))}
        }}catch(_:Exception){continuation.resumeWithException(IllegalStateException("PAIRING_UNAVAILABLE"));null}
        continuation.invokeOnCancellation{current.getAndSet(null)?.disconnect();future?.cancel(true)}
    }
    override fun toString()="HttpsVehiclePairingGateway(redacted)"
    companion object {
        private val workers=ThreadPoolExecutor(2,2,30,TimeUnit.SECONDS,ArrayBlockingQueue<Runnable>(16),{r->Thread(r,"pickspot-pairing").apply{isDaemon=true}},ThreadPoolExecutor.AbortPolicy())
        private fun JSONObject.string(key:String)=get(key).also{require(it is String)} as String
        private fun JSONObject.integer(key:String):Long {val v=get(key);require(v is Long||v is Int);return (v as Number).toLong().also{require(it>0&&it<=9_007_199_254_740_991L)}}
        fun decodeGrant(json:JSONObject,expectedOrigin:String):VehiclePairingGrant {
            require(json.string("status")=="connected"&&json.string("origin")==expectedOrigin)
            val caps=json.getJSONArray("capabilities")
            require(caps.length()==2&&(0 until caps.length()).map{caps.get(it)}.toSet()==setOf("read-session","compare-routes"))
            val session=json.getJSONObject("session");val id=session.string("id")
            require(session.string("status") in setOf("waiting","joined","active"))
            val parsed=LiveRouteJson.session(session,id)
            val ids=json.getJSONArray("candidateIds");require(ids.length() in 1..3)
            val candidates=(0 until ids.length()).map{ids.get(it).also{v->require(v is String)} as String}
            return VehiclePairingGrant(expectedOrigin,id,json.string("vehicleToken"),parsed.expiresAt,json.string("processingRegion"),candidates)
        }
    }
}
