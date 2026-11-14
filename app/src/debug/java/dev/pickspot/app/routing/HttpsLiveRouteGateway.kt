package dev.pickspot.app.routing

import dev.pickspot.app.domain.*
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONObject
import java.net.URI
import java.net.URL
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.HttpsURLConnection
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Explicitly injected, session-scoped connection supplied by approved vehicle pairing.
 * No bootstrap key, intent extras, preferences, custom trust manager or TLS bypass. */
class HttpsLiveRouteGateway internal constructor(private val origin:String,private val sessionId:String,private val token:String,
    private val wall:()->Long,private val elapsed:()->Long,private val openConnection:(URL)->HttpsURLConnection):LiveRouteGateway {
    constructor(origin:String,sessionId:String,token:String,wall:()->Long=System::currentTimeMillis,
        elapsed:()->Long=android.os.SystemClock::elapsedRealtime):this(origin,sessionId,token,wall,elapsed,
            {url->url.openConnection() as HttpsURLConnection})
    init {
        val u=URI(origin)
        require(u.scheme=="https"&&!u.host.isNullOrBlank()&&u.userInfo==null&&u.rawQuery==null&&u.rawFragment==null&&u.rawPath.isNullOrEmpty())
        require(u.port==-1||u.port in 1..65535)
        require(Regex("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}").matches(sessionId))
        require(Regex("[A-Za-z0-9_-]{43}").matches(token))
    }
    override suspend fun status():LiveRouteSession=decode{LiveRouteJson.session(request("GET",null),sessionId)}
    override suspend fun compare(request:LiveRouteRequest):LiveRouteReport {
        if(!request.trip.sendableAt(wall(),elapsed()))throw LiveRouteException(LiveRouteFailure.INPUT)
        return decode{LiveRouteJson.report(request("POST",request),request)}
    }
    private suspend fun <T> decode(block:suspend ()->T):T=try{block()}catch(e:kotlinx.coroutines.CancellationException){throw e}
        catch(e:LiveRouteException){throw e}catch(_:Exception){throw LiveRouteException(LiveRouteFailure.INVALID_RESPONSE)}
    private suspend fun request(method:String,trip:LiveRouteRequest?):JSONObject=suspendCancellableCoroutine{continuation->
        val current=AtomicReference<HttpsURLConnection?>()
        val future=try{workers.submit {
            if(!continuation.isActive)return@submit
            try {
                val connection=openConnection(URL(origin+"/v1/sessions/"+sessionId+if(trip!=null)"/route-comparisons" else ""))
                current.set(connection)
                if(!continuation.isActive){connection.disconnect();return@submit}
                try {
                    connection.requestMethod=method;connection.instanceFollowRedirects=false
                    connection.connectTimeout=5_000;connection.readTimeout=20_000;connection.useCaches=false
                    connection.setRequestProperty("Origin",origin);connection.setRequestProperty("Authorization","Bearer $token")
                    connection.setRequestProperty("Accept","application/json")
                    if(trip!=null){
                        if(!trip.trip.sendableAt(wall(),elapsed()))throw LiveRouteException(LiveRouteFailure.INPUT)
                        val body=LiveRouteJson.encode(trip).toByteArray(Charsets.UTF_8)
                        if(body.size>4096)throw LiveRouteException(LiveRouteFailure.INPUT)
                        connection.doOutput=true;connection.setRequestProperty("Content-Type","application/json")
                        connection.setFixedLengthStreamingMode(body.size)
                        // DNS/TLS setup may consume the remaining lifetime. Recheck before writing.
                        val output=connection.outputStream
                        output.use{
                            if(!continuation.isActive||!trip.trip.sendableAt(wall(),elapsed()))throw LiveRouteException(LiveRouteFailure.INPUT)
                            it.write(body)
                        }
                    }
                    val code=connection.responseCode
                    if(code!=200)throw LiveRouteException(when(code){
                        401,403->LiveRouteFailure.ACCESS;409->LiveRouteFailure.CHANGED;410->if(trip==null)LiveRouteFailure.ACCESS else LiveRouteFailure.CHANGED;429->LiveRouteFailure.LIMIT
                        400,413->LiveRouteFailure.INPUT;404,503->LiveRouteFailure.UNAVAILABLE;else->LiveRouteFailure.CONNECTION
                    })
                    if(connection.contentType?.substringBefore(';')?.trim()!="application/json")throw LiveRouteException(LiveRouteFailure.INVALID_RESPONSE)
                    val bytes=connection.inputStream.use{input->
                        val out=java.io.ByteArrayOutputStream();val buffer=ByteArray(2048)
                        while(true){val n=input.read(buffer,0,minOf(buffer.size,65_537-out.size()));if(n<0)break;out.write(buffer,0,n);if(out.size()>65_536)throw LiveRouteException(LiveRouteFailure.INVALID_RESPONSE)}
                        out.toByteArray()
                    }
                    if(continuation.isActive)continuation.resume(JSONObject(String(bytes,Charsets.UTF_8)))
                }finally{connection.disconnect();current.set(null)}
            }catch(e:Exception){if(continuation.isActive)continuation.resumeWithException(e as? LiveRouteException?:LiveRouteException(LiveRouteFailure.CONNECTION))}
        }}catch(_:Exception){continuation.resumeWithException(LiveRouteException(LiveRouteFailure.UNAVAILABLE));null}
        continuation.invokeOnCancellation{current.getAndSet(null)?.disconnect();future?.cancel(true)}
    }
    override fun toString()="HttpsLiveRouteGateway(redacted)"
    companion object {
        private val workers=ThreadPoolExecutor(2,2,30,TimeUnit.SECONDS,ArrayBlockingQueue<Runnable>(16),
            {r->Thread(r,"pickspot-route").apply{isDaemon=true}},ThreadPoolExecutor.AbortPolicy())
    }
}
