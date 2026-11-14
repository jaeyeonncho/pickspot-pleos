package dev.pickspot.app.probe

import dev.pickspot.app.domain.*
import dev.pickspot.app.routing.*
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.URL
import java.security.cert.Certificate
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.net.ssl.HttpsURLConnection
import kotlinx.coroutines.*
import org.json.JSONObject

/** Injected in-memory connections. Production constructor uses platform TLS unchanged. */
object LiveRouteTransportChecks {
    private class Connection(url:URL,var body:String,var code:Int=200):HttpsURLConnection(url){
        val sent=ByteArrayOutputStream();var closed=false;var onOutput:()->Unit={}
        val entered=CountDownLatch(1);val released=CountDownLatch(1);var waitForCancel=false
        override fun getOutputStream():java.io.OutputStream{onOutput();return sent}
        override fun getInputStream():java.io.InputStream {
            if(waitForCancel){entered.countDown();released.await(2,TimeUnit.SECONDS)}
            return ByteArrayInputStream(body.toByteArray())
        }
        override fun getResponseCode()=code
        override fun getContentType()="application/json; charset=utf-8"
        override fun connect()=Unit
        override fun disconnect(){closed=true;released.countDown()}
        override fun usingProxy()=false
        override fun getCipherSuite()="TEST_ONLY"
        override fun getLocalCertificates():Array<Certificate>?=null
        override fun getServerCertificates():Array<Certificate> = emptyArray()
    }
    fun run(fixture:JSONObject,request:LiveRouteRequest):Int=runBlocking {
        var checks=0;var at=fixture.getLong("at");val id=fixture.getJSONObject("session").getString("id")
        val token="a".repeat(43);var active:Connection?=null
        var nextBody=fixture.getJSONObject("session").toString();var nextCode=200;var configure:(Connection)->Unit={}
        val gateway=HttpsLiveRouteGateway("https://example.test",id,token,{at},{100_000}) {url->
            Connection(url,nextBody,nextCode).also{active=it;configure(it)}
        }
        fun verify(v:Boolean){check(v);checks++}
        verify(gateway.status().version==request.expectedVersion)
        verify(active!!.requestMethod=="GET"&&active!!.getRequestProperty("Authorization")=="Bearer $token"&&
            active!!.getRequestProperty("Origin")=="https://example.test"&&!active!!.instanceFollowRedirects&&active!!.closed)
        nextBody=fixture.getJSONObject("report").toString()
        verify(gateway.compare(request).candidates.size==3)
        verify(active!!.url.path.endsWith("/route-comparisons")&&JSONObject(active!!.sent.toString("UTF-8")).getLong("expectedVersion")==request.expectedVersion)
        nextCode=410
        try{gateway.status();error("closed session accepted")}catch(e:LiveRouteException){verify(e.issue==LiveRouteFailure.ACCESS)}
        try{gateway.compare(request);error("closed comparison accepted")}catch(e:LiveRouteException){verify(e.issue==LiveRouteFailure.CHANGED)}
        nextCode=302
        try{gateway.status();error("redirect accepted")}catch(e:LiveRouteException){verify(e.issue==LiveRouteFailure.CONNECTION)}
        nextCode=200;nextBody="x".repeat(65_537)
        try{gateway.status();error("oversize accepted")}catch(e:LiveRouteException){verify(e.issue==LiveRouteFailure.INVALID_RESPONSE)}
        nextBody=fixture.getJSONObject("report").toString();configure={it.onOutput={at+=30_000}}
        try{gateway.compare(request);error("expired send accepted")}catch(e:LiveRouteException){verify(e.issue==LiveRouteFailure.INPUT&&active!!.sent.size()==0)}
        at=fixture.getLong("at");nextBody=fixture.getJSONObject("session").toString();configure={it.waitForCancel=true}
        val pending=async(Dispatchers.Default){gateway.status()}
        withContext(Dispatchers.IO){
            val until=System.nanoTime()+TimeUnit.SECONDS.toNanos(2)
            while(active?.waitForCancel!=true&&System.nanoTime()<until)Thread.yield()
            check(active?.waitForCancel==true&&active!!.entered.await(2,TimeUnit.SECONDS))
        }
        pending.cancelAndJoin();verify(active!!.closed)
        checks
    }
}
