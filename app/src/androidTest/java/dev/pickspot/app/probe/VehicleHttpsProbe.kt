package dev.pickspot.app.probe

import android.app.Activity
import android.app.Instrumentation
import android.content.pm.ApplicationInfo
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import dev.pickspot.app.domain.*
import dev.pickspot.app.routing.*
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URL
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.util.UUID
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory

/** Emulator-only real TLS against the loopback fixture. No GPS, Pleos or production keys.
 * Only this instrumentation APK trusts the short-lived test certificate; hostname checking stays on.
 */
class VehicleHttpsProbe(private val instrumentation: Instrumentation) {
    fun execute() {
        val report=JSONObject();val passed=JSONArray();var stage="guard"
        var owner:String?=null;var sessionPath:String?=null
        var open:((URL)->HttpsURLConnection)?=null
        fun verify(name:String,value:Boolean){check(value){name};passed.put(name)}
        try {
            check(Build.HARDWARE in listOf("ranchu","goldfish") &&
                instrumentation.targetContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE!=0)
            stage="certificate"
            val cert=File(instrumentation.targetContext.cacheDir,"routing-probe-cert.pem")
            check(cert.isFile&&cert.length() in 1..16384)
            val trusted=cert.inputStream().use{CertificateFactory.getInstance("X.509").generateCertificate(it)}
            val keyStore=KeyStore.getInstance(KeyStore.getDefaultType()).apply{load(null);setCertificateEntry("local-fixture",trusted)}
            val managers=TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply{init(keyStore)}
            val socketFactory=SSLContext.getInstance("TLS").apply{init(null,managers.trustManagers,null)}.socketFactory
            val connection:(URL)->HttpsURLConnection={url->
                check(url.protocol=="https"&&url.host in setOf("localhost","127.0.0.1")&&url.port==18443)
                (url.openConnection() as HttpsURLConnection).apply{sslSocketFactory=socketFactory}
            };open=connection
            val origin="https://localhost:18443"
            fun request(path:String,method:String="GET",body:JSONObject?=null,token:String?=null,expected:Int=200):JSONObject =
                fixtureRequest(connection,origin,path,method,body,token,expected)
            runBlocking {
                stage="tls-rejection"
                verify("platform_rejects_untrusted_fixture",runCatching{HttpsVehiclePairingGateway(origin).create()}.isFailure)
                verify("hostname_mismatch_rejected",runCatching{HttpsVehiclePairingGateway("https://127.0.0.1:18443",connection).create()}.isFailure)
                stage="session"
                val health=request("/health")
                verify("pairing_and_disclosure_available",health.getBoolean("vehiclePairing")&&health.getBoolean("passengerRoutingConsent"))
                val made=request("/v1/sessions","POST",JSONObject(),"p".repeat(43),201)
                owner=made.getString("driverToken")
                val raw=made.getJSONObject("session");val id=raw.getString("id");val path="/v1/sessions/$id";sessionPath=path
                val passenger=request("/v1/invitations/redeem","POST",JSONObject().put("code",raw.getString("inviteCode")),expected=201).getString("passengerToken")
                val pairing=HttpsVehiclePairingGateway(origin,connection)
                stage="pairing"
                val ticket=pairing.create()
                verify("pending_before_approval",pairing.claim(ticket)==null)
                request("$path/vehicle-pairings","POST",JSONObject().put("code",ticket.code),passenger,403)
                verify("passenger_cannot_approve",pairing.claim(ticket)==null)
                request("$path/vehicle-pairings","POST",JSONObject().put("code",ticket.code),owner)
                val grant=pairing.claim(ticket)?:error("NO_GRANT")
                verify("grant_matches_session",grant.sessionId==id&&grant.candidateIds==listOf("a","b","c"))
                verify("claim_is_one_time",runCatching{pairing.claim(ticket)}.isFailure)
                val route=HttpsLiveRouteGateway(origin,id,grant.vehicleToken,System::currentTimeMillis,SystemClock::elapsedRealtime,connection)
                verify("no_ready_location_before_consent",!route.status().ready(System.currentTimeMillis()))
                request(path,"DELETE",token=grant.vehicleToken,expected=403)
                request("$path/routing-disclosure",token=grant.vehicleToken,expected=403)
                verify("vehicle_permissions_are_limited",route.status().expiresAt==grant.expiresAt)
                stage="consent-and-example-position"
                val disclosure=request("$path/routing-disclosure",token=passenger)
                verify("disclosure_matches_connection",disclosure.getString("origin")==origin&&disclosure.getString("processingRegion")==grant.processingRegion)
                val consent=request("$path/location-consent","POST",JSONObject().put("consent",true).put("expectedRevision",0)
                    .put("routingProvider","tmap").put("routingDisclosureId",disclosure.getString("id")),passenger)
                val at=System.currentTimeMillis();val elapsed=SystemClock.elapsedRealtime()
                request("$path/passenger-location","PUT",JSONObject().put("grantId",consent.getString("grantId"))
                    .put("sequence",1).put("point",JSONObject().put("latitude",37.4859).put("longitude",127.0348))
                    .put("observedAt",at).put("accuracyMeters",12),passenger)
                val status=route.status();verify("ready_after_explicit_consent_and_fix",status.ready(System.currentTimeMillis()))
                val vehicle=MeasuredVehicleFix(GeoPoint(37.4840,127.0300),at,12f,at,elapsed,0)
                val itinerary=VehicleRoute(VehiclePlace(GeoPoint(37.4900,127.0400),"검사 목적지"),emptyList(),"PLEOS_UNMAPPED",at)
                val draft=PreparedVehicleTrip(vehicle,itinerary,DrivePreference.RECOMMENDED,at+30000)
                val comparison=LiveRouteRequest(draft,status.version,status.passengerRevision,grant.candidateIds)
                stage="comparison"
                val result=route.compare(comparison)
                verify("real_transport_decodes_fixed_totals",result.candidates.map{it.detourSeconds}==listOf(120,300,45))
                verify("result_matches_revision",result.sessionVersion==status.version+1&&result.passengerRevision==status.passengerRevision)
                verify("replayed_comparison_rejected",(runCatching{route.compare(comparison)}.exceptionOrNull() as? LiveRouteException)?.issue==LiveRouteFailure.CHANGED)
                stage="withdrawal"
                request("$path/location-consent","DELETE",JSONObject().put("operationId",UUID.randomUUID().toString()),passenger)
                val withdrawn=route.status()
                verify("withdrawal_clears_readiness",!withdrawn.ready(System.currentTimeMillis())&&!withdrawn.routingAllowed&&withdrawn.locationValidUntil==null)
                stage="revocation"
                request("$path/vehicle-pairings","DELETE",token=owner)
                verify("revoked_vehicle_denied",(runCatching{route.status()}.exceptionOrNull() as? LiveRouteException)?.issue==LiveRouteFailure.ACCESS)
                val cancelled=pairing.create();pairing.cancel(cancelled)
                verify("cancelled_pairing_cannot_claim",runCatching{pairing.claim(cancelled)}.isFailure)
                stage="end"
                val last=pairing.create();request("$path/vehicle-pairings","POST",JSONObject().put("code",last.code),owner)
                val finalGrant=pairing.claim(last)?:error("NO_FINAL_GRANT")
                val finalRoute=HttpsLiveRouteGateway(origin,id,finalGrant.vehicleToken,System::currentTimeMillis,SystemClock::elapsedRealtime,connection)
                request(path,"DELETE",token=owner);sessionPath=null
                verify("ended_meeting_denied",(runCatching{finalRoute.status()}.exceptionOrNull() as? LiveRouteException)?.issue==LiveRouteFailure.ACCESS)
            }
            report.put("passed",true)
        } catch(e:Exception) {
            report.put("passed",false).put("stage",stage).put("failure",e.javaClass.simpleName)
        } finally {
            val path=sessionPath;val token=owner;val connection=open
            if(path!=null&&token!=null&&connection!=null)runCatching{fixtureRequest(connection,"https://localhost:18443",path,"DELETE",null,token,200)}
            File(instrumentation.targetContext.cacheDir,"routing-probe-cert.pem").delete()
        }
        report.put("checks",passed).put("locationReads",0).put("navigationRequests",0).put("externalProviderCalls",0)
        instrumentation.finish(Activity.RESULT_OK,Bundle().apply{putString("stream",report.toString(2)+"\n")})
    }

    private fun fixtureRequest(open:(URL)->HttpsURLConnection,origin:String,path:String,method:String,body:JSONObject?,token:String?,expected:Int):JSONObject {
        val connection=open(URL(origin+path))
        try {
            connection.requestMethod=method;connection.instanceFollowRedirects=false;connection.useCaches=false
            connection.connectTimeout=5000;connection.readTimeout=5000
            connection.setRequestProperty("Origin",origin);connection.setRequestProperty("Accept","application/json")
            if(token!=null)connection.setRequestProperty("Authorization","Bearer $token")
            if(body!=null){val bytes=body.toString().toByteArray(Charsets.UTF_8);connection.doOutput=true
                connection.setRequestProperty("Content-Type","application/json");connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use{it.write(bytes)}}
            check(connection.responseCode==expected)
            val input=if(expected>=400)connection.errorStream else connection.inputStream
            val bytes=input.use{it.readBytes()};check(bytes.size<=65536)
            return JSONObject(String(bytes,Charsets.UTF_8))
        } finally {connection.disconnect()}
    }
}
