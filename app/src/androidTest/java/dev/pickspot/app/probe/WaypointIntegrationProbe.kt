package dev.pickspot.app.probe

import android.app.Activity
import android.app.Instrumentation
import android.content.pm.ApplicationInfo
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import ai.pleos.playground.navi.constants.*
import ai.pleos.playground.navi.data.*
import ai.pleos.playground.navi.helper.NaviHelper
import ai.pleos.playground.navi.helper.listener.NaviHelperEventListener
import dev.pickspot.app.domain.*
import dev.pickspot.app.navigation.PleosNavigator
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/** Exercises the production adapter, using only explicitly selected emulator fixtures. */
class WaypointIntegrationProbe(private val instrumentation: Instrumentation) {
    private data class Event(val kind:String,val value:Any?=null)
    private val events=LinkedBlockingQueue<Event>()
    private val states=LinkedBlockingQueue<NavigationState>()
    private lateinit var raw:NaviHelper
    private var navigator:PleosNavigator?=null
    private var created=false
    private val report=JSONObject().put("fixedExamples",true).put("tmapCalls",0).put("createdExampleBaseline",false)
    private val listener=object:NaviHelperEventListener {
        override fun onRouteStateInfo(routeStateInfo:RouteStateInfo){events.offer(Event("state",routeStateInfo))}
        override fun onRoutingCompleted(){events.offer(Event("routed"))}
        @Suppress("OVERRIDE_DEPRECATION") override fun onRouteEnded(){events.offer(Event("routed"))}
        override fun onError(errorCode:NaviErrorCode){events.offer(Event("error",errorCode.name))}
        override fun onWayPointInfo(waypointInfoList:List<WaypointInfo>){events.offer(Event("waypoints",waypointInfoList))}
        override fun onDestinationInfo(destinationInfo:DestinationInfo){events.offer(Event("destination",destinationInfo))}
    }
    private fun main(action:()->Unit)=instrumentation.runOnMainSync(action)
    private fun stage(name:String)=instrumentation.sendStatus(0,Bundle().apply{putString("stream","stage=$name\n")})
    private fun await(kind:String,seconds:Long=30):Event {
        val end=SystemClock.elapsedRealtime()+seconds*1000
        while(SystemClock.elapsedRealtime()<end){val e=events.poll((end-SystemClock.elapsedRealtime()).coerceAtLeast(1),TimeUnit.MILLISECONDS)?:break
            if(e.kind==kind||e.kind=="error")return e}
        error("${kind.uppercase()}_TIMEOUT")
    }
    private fun state():RouteStateInfo {events.clear();main{raw.getRouteStateInfo()};return await("state").value as RouteStateInfo}
    private fun guiding(s:RouteStateInfo)=s.naviMode in listOf(NaviMode.ROUTE_GUIDING,NaviMode.SIMULATION_GUIDING)
    private fun navState(vararg phases:NavigationPhase):NavigationState {
        val end=SystemClock.elapsedRealtime()+60_000
        while(SystemClock.elapsedRealtime()<end){val s=states.poll((end-SystemClock.elapsedRealtime()).coerceAtLeast(1),TimeUnit.MILLISECONDS)?:break
            if(s.phase in phases)return s}
        error("NAVIGATION_TIMEOUT")
    }
    private fun setup(count:Int) {
        events.clear()
        val destination=RouteInfo(latitude=37.48544722,longitude=127.03636666,poiName="42dot",poiId="36khp37hh8gqcm5nqhe5",poiSubId="0",address="서울시 강남구 남부순환로 2621")
        val points=listOf(RequestWaypointInfo(37.47,127.05,"기존 예제 경유지",WaypointIndex.FIRST,"","",""),
            RequestWaypointInfo(37.48,127.04,"두 번째 예제 경유지",WaypointIndex.SECOND,"","",""))
        created=true;report.put("createdExampleBaseline",true)
        main{if(count==0)raw.requestRoute(destination) else raw.requestRouteWithWaypoints(RouteWithWaypointsRequest(destination,points.take(count)))}
        check(await("routed",45).kind=="routed"){"BASELINE_FAILED"}
        var current=state();for(i in 1..10){if(guiding(current))break;SystemClock.sleep(500);current=state()}
        check(guiding(current)){"BASELINE_NOT_GUIDING"}
    }
    private fun queryDestination(): VehiclePlace {
        events.clear(); main{raw.getDestinationInfo()}
        val d=await("destination").value as DestinationInfo
        return VehiclePlace(GeoPoint(d.latitude,d.longitude),d.name,d.address,d.poiId,d.poiSubId.orEmpty(),d.poiProvider)
    }
    private fun queryWaypoints(): List<VehiclePlace> {
        events.clear(); main{raw.getWaypointInfo()}
        return (await("waypoints").value as List<*>).filterIsInstance<WaypointInfo>().map{
            VehiclePlace(GeoPoint(it.latitude,it.longitude),it.name,it.address,it.poiId,it.poiSubId.orEmpty(),it.poiProvider)
        }
    }
    private fun cleanup(): Boolean {
        fun cancelAndConfirm():Boolean {
            main { raw.cancelRoute() }
            val end=SystemClock.elapsedRealtime()+25_000
            var lastCancel=SystemClock.elapsedRealtime();var attempts=1;var safeSince=0L
            while(SystemClock.elapsedRealtime()<end) {
                SystemClock.sleep(500)
                events.clear();main{raw.getRouteStateInfo()}
                val current=runCatching{await("state",3).value as? RouteStateInfo}.getOrNull()
                if(current!=null) report.put("cleanupLastMode",current.naviMode.name)
                val now=SystemClock.elapsedRealtime()
                if(current!=null&&!guiding(current)) {
                    if(safeSince==0L) safeSince=now
                    if(now-safeSince>=6_000) {report.put("cleanupStableSeconds",6);return true}
                } else {
                    safeSince=0
                    if(current!=null&&now-lastCancel>=6_000&&attempts<3) {
                        main{raw.cancelRoute()};lastCancel=now;attempts++
                    }
                }
            }
            return false
        }
        if(cancelAndConfirm()) return true
        // Recovery is restricted to this probe's exact two-stop fixture.
        val d=queryDestination();val points=queryWaypoints()
        if(d.poiId!="36khp37hh8gqcm5nqhe5"||d.name!="42dot"||
            points.map{it.name}!=listOf("기존 예제 경유지","두 번째 예제 경유지")) return false
        report.put("cleanupRemovedOwnFixtureWaypoints",true)
        main{raw.removeWaypoint(WaypointIndex.ALL)}
        val end=SystemClock.elapsedRealtime()+15_000
        while(SystemClock.elapsedRealtime()<end) {
            SystemClock.sleep(1000)
            if(runCatching{queryWaypoints().isEmpty()}.getOrDefault(false)) {
                SystemClock.sleep(2500)
                return cancelAndConfirm()
            }
        }
        return false
    }
    fun executeSafety(cleanupOnly:Boolean=false) {
        try {
            check(Build.HARDWARE in listOf("ranchu","goldfish")&&instrumentation.targetContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE!=0){"EMULATOR_ONLY"}
            main{raw=NaviHelper(instrumentation.targetContext);raw.initialize(onConnected={raw.addListener(listener);events.offer(Event("connected"))},onFailed={events.offer(Event("error"))})}
            check(await("connected").kind=="connected"){"CONNECTION_FAILED"}
            if(cleanupOnly) {
                if(!guiding(state())) {report.put("cleanupConfirmed",true);report.put("passed",true);return}
                val destination=queryDestination();val points=queryWaypoints()
                check(destination.poiId=="36khp37hh8gqcm5nqhe5"&&destination.name=="42dot"&&
                    (points.isEmpty()||points.map{it.name}==listOf("기존 예제 경유지","두 번째 예제 경유지"))) {"NOT_OWN_TEST_ROUTE"}
                created=true;report.put("createdExampleBaseline",true);report.put("passed",true);return
            }
            check(!guiding(state())){"EXISTING_USER_ROUTE_NOT_MODIFIED"}
            val results=JSONArray();report.put("cases",results)
            for(count in 0..2){
                stage("safety_existing_waypoints_$count");setup(count)
                val before=VehicleRoute(queryDestination(),queryWaypoints(),state().routeOption.name,System.currentTimeMillis())
                check(before.waypoints.size==count){"BASELINE_WAYPOINT_COUNT"}
                states.clear()
                main{navigator=PleosNavigator(instrumentation.targetContext).also{it.onState=states::offer;it.setInteractionAllowed(true);it.connect()}}
                val initial=navState(NavigationPhase.READY,NavigationPhase.FAILED)
                val readSafe=if(count==0) initial.phase==NavigationPhase.READY&&initial.route?.sameItinerary(before)==true
                    else initial.phase==NavigationPhase.FAILED&&initial.issue==NavigationIssue.INVALID_DESTINATION&&initial.route==null
                states.clear()
                main{navigator!!.request(PickupCandidate("probe","검사 픽업 지점",GeoPoint(37.45,127.06),0,0,CurbStatus.UNKNOWN,"고정 예제"),before)}
                val result=navState(NavigationPhase.CONFIRMED,NavigationPhase.FAILED)
                SystemClock.sleep(1200)
                val after=VehicleRoute(queryDestination(),queryWaypoints(),state().routeOption.name,System.currentTimeMillis())
                val blocked=result.phase==NavigationPhase.FAILED&&result.issue==NavigationIssue.WAYPOINT_UNAVAILABLE&&!result.waypointDispatchAvailable
                val record=JSONObject().put("existingWaypoints",count).put("routeReadSafe",readSafe)
                    .put("dispatchBlocked",blocked).put("originalItineraryPreserved",before.sameItinerary(after))
                    .put("passed",readSafe&&blocked&&before.sameItinerary(after))
                results.put(record);main{navigator?.close();navigator=null}
                check(record.getBoolean("passed")){"CASE_FAILED"}
            }
            report.put("passed",true)
        }catch(e:Exception){report.put("passed",false).put("failure",e.message?.takeIf{it.matches(Regex("[A-Z_]+"))}?:e.javaClass.simpleName)}
        finally{
            main{navigator?.close();navigator=null}
            if(::raw.isInitialized){
                if(created){report.put("cleanupConfirmed",runCatching{cleanup()}.getOrDefault(false))}
                main{runCatching{raw.removeListener(listener);raw.release()}}
            }
            if(created&&report.has("passed")) {
                report.put("checksPassed",report.getBoolean("passed"))
                report.put("passed",report.getBoolean("passed")&&report.optBoolean("cleanupConfirmed",false))
            }
            instrumentation.finish(Activity.RESULT_OK,Bundle().apply{putString("stream",report.toString(2)+"\n")})
        }
    }
    fun executeIdleCheck() {
        try {
            check(Build.HARDWARE in listOf("ranchu","goldfish")&&instrumentation.targetContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE!=0){"EMULATOR_ONLY"}
            main{raw=NaviHelper(instrumentation.targetContext);raw.initialize(onConnected={raw.addListener(listener);events.offer(Event("connected"))},onFailed={events.offer(Event("error"))})}
            check(await("connected").kind=="connected"){"CONNECTION_FAILED"}
            val end=SystemClock.elapsedRealtime()+6_000
            do {
                val current=state();report.put("navigationMode",current.naviMode.name)
                check(!guiding(current)){"NAVIGATION_STILL_ACTIVE"}
                SystemClock.sleep(1000)
            }while(SystemClock.elapsedRealtime()<end)
            report.put("passed",true).put("cleanupConfirmed",true).put("idleStableSeconds",6)
        }catch(e:Exception){report.put("passed",false).put("failure",e.message?.takeIf{it.matches(Regex("[A-Z_]+"))}?:e.javaClass.simpleName)}
        finally {
            if(::raw.isInitialized)main{runCatching{raw.removeListener(listener);raw.release()}}
            if(created&&report.has("passed")) {
                report.put("checksPassed",report.getBoolean("passed"))
                report.put("passed",report.getBoolean("passed")&&report.optBoolean("cleanupConfirmed",false))
            }
            instrumentation.finish(Activity.RESULT_OK,Bundle().apply{putString("stream",report.toString(2)+"\n")})
        }
    }
    fun executeDiagnostic() {
        try {
            check(Build.HARDWARE in listOf("ranchu","goldfish")&&instrumentation.targetContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE!=0){"EMULATOR_ONLY"}
            main{raw=NaviHelper(instrumentation.targetContext);raw.initialize(onConnected={raw.addListener(listener);events.offer(Event("connected"))},onFailed={events.offer(Event("error"))})}
            check(await("connected").kind=="connected"){"CONNECTION_FAILED"}
            check(!guiding(state())){"EXISTING_USER_ROUTE_NOT_MODIFIED"}
            val results=JSONArray();report.put("cases",results)
            for(method in listOf("full", "add")) for(poi in listOf(false,true)) {
                stage("${method}_poi_$poi");setup(0);events.clear()
                val wp=if(poi) RequestWaypointInfo(37.41275833,127.09481944,"판교 현대백화점",WaypointIndex.FIRST,"36khp2hdj2cfcm5nqhe3","경기도 성남시 수정구 창업로 0번길 6","0")
                    else RequestWaypointInfo(37.45,127.06,"검사 픽업 지점",WaypointIndex.FIRST,"","","")
                main{if(method=="add") raw.addWaypoint(wp) else raw.requestRouteWithWaypoints(RouteWithWaypointsRequest(
                    RouteInfo(latitude=37.48544722,longitude=127.03636666,poiName="42dot",poiId="36khp37hh8gqcm5nqhe5",poiSubId="0",address="서울시 강남구 남부순환로 2621"),listOf(wp)))}
                val outcome=await("routed",45);SystemClock.sleep(1500)
                events.clear();main{raw.getWaypointInfo()};val points=(await("waypoints").value as? List<*>)?.filterIsInstance<WaypointInfo>().orEmpty()
                val record=JSONObject().put("method",method).put("withPoi",poi).put("outcome",outcome.kind).put("count",points.size)
                    .put("points",JSONArray(points.map{p->JSONObject().put("zeroCoordinate",p.latitude==0.0&&p.longitude==0.0)
                        .put("offsetMeters",GeoPoint(p.latitude,p.longitude).distanceTo(GeoPoint(wp.latitude,wp.longitude)).toInt())
                        .put("poiMatches",p.poiId==wp.poiId).put("hasDisplayCoordinate",p.displayLatitude!=null&&p.displayLongitude!=null)}))
                results.put(record)
                main{raw.cancelRoute()};var current=state();for(i in 1..10){if(!guiding(current))break;SystemClock.sleep(500);current=state()}
                check(!guiding(current)){"CLEANUP_FAILED"}
            }
        }catch(e:Exception){report.put("failure",e.message?.takeIf{it.matches(Regex("[A-Z_]+"))}?:e.javaClass.simpleName)}
        finally{
            if(::raw.isInitialized){
                if(created){report.put("cleanupConfirmed",runCatching{cleanup()}.getOrDefault(false))}
                main{runCatching{raw.removeListener(listener);raw.release()}}
            }
            if(created&&report.has("passed")) {
                report.put("checksPassed",report.getBoolean("passed"))
                report.put("passed",report.getBoolean("passed")&&report.optBoolean("cleanupConfirmed",false))
            }
            instrumentation.finish(Activity.RESULT_OK,Bundle().apply{putString("stream",report.toString(2)+"\n")})
        }
    }
    fun execute() {
        try {
            check(Build.HARDWARE in listOf("ranchu","goldfish")&&instrumentation.targetContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE!=0){"EMULATOR_ONLY"}
            main{raw=NaviHelper(instrumentation.targetContext);raw.initialize(onConnected={raw.addListener(listener);events.offer(Event("connected"))},onFailed={events.offer(Event("error"))})}
            check(await("connected").kind=="connected"){"CONNECTION_FAILED"}
            check(!guiding(state())){"EXISTING_USER_ROUTE_NOT_MODIFIED"}
            val results=JSONArray();report.put("cases",results)
            for(count in 0..2){
                stage("existing_waypoints_$count");setup(count);states.clear()
                main{navigator=PleosNavigator(instrumentation.targetContext, diagnosticWaypointRequests=true).also{it.onState=states::offer;it.setInteractionAllowed(true);it.connect()}}
                val ready=navState(NavigationPhase.READY,NavigationPhase.FAILED)
                check(ready.phase==NavigationPhase.READY&&ready.route!=null){"CONTEXT_${ready.issue}"}
                val original=ready.route!!;check(original.waypoints.size==count){"BASELINE_WAYPOINT_COUNT"}
                states.clear()
                val candidate=PickupCandidate("probe","검사 픽업 지점",GeoPoint(37.45,127.06),0,0,CurbStatus.UNKNOWN,"고정 예제")
                main{navigator!!.request(candidate,original)}
                val result=navState(NavigationPhase.CONFIRMED,NavigationPhase.FAILED)
                val record=JSONObject().put("existingWaypoints",count).put("phase",result.phase.name).put("issue",result.issue?.name?:JSONObject.NULL)
                if(result.phase==NavigationPhase.FAILED&&count<2){
                    events.clear();main{raw.getDestinationInfo()};val destination=await("destination").value as DestinationInfo
                    events.clear();main{raw.getWaypointInfo()};val points=await("waypoints").value as List<*>
                    record.put("actualDestinationMatches",GeoPoint(destination.latitude,destination.longitude).distanceTo(original.destination.point)<=35)
                        .put("actualWaypointCount",points.size).put("actualWaypointOffsetsMeters",JSONArray(points.map{(it as WaypointInfo).let{p->GeoPoint(p.latitude,p.longitude).distanceTo(candidate.point).toInt()}}))
                        .put("waypointDiagnostics",JSONArray(points.map{(it as WaypointInfo).let{p->JSONObject()
                            .put("zeroCoordinate",p.latitude==0.0&&p.longitude==0.0)
                            .put("hasPoiId",p.poiId.isNotEmpty()).put("hasName",p.name.isNotEmpty())
                            .put("hasDisplayCoordinate",p.displayLatitude!=null&&p.displayLongitude!=null)
                            .put("displayOffsetMeters",if(p.displayLatitude!=null&&p.displayLongitude!=null)
                                runCatching{GeoPoint(p.displayLatitude!!,p.displayLongitude!!).distanceTo(candidate.point).toInt()}.getOrNull()?:-1 else -1)
                        }}))
                }
                if(count<2){
                    val final=result.route
                    record.put("destinationPreserved",final?.destination==original.destination)
                        .put("existingOrderPreserved",final?.waypoints?.drop(1)==original.waypoints)
                        .put("pickupFirst",final?.waypoints?.firstOrNull()?.point?.distanceTo(candidate.point)?.let{it<=35.0}?:false)
                        .put("routeOptionPreserved",final?.routeOption==original.routeOption)
                    record.put("passed",result.phase==NavigationPhase.CONFIRMED&&record.getBoolean("destinationPreserved")&&record.getBoolean("existingOrderPreserved")&&record.getBoolean("pickupFirst")&&record.getBoolean("routeOptionPreserved"))
                }else{
                    events.clear();main{raw.getWaypointInfo()};val after=await("waypoints").value as List<*>
                    record.put("passed",result.phase==NavigationPhase.FAILED&&result.issue==NavigationIssue.WAYPOINT_LIMIT&&after.size==2)
                }
                results.put(record)
                main{navigator?.close();navigator=null}
                check(record.getBoolean("passed")){"CASE_FAILED"}
            }
            report.put("passed",true)
        }catch(e:Exception){report.put("passed",false).put("failure",e.message?.takeIf{it.matches(Regex("[A-Z_]+"))}?:e.javaClass.simpleName)}
        finally{
            main{navigator?.close();navigator=null}
            if(::raw.isInitialized){
                if(created){report.put("cleanupConfirmed",runCatching{cleanup()}.getOrDefault(false))}
                main{runCatching{raw.removeListener(listener);raw.release()}}
            }
            if(created&&report.has("passed")) {
                report.put("checksPassed",report.getBoolean("passed"))
                report.put("passed",report.getBoolean("passed")&&report.optBoolean("cleanupConfirmed",false))
            }
            instrumentation.finish(Activity.RESULT_OK,Bundle().apply{putString("stream",report.toString(2)+"\n")})
        }
    }
}
