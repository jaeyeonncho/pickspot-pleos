package dev.pickspot.app.routing

import dev.pickspot.app.domain.*
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI

/** Strict wire mapping. No raw response or personal coordinates are retained in reports. */
object LiveRouteJson {
    private fun integer(json:JSONObject,key:String,min:Long=0):Long {
        val v=json.get(key);require(v is Int||v is Long)
        return (v as Number).toLong().also{require(it>=min&&it<=9_007_199_254_740_991L)}
    }
    private fun metric(json:JSONObject,key:String)=integer(json,key).also{require(it<=Int.MAX_VALUE)}.toInt()
    private fun text(json:JSONObject,key:String,max:Int)=json.get(key).also{require(it is String&&it.isNotBlank()&&it.length<=max&&it.none{c->c.code<32||c.code==127})} as String
    private fun point(p:GeoPoint)=JSONObject().put("latitude",p.latitude).put("longitude",p.longitude)
    fun encode(request:LiveRouteRequest):String {
        val t=request.trip;val fix=t.vehicle
        return JSONObject().put("expectedVersion",request.expectedVersion)
            .put("driver",JSONObject().put("point",point(fix.point)).put("observedAt",fix.observedAtMillis)
                .put("accuracyMeters",fix.accuracyMeters).put("source","vehicle").put("consent",true).put("routingProvider","tmap"))
            .put("destination",JSONObject().put("point",point(t.route.destination.point)).put("name",t.route.destination.name))
            .put("waypoints",JSONArray().also{array->t.route.waypoints.forEach{array.put(point(it.point))}})
            .put("routeObservedAt",t.route.observedAtEpochMillis).put("drivePreference",t.preference.wireValue)
            .put("candidateIds",JSONArray(request.candidateIds)).toString()
    }
    fun session(json:JSONObject,id:String):LiveRouteSession {
        require(json.get("id")==id&&json.get("isDemo")==false)
        val share=json.getJSONObject("locationShare")
        val valid=if(share.isNull("validUntil"))null else integer(share,"validUntil",1)
        return LiveRouteSession(integer(json,"version",1),integer(share,"revision"),integer(json,"expiresAt",1),valid,
            share.get("status")=="ready"&&share.opt("routingProvider")=="tmap")
    }
    fun report(json:JSONObject,request:LiveRouteRequest):LiveRouteReport {
        require(json.get("source")=="tmap"&&json.get("synthetic")==false&&json.get("inputMode")=="live"&&
            json.get("referenceOnly")==true&&json.get("vehicleRouteOptionMatched")==false&&
            json.get("method")=="provider_route_via_pickup_minus_provider_baseline"&&json.get("pickupOrder")=="before_original_waypoints")
        require(json.get("drivePreference")==request.trip.preference.wireValue)
        val version=integer(json,"sessionVersion",1);val revision=integer(json,"passengerRevision")
        require(version==request.expectedVersion+1&&revision==request.passengerRevision)
        val count=metric(json,"originalWaypointCount");require(count==request.trip.route.waypoints.size)
        val until=integer(json,"inputValidUntil",1);require(until<=request.trip.validUntil)
        val provenance=json.getJSONArray("candidateProvenance");require(provenance.length()==request.candidateIds.size)
        val evidence=mutableMapOf<String,RouteEvidence>()
        for(i in 0 until provenance.length()){
            val row=provenance.getJSONObject(i);val id=text(row,"id",40)
            require(id in request.candidateIds&&!evidence.containsKey(id))
            val review=row.getJSONObject("review")
            require(review.get("status")=="reviewed"&&review.get("generalVehiclePickup")=="confirmed"&&
                review.get("meetingConnection")=="connected"&&review.get("dataUse")=="permitted")
            val sources=row.getJSONArray("sources");require(sources.length() in 1..16)
            val urls=(0 until sources.length()).map{n->text(sources.getJSONObject(n),"url",2048).also{
                val u=URI(it);require(u.scheme=="https"&&!u.host.isNullOrBlank()&&u.userInfo==null)
            }}
            evidence[id]=RouteEvidence(text(row,"name",100),text(review,"conditions",500),urls)
        }
        val candidates=json.getJSONArray("candidates");require(candidates.length()<=request.candidateIds.size)
        val seen=mutableSetOf<String>()
        val rows=(0 until candidates.length()).map{i->
            val row=candidates.getJSONObject(i);val id=text(row,"id",40)
            require(id in request.candidateIds&&seen.add(id)&&row.get("curbStatus")=="unknown")
            LiveRouteCandidate(id,metric(row,"walkMeters"),metric(row,"walkSeconds"),metric(row,"detourSeconds"),evidence.getValue(id))
        }
        val excluded=json.getJSONArray("excluded")
        for(i in 0 until excluded.length()){
            val id=text(excluded.getJSONObject(i),"id",40);require(id in request.candidateIds&&seen.add(id))
        }
        require(seen==request.candidateIds.toSet())
        return LiveRouteReport(version,revision,until,request.trip.preference,count,rows)
    }
}
