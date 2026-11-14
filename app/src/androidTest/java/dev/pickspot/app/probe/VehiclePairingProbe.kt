package dev.pickspot.app.probe

import android.app.Activity
import android.app.Instrumentation
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.os.Bundle
import android.view.ContextThemeWrapper
import android.view.LayoutInflater
import android.view.View
import android.widget.Button
import android.widget.TextView
import dev.pickspot.app.R
import dev.pickspot.app.domain.*
import dev.pickspot.app.presentation.*
import dev.pickspot.app.routing.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.URL
import java.security.cert.Certificate
import javax.net.ssl.HttpsURLConnection
import kotlinx.coroutines.*
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Fixed examples, offscreen rendering and fake HTTPS only. No location/navigation calls. */
class VehiclePairingProbe(private val instrumentation:Instrumentation){
    private class Connection(url:URL,val body:String,val code:Int):HttpsURLConnection(url){
        val sent=ByteArrayOutputStream();var closed=false
        var block=false;val entered=CountDownLatch(1);val release=CountDownLatch(1)
        override fun getOutputStream()=sent
        override fun getInputStream():java.io.InputStream {
            if(block){entered.countDown();check(release.await(2,TimeUnit.SECONDS))}
            return ByteArrayInputStream(body.toByteArray())
        }
        override fun getResponseCode()=code
        override fun getContentType()="application/json; charset=utf-8"
        override fun connect()=Unit
        override fun disconnect(){closed=true;release.countDown()}
        override fun usingProxy()=false
        override fun getCipherSuite()="TEST_ONLY"
        override fun getLocalCertificates():Array<Certificate>?=null
        override fun getServerCertificates():Array<Certificate> = emptyArray()
    }
    fun execute(){
        val report=JSONObject();val files=JSONArray();var checks=0
        fun verify(value:Boolean){check(value);checks++}
        try {
            check(Build.HARDWARE in listOf("ranchu","goldfish")&&instrumentation.targetContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE!=0)
            val source=instrumentation.context.assets.open("vehicle-pairing-contract.json").bufferedReader().use{it.readText()}
            val fixture=JSONObject(source)
            verify(HttpsVehiclePairingGateway.decodeGrant(fixture,"https://example.test").candidateIds==listOf("reviewed-example"))
            fun reject(change:(JSONObject)->Unit){val copy=JSONObject(source);change(copy);verify(runCatching{HttpsVehiclePairingGateway.decodeGrant(copy,"https://example.test")}.isFailure)}
            reject{it.put("origin","https://untrusted.test")}
            reject{it.put("capabilities",JSONArray(listOf("read-session","create-session")))}
            reject{it.put("candidateIds",JSONArray(listOf("a","a")))}
            reject{it.put("processingRegion","bad\nregion")}
            reject{it.put("vehicleToken","bad")}
            reject{it.getJSONObject("session").put("isDemo",true)}
            reject{it.getJSONObject("session").put("expiresAt","1800000900000")}
            reject{it.getJSONObject("session").put("status","ended")}
            runBlocking {
                var response=JSONObject().put("id","00000000-0000-0000-0000-000000000002").put("code","ABCDEF123456")
                    .put("deviceToken","d".repeat(43)).put("expiresAt",1800000120000L).put("pollAfterMs",3000).toString()
                var status=201;var active:Connection?=null;var blocking=false
                val opened=java.util.concurrent.LinkedBlockingQueue<Connection>()
                val gateway=HttpsVehiclePairingGateway("https://example.test"){url->Connection(url,response,status).also{it.block=blocking;active=it;opened.offer(it)}}
                val ticket=gateway.create()
                verify(ticket.code=="ABCDEF123456"&&active!!.sent.toString("UTF-8")=="{}")
                verify(active!!.getRequestProperty("Authorization")==null&&active!!.getRequestProperty("Origin")=="https://example.test"&&active!!.closed&&!active!!.instanceFollowRedirects)
                status=202;response=JSONObject().put("status","pending").put("expiresAt",ticket.expiresAt).put("pollAfterMs",3000).toString()
                verify(gateway.claim(ticket)==null)
                verify(active!!.getRequestProperty("Authorization")=="Bearer ${ticket.deviceToken}"&&!active!!.url.toString().contains(ticket.deviceToken))
                status=200;response=source;verify(gateway.claim(ticket)?.vehicleToken=="v".repeat(43))
                response="{\"status\":\"cancelled\"}";gateway.cancel(ticket);verify(active!!.requestMethod=="DELETE"&&active!!.sent.size()==0)
                status=302;verify(runCatching{gateway.create()}.isFailure)
                status=201;response="x".repeat(16385);verify(runCatching{gateway.create()}.isFailure&&active!!.closed)
                opened.clear();blocking=true;response=source;status=200
                val pending=async(Dispatchers.Default){gateway.claim(ticket)}
                val connection=withContext(Dispatchers.IO){opened.poll(2,TimeUnit.SECONDS)?:error("NO_CONNECTION")}
                withContext(Dispatchers.IO){check(connection.entered.await(2,TimeUnit.SECONDS))}
                pending.cancelAndJoin();verify(connection.closed)
            }
            instrumentation.runOnMainSync {
                val context=ContextThemeWrapper(instrumentation.targetContext,R.style.Theme_Pickspot)
                for(width in listOf(520,960)){
                    val root=LayoutInflater.from(context).inflate(R.layout.panel_vehicle_pairing,null)
                    val panel=VehiclePairingPanel(context,root,{},{});
                    for(phase in VehiclePairingPhase.entries){
                        val state=VehiclePairingState(phase,if(phase==VehiclePairingPhase.WAITING)"ABCDEF123456" else null,112)
                        panel.render(state,true)
                        verify(root.findViewById<Button>(R.id.pairing_start).isEnabled==(phase in setOf(VehiclePairingPhase.IDLE,VehiclePairingPhase.EXPIRED,VehiclePairingPhase.FAILED)))
                        verify(root.findViewById<TextView>(R.id.pairing_code).text.toString()==if(phase==VehiclePairingPhase.WAITING)"ABCD EF12 3456" else "")
                        root.setBackgroundColor(context.getColor(R.color.background))
                        root.measure(View.MeasureSpec.makeMeasureSpec(width,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(0,View.MeasureSpec.UNSPECIFIED))
                        root.layout(0,0,root.measuredWidth,root.measuredHeight)
                        val image=Bitmap.createBitmap(root.measuredWidth,root.measuredHeight,Bitmap.Config.ARGB_8888);root.draw(Canvas(image))
                        val file=File(context.cacheDir,"vehicle-pairing-${phase.name.lowercase()}-$width.png")
                        file.outputStream().use{image.compress(Bitmap.CompressFormat.PNG,100,it)};image.recycle();files.put(file.name)
                    }
                    panel.render(VehiclePairingState(VehiclePairingPhase.WAITING,"ABCDEF123456",100),false)
                    verify(root.visibility==View.GONE&&root.findViewById<TextView>(R.id.pairing_code).text.isEmpty())
                }
            }
            report.put("passed",true)
        }catch(e:Exception){report.put("passed",false).put("failure",e.javaClass.simpleName)}
        report.put("checks",checks).put("files",files).put("networkRequests",0).put("locationReads",0).put("navigationRequests",0)
        instrumentation.finish(Activity.RESULT_OK,Bundle().apply{putString("stream",report.toString(2)+"\n")})
    }
}
